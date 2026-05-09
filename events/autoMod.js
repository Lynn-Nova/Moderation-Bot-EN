/**
 * @file autoMod.js
 * @description Autonomous message moderation engine for the Discord bot.
 *
 * ─── Overview ────────────────────────────────────────────────────────────────
 * This module attaches a `messageCreate` listener that inspects every incoming
 * message against two independent rule sets:
 *
 *   1. Banned-word filter — substring match against a configurable word list.
 *   2. Spam detector     — sliding-window rate limiter per (guild, user) pair.
 *
 * When a rule fires, a configurable action is executed:
 *   "delete"  → remove the offending message only.
 *   "warn"    → delete + append a warning to the user's GuildUser record.
 *   "timeout" → delete + apply a Discord communication timeout.
 *   "kick"    → delete + kick the member from the guild.
 *   "ban"     → delete + permanently ban the member.
 *
 * All violations are optionally posted to a designated log channel.
 *
 * ─── Architecture ────────────────────────────────────────────────────────────
 * The module exports a single `registerAutoMod(client)` function that wires
 * the listener and initialises the in-memory state. Nothing here is a command;
 * it is purely event-driven infrastructure.
 *
 * In-memory structures (reset on process restart, intentionally):
 *   spamTracker  — Map<`${guildId}:${userId}`, number[]>
 *                  Stores the Unix timestamps (ms) of recent messages.
 *                  Entries older than `spamWindowMs` are pruned on every check.
 *   configCache  — Map<guildId, GuildConfig document>
 *                  Avoids a DB round-trip on every message. Invalidated when
 *                  the `/automod` command updates the config.
 *
 * ─── Performance considerations ──────────────────────────────────────────────
 * messageCreate fires for every message in every channel. The handler exits
 * as early as possible:
 *   • Skip bots (first check, cheapest).
 *   • Skip DMs — AutoMod only applies inside guilds.
 *   • Config cache miss → one DB read, then cached.
 *   • If AutoMod is disabled → return immediately after cache lookup.
 *   • Role exemption check uses Set.has() after converting the array once.
 */

const { EmbedBuilder, PermissionFlagsBits } = require("discord.js")
const GuildConfig = require("../models/GuildConfig")
const GuildUser = require("../models/GuildUser")

// ─── In-memory state ──────────────────────────────────────────────────────────

/**
 * Sliding-window spam tracker.
 *
 * Key  : `${guildId}:${userId}`
 * Value: sorted array of message timestamps (ms since epoch)
 *
 * Why in-memory and not in MongoDB?
 * Spam windows are typically 3–10 seconds. Writing and reading sub-second
 * timestamps from a remote DB for every message would add latency that exceeds
 * the window itself. In-memory is the correct layer for ephemeral rate-limiting.
 */
const spamTracker = new Map()

/**
 * Per-guild config cache.
 *
 * Key  : guildId string
 * Value: GuildConfig Mongoose document
 *
 * The cache is populated on the first message from a guild and updated
 * whenever the `/automod` command modifies settings. This means config
 * changes are reflected on the very next message after the command runs.
 */
const configCache = new Map()

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Exposes the config cache so external commands (e.g., /automod config)
 * can invalidate a specific guild's entry after saving new settings.
 *
 * Usage: `autoMod.invalidateCache(guildId)`
 */
const autoMod = {
	/**
	 * Removes a guild's cached config, forcing a DB re-read on the next message.
	 *
	 * Must be called by any command that mutates GuildConfig to prevent stale
	 * settings from persisting in memory after a save.
	 *
	 * @param {string} guildId
	 */
	invalidateCache(guildId) {
		configCache.delete(guildId)
	},

	/**
	 * Registers the `messageCreate` listener on the Discord client.
	 *
	 * This should be called once during bootstrap, after the client is created
	 * but before `client.login()`. Calling it multiple times would register
	 * duplicate listeners — guard against that in the caller.
	 *
	 * @param {import('discord.js').Client} client
	 */
	register(client) {
		client.on("messageCreate", message => handleMessage(message).catch(err =>
			console.error("[AutoMod] Unhandled error in message handler:", err),
		))

		console.log("[AutoMod] messageCreate listener registered.")
	},
}

module.exports = autoMod

// ─── Core handler ─────────────────────────────────────────────────────────────

/**
 * Primary message inspection pipeline.
 *
 * Execution order is intentional — cheapest checks first to minimise
 * unnecessary work on the hot path.
 *
 * @param {import('discord.js').Message} message
 */
