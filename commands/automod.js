/**
 * @file automod.js
 * @description Slash command for configuring the AutoMod system per guild.
 *
 * ─── Overview ────────────────────────────────────────────────────────────────
 * Provides administrators with a self-contained interface to manage all
 * AutoMod settings without touching environment variables or redeploying.
 *
 * Subcommands:
 *   status          — Display the current AutoMod configuration.
 *   toggle          — Enable or disable AutoMod entirely.
 *   set-action      — Choose the punitive action (warn / timeout / kick / ban).
 *   add-word        — Append a phrase to the banned-word list.
 *   remove-word     — Remove a phrase from the banned-word list.
 *   set-log-channel — Designate a channel for violation logs.
 *   set-spam-limit  — Configure the spam threshold and detection window.
 *   exempt-role     — Add or remove a role from the AutoMod exemption list.
 *
 * ─── Config invalidation ─────────────────────────────────────────────────────
 * Every subcommand that mutates GuildConfig must call
 * `autoMod.invalidateCache(guildId)` after saving. This ensures the AutoMod
 * messageCreate handler picks up the new settings on the very next message
 * rather than serving stale cached values.
 *
 * ─── Permission model ────────────────────────────────────────────────────────
 * Restricted to Administrator to prevent non-admin moderators from altering
 * automated enforcement rules that affect everyone in the guild.
 */

const {
	EmbedBuilder,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require("discord.js")
const GuildConfig = require("../models/GuildConfig")
const autoMod = require("../events/autoMod")

module.exports = {
	data: new SlashCommandBuilder()
		.setName("automod")
		.setDescription("Configure the AutoMod system for this server.")
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

		// ── status ────────────────────────────────────────────────────────────
		.addSubcommand(sub =>
			sub
				.setName("status")
				.setDescription("Show the current AutoMod configuration."),
		)

		// ── toggle ────────────────────────────────────────────────────────────
		.addSubcommand(sub =>
			sub
				.setName("toggle")
				.setDescription("Enable or disable AutoMod.")
				.addBooleanOption(opt =>
					opt
						.setName("enabled")
						.setDescription("True to enable, false to disable.")
						.setRequired(true),
				),
		)

		// ── set-action ────────────────────────────────────────────────────────
		.addSubcommand(sub =>
			sub
				.setName("set-action")
				.setDescription("Set the action AutoMod takes on a violation.")
				.addStringOption(opt =>
					opt
						.setName("action")
						.setDescription("Action to apply.")
						.setRequired(true)
						.addChoices(
							{ name: "Delete only", value: "delete" },
							{ name: "Warn", value: "warn" },
							{ name: "Timeout", value: "timeout" },
							{ name: "Kick", value: "kick" },
							{ name: "Ban", value: "ban" },
						),
				)
				.addIntegerOption(opt =>
					opt
						.setName("timeout-minutes")
						.setDescription("Timeout duration (only used when action is 'timeout').")
						.setMinValue(1)
						.setMaxValue(40_320),
				),
		)

		// ── add-word ──────────────────────────────────────────────────────────
		.addSubcommand(sub =>
			sub
				.setName("add-word")
				.setDescription("Add a phrase to the banned-word list.")
				.addStringOption(opt =>
					opt
						.setName("phrase")
						.setDescription("Phrase to ban (case-insensitive).")
						.setRequired(true),
				),
		)

		// ── remove-word ───────────────────────────────────────────────────────
		.addSubcommand(sub =>
			sub
				.setName("remove-word")
				.setDescription("Remove a phrase from the banned-word list.")
				.addStringOption(opt =>
					opt
						.setName("phrase")
						.setDescription("Exact phrase to remove.")
						.setRequired(true),
				),
		)

		// ── set-log-channel ───────────────────────────────────────────────────
		.addSubcommand(sub =>
			sub
				.setName("set-log-channel")
				.setDescription("Set the channel where AutoMod violations are logged.")
				.addChannelOption(opt =>
					opt
						.setName("channel")
						.setDescription("Target text channel.")
						.setRequired(true),
				),
		)

		// ── set-spam-limit ────────────────────────────────────────────────────
		.addSubcommand(sub =>
			sub
				.setName("set-spam-limit")
				.setDescription("Configure the spam detection threshold.")
				.addIntegerOption(opt =>
					opt
						.setName("max-messages")
						.setDescription("Max messages allowed per window (0 = disabled).")
						.setRequired(true)
						.setMinValue(0)
						.setMaxValue(100),
				)
				.addIntegerOption(opt =>
					opt
						.setName("window-seconds")
						.setDescription("Rolling window size in seconds (default: 5).")
						.setMinValue(1)
						.setMaxValue(60),
				),
		)

		// ── exempt-role ───────────────────────────────────────────────────────
		.addSubcommand(sub =>
			sub
				.setName("exempt-role")
				.setDescription("Add or remove a role from the AutoMod exemption list.")
				.addRoleOption(opt =>
					opt
						.setName("role")
						.setDescription("Role to add or remove.")
						.setRequired(true),
				)
				.addStringOption(opt =>
					opt
						.setName("operation")
						.setDescription("Add or remove the role from exemptions.")
						.setRequired(true)
						.addChoices(
							{ name: "Add", value: "add" },
							{ name: "Remove", value: "remove" },
						),
				),
		),

	/**
	 * Executes the appropriate subcommand handler.
	 *
	 * All mutations follow the same pattern:
	 *   1. Load config (getOrCreate).
	 *   2. Mutate the relevant field(s).
	 *   3. Save to MongoDB.
	 *   4. Invalidate the in-memory cache (critical — see module docblock).
	 *   5. Reply with confirmation.
	 *
	 * @param {import('discord.js').ChatInputCommandInteraction} interaction
	 */
	async execute(interaction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral })

		const subcommand = interaction.options.getSubcommand()
		const guildId = interaction.guild.id
		const config = await GuildConfig.getOrCreate(guildId)

		try {
			switch (subcommand) {
				case "status":
					return await handleStatus(interaction, config)

				case "toggle":
					return await handleToggle(interaction, config, guildId)

				case "set-action":
					return await handleSetAction(interaction, config, guildId)

				case "add-word":
					return await handleAddWord(interaction, config, guildId)

				case "remove-word":
					return await handleRemoveWord(interaction, config, guildId)

				case "set-log-channel":
					return await handleSetLogChannel(interaction, config, guildId)

				case "set-spam-limit":
					return await handleSetSpamLimit(interaction, config, guildId)

				case "exempt-role":
					return await handleExemptRole(interaction, config, guildId)

				default:
					return interaction.editReply({ content: "Unknown subcommand." })
			}
		} catch (error) {
			console.error("[/automod] Command error:", error)
			return interaction.editReply({
				content: "An error occurred while updating the AutoMod configuration.",
			})
		}
	},
}