async function handleMessage(message) {
	// ── Guard: ignore bot messages ────────────────────────────────────────────
	// Processing our own messages or other bots' messages is never useful and
	// would create feedback loops if the bot is also logging to a channel.
	if (message.author.bot) return

	// ── Guard: ignore DMs ─────────────────────────────────────────────────────
	// AutoMod is a guild-scoped feature. DM channels have no guild, no roles,
	// and no moderation actions — nothing to do here.
	if (!message.guild) return

	// ── Config resolution (with cache) ────────────────────────────────────────
	const config = await resolveConfig(message.guild.id)

	// ── Guard: AutoMod disabled ───────────────────────────────────────────────
	// Single boolean check after the cache lookup — essentially free.
	if (!config.autoMod.enabled) return

	// ── Guard: member is exempt ───────────────────────────────────────────────
	// Converts the exemptRoleIds array to a Set once per check for O(1) lookups.
	// Moderators, admins, and trusted roles can be whitelisted here.
	const exemptSet = new Set(config.autoMod.exemptRoleIds)
	const memberRoles = message.member?.roles?.cache

	if (memberRoles && [...memberRoles.keys()].some(id => exemptSet.has(id))) {
		return // Member holds an exempt role — skip all checks
	}

	// ── Rule 1: Banned-word filter ────────────────────────────────────────────
	const lowerContent = message.content.toLowerCase()
	const matchedWord = config.autoMod.bannedWords.find(word =>
		lowerContent.includes(word.toLowerCase()),
	)

	if (matchedWord) {
		await handleViolation(message, config, {
			rule: "banned_word",
			detail: `Matched banned phrase: \`${matchedWord}\``,
		})
		return // One violation per message is enough — skip spam check
	}

	// ── Rule 2: Spam detector ─────────────────────────────────────────────────
	// Only runs if the banned-word rule did not already fire (early return above).
	if (config.autoMod.maxMessagesPerWindow > 0) {
		const isSpamming = recordAndCheckSpam(
			message.guild.id,
			message.author.id,
			config.autoMod.maxMessagesPerWindow,
			config.autoMod.spamWindowMs,
		)

		if (isSpamming) {
			await handleViolation(message, config, {
				rule: "spam",
				detail: `Exceeded ${config.autoMod.maxMessagesPerWindow} messages in ${config.autoMod.spamWindowMs / 1_000}s`,
			})
		}
	}
}

// ─── Config cache ─────────────────────────────────────────────────────────────

/**
 * Returns the GuildConfig for a guild, using the in-memory cache to avoid
 * redundant database reads on every message.
 *
 * Cache miss flow:
 *   1. Call GuildConfig.getOrCreate(guildId) — upserts with defaults if absent.
 *   2. Store result in configCache.
 *   3. Return the document.
 *
 * Cache hit flow:
 *   1. Return configCache.get(guildId) immediately.
 *
 * @param {string} guildId
 * @returns {Promise<import('mongoose').Document>}
 */
async function resolveConfig(guildId) {
	if (configCache.has(guildId)) {
		return configCache.get(guildId)
	}

	const config = await GuildConfig.getOrCreate(guildId)
	configCache.set(guildId, config)
	return config
}

// ─── Spam detection ───────────────────────────────────────────────────────────

/**
 * Records a message timestamp and checks whether the user has exceeded the
 * rate limit within the rolling window.
 *
 * Algorithm: sliding-window counter
 *   - Append current timestamp to the user's list.
 *   - Prune entries older than `windowMs` from the front of the array.
 *   - If remaining entries >= limit → spam detected.
 *
 * Why splice from the front?
 * Timestamps are always appended in chronological order, so the oldest entries
 * are always at index 0. splice(0, n) removes the stale prefix in O(n) where
 * n is the number of expired entries — typically 0 or 1.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {number} limit        Maximum allowed messages per window
 * @param {number} windowMs     Rolling window size in milliseconds
 * @returns {boolean}           True if the user has exceeded the limit
 */
function recordAndCheckSpam(guildId, userId, limit, windowMs) {
	const key = `${guildId}:${userId}`
	const now = Date.now()
	const cutoff = now - windowMs

	// Initialise entry if this is the user's first message in this session
	if (!spamTracker.has(key)) {
		spamTracker.set(key, [])
	}

	const timestamps = spamTracker.get(key)

	// Prune expired timestamps (sliding window maintenance)
	let expiredCount = 0
	while (expiredCount < timestamps.length && timestamps[expiredCount] < cutoff) {
		expiredCount++
	}

	if (expiredCount > 0) {
		timestamps.splice(0, expiredCount)
	}

	// Record current message
	timestamps.push(now)

	// Evaluate against limit
	return timestamps.length >= limit
}

// ─── Violation handler ────────────────────────────────────────────────────────