// ─── Subcommand handlers ──────────────────────────────────────────────────────

/**
 * Displays the current AutoMod configuration as a rich embed.
 *
 * Uses a READ-ONLY path — no mutation, no cache invalidation needed.
 */
async function handleStatus(interaction, config) {
	const { autoMod: am } = config

	const embed = new EmbedBuilder()
		.setTitle("⚙️ AutoMod Configuration")
		.setColor(am.enabled ? "Green" : "Grey")
		.addFields(
			{
				name: "Status",
				value: am.enabled ? "✅ Enabled" : "❌ Disabled",
				inline: true,
			},
			{
				name: "Action",
				value: am.action.toUpperCase(),
				inline: true,
			},
			{
				name: "Timeout Duration",
				value: `${am.timeoutDurationMinutes} min`,
				inline: true,
			},
			{
				name: "Banned Words",
				value:
					am.bannedWords.length > 0
						? am.bannedWords.map(w => `\`${w}\``).join(", ")
						: "None configured",
			},
			{
				name: "Spam Limit",
				value:
					am.maxMessagesPerWindow > 0
						? `${am.maxMessagesPerWindow} messages / ${am.spamWindowMs / 1_000}s`
						: "Disabled",
				inline: true,
			},
			{
				name: "Log Channel",
				value: am.logChannelId ? `<#${am.logChannelId}>` : "Not set",
				inline: true,
			},
			{
				name: "Exempt Roles",
				value:
					am.exemptRoleIds.length > 0
						? am.exemptRoleIds.map(id => `<@&${id}>`).join(", ")
						: "None",
			},
		)
		.setTimestamp()

	return interaction.editReply({ embeds: [embed] })
}

/**
 * Toggles AutoMod on or off for the guild.
 *
 * After saving, the config cache is invalidated so the messageCreate handler
 * immediately reflects the new enabled state.
 */
async function handleToggle(interaction, config, guildId) {
	const enabled = interaction.options.getBoolean("enabled")

	config.autoMod.enabled = enabled
	await config.save()
	autoMod.invalidateCache(guildId)

	return interaction.editReply({
		content: `AutoMod has been **${enabled ? "enabled ✅" : "disabled ❌"}**.`,
	})
}

/**
 * Updates the punitive action and optionally the timeout duration.
 */