/**
 * Executes the configured moderation action for a detected violation.
 *
 * Execution order:
 *   1. Delete the offending message (always, on all action types).
 *   2. Execute the punitive action (warn / timeout / kick / ban).
 *   3. Post to log channel (if configured).
 *
 * Why delete first?
 * Removing the message immediately reduces exposure time for harmful content
 * regardless of whether the subsequent action (e.g., ban) succeeds.
 *
 * Error containment:
 * Each step is wrapped independently. A failed DM or log post must not
 * prevent the punitive action from being applied.
 *
 * @param {import('discord.js').Message} message
 * @param {import('mongoose').Document} config  GuildConfig document
 * @param {{ rule: string, detail: string }} violation  Metadata for logging
 */
async function handleViolation(message, config, violation) {
	const { guild, member, author, channel } = message
	const { action, timeoutDurationMinutes, logChannelId } = config.autoMod

	// ── Step 1: Delete the offending message ──────────────────────────────────
	await message.delete().catch(err =>
		console.warn("[AutoMod] Could not delete message:", err.message),
	)

	// ── Step 2: Apply punitive action ─────────────────────────────────────────
	// Each branch is explicit and self-contained for clarity and testability.
	// "delete" is handled implicitly — message is already deleted above.

	const reason = `[AutoMod] ${violation.detail}`

	if (action === "warn") {
		// Persist warning to the user's moderation record.
		// getOrCreate ensures a record exists even for first-time offenders.
		const userRecord = await GuildUser.getOrCreate(guild.id, author.id)
		await userRecord.addWarning(guild.client?.user?.id ?? "automod", reason)
	}


	if (action === "mute") {
		// Apply the configured mute role to the member.
		// The role was created by /automod-setup with channel-level permission
		// overrides denying SendMessages — no additional overrides needed here.
		const muteRoleId = config.autoMod.muteRoleId
		if (muteRoleId && member?.manageable) {
			await member.roles.add(muteRoleId, reason).catch(err =>
				console.warn("[AutoMod] Mute role assignment failed:", err.message),
			)
		}
	}

	if (action === "timeout") {
		const durationMs = timeoutDurationMinutes * 60 * 1_000

		// manageable check: prevents errors when the bot lacks hierarchy over the target.
		if (member?.manageable) {
			await member.timeout(durationMs, reason).catch(err =>
				console.warn("[AutoMod] Timeout failed:", err.message),
			)
		}
	}

	if (action === "kick") {
		if (member?.kickable) {
			await member.kick(reason).catch(err =>
				console.warn("[AutoMod] Kick failed:", err.message),
			)
		}
	}

	if (action === "ban") {
		if (member?.bannable) {
			await guild.members.ban(author.id, { reason }).catch(err =>
				console.warn("[AutoMod] Ban failed:", err.message),
			)
		}
	}

	// ── Step 3: Notify the user via DM (best-effort) ──────────────────────────
	// DMs are disabled by many users — failure here is expected and non-critical.
	author
		.send(
			`🚨 Your message in **${guild.name}** was removed by AutoMod.\n**Reason:** ${violation.detail}`,
		)
		.catch(() => null)

	// ── Step 4: Post to log channel ───────────────────────────────────────────
	if (logChannelId) {
		await postViolationLog(guild, logChannelId, {
			author,
			channel,
			violation,
			action,
		}).catch(err =>
			console.warn("[AutoMod] Log post failed:", err.message),
		)
	}
}

// ─── Log channel helper ───────────────────────────────────────────────────────

/**
 * Constructs and sends a structured embed to the configured log channel.
 *
 * Resolves the channel from the guild's channel cache to avoid an API call.
 * If the channel is not cached (e.g., bot restarted without receiving a
 * message in that channel), it falls back to a REST fetch.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} logChannelId
 * @param {{ author, channel, violation, action }} payload
 */
async function postViolationLog(guild, logChannelId, { author, channel, violation, action }) {
	const logChannel =
		guild.channels.cache.get(logChannelId) ??
		(await guild.channels.fetch(logChannelId).catch(() => null))

	if (!logChannel?.isTextBased()) return

	const logEmbed = new EmbedBuilder()
		.setTitle("🚨 AutoMod Violation")
		.setColor("Red")
		.addFields(
			{ name: "User", value: `${author.tag} (${author.id})`, inline: true },
			{ name: "Channel", value: `${channel}`, inline: true },
			{ name: "Rule triggered", value: violation.rule, inline: true },
			{ name: "Detail", value: violation.detail },
			{ name: "Action taken", value: action.toUpperCase(), inline: true },
		)
		.setTimestamp()
		.setFooter({ text: "AutoMod" })

	await logChannel.send({ embeds: [logEmbed] })
}