async function handleSetAction(interaction, config, guildId) {
	const action = interaction.options.getString("action")
	const timeoutMinutes = interaction.options.getInteger("timeout-minutes")

	config.autoMod.action = action

	if (action === "timeout" && timeoutMinutes !== null) {
		config.autoMod.timeoutDurationMinutes = timeoutMinutes
	}

	await config.save()
	autoMod.invalidateCache(guildId)

	const durationNote =
		action === "timeout"
			? ` (${config.autoMod.timeoutDurationMinutes} min timeout)`
			: ""

	return interaction.editReply({
		content: `AutoMod action set to **${action.toUpperCase()}**${durationNote}.`,
	})
}

/**
 * Adds a phrase to the banned-word list.
 *
 * Duplicate check prevents the same phrase from appearing multiple times,
 * which would waste comparison cycles on every message.
 */
async function handleAddWord(interaction, config, guildId) {
	const phrase = interaction.options.getString("phrase").toLowerCase().trim()

	if (config.autoMod.bannedWords.includes(phrase)) {
		return interaction.editReply({
			content: `\`${phrase}\` is already in the banned-word list.`,
		})
	}

	config.autoMod.bannedWords.push(phrase)
	await config.save()
	autoMod.invalidateCache(guildId)

	return interaction.editReply({
		content: `✅ \`${phrase}\` has been added to the banned-word list.`,
	})
}

/**
 * Removes a phrase from the banned-word list.
 */
async function handleRemoveWord(interaction, config, guildId) {
	const phrase = interaction.options.getString("phrase").toLowerCase().trim()
	const index = config.autoMod.bannedWords.indexOf(phrase)

	if (index === -1) {
		return interaction.editReply({
			content: `\`${phrase}\` was not found in the banned-word list.`,
		})
	}

	config.autoMod.bannedWords.splice(index, 1)
	await config.save()
	autoMod.invalidateCache(guildId)

	return interaction.editReply({
		content: `✅ \`${phrase}\` has been removed from the banned-word list.`,
	})
}

/**
 * Sets the channel where AutoMod violation logs are posted.
 *
 * Channel is stored by ID (not mention string) to ensure persistence
 * even if the channel is renamed.
 */
async function handleSetLogChannel(interaction, config, guildId) {
	const channel = interaction.options.getChannel("channel")

	if (!channel.isTextBased()) {
		return interaction.editReply({
			content: "Log channel must be a text-based channel.",
		})
	}

	config.autoMod.logChannelId = channel.id
	await config.save()
	autoMod.invalidateCache(guildId)

	return interaction.editReply({
		content: `✅ AutoMod violation logs will now be posted in ${channel}.`,
	})
}

/**
 * Updates the spam detection threshold.
 *
 * Note: in-memory spamTracker entries are NOT cleared on config change.
 * The new threshold takes effect on the next timestamp evaluation for each user.
 */
async function handleSetSpamLimit(interaction, config, guildId) {
	const maxMessages = interaction.options.getInteger("max-messages")
	const windowSeconds = interaction.options.getInteger("window-seconds")

	config.autoMod.maxMessagesPerWindow = maxMessages

	if (windowSeconds !== null) {
		config.autoMod.spamWindowMs = windowSeconds * 1_000
	}

	await config.save()
	autoMod.invalidateCache(guildId)

	if (maxMessages === 0) {
		return interaction.editReply({ content: "✅ Spam detection has been disabled." })
	}

	return interaction.editReply({
		content: `✅ Spam limit set to **${maxMessages} messages** per **${config.autoMod.spamWindowMs / 1_000}s**.`,
	})
}

/**
 * Adds or removes a role from the AutoMod exemption list.
 *
 * Members holding any exempt role bypass all AutoMod checks. Typically used
 * for moderator roles, verified bot accounts, or trusted community roles.
 */
async function handleExemptRole(interaction, config, guildId) {
	const role = interaction.options.getRole("role")
	const operation = interaction.options.getString("operation")

	if (operation === "add") {
		if (config.autoMod.exemptRoleIds.includes(role.id)) {
			return interaction.editReply({
				content: `${role} is already exempt from AutoMod.`,
			})
		}

		config.autoMod.exemptRoleIds.push(role.id)
		await config.save()
		autoMod.invalidateCache(guildId)

		return interaction.editReply({
			content: `✅ ${role} is now exempt from AutoMod checks.`,
		})
	}

	// operation === "remove"
	const index = config.autoMod.exemptRoleIds.indexOf(role.id)

	if (index === -1) {
		return interaction.editReply({
			content: `${role} is not currently in the exemption list.`,
		})
	}

	config.autoMod.exemptRoleIds.splice(index, 1)
	await config.save()
	autoMod.invalidateCache(guildId)

	return interaction.editReply({
		content: `✅ ${role} has been removed from AutoMod exemptions.`,
	})
}
