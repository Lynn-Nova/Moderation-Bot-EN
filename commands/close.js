/**
 * @file close.js
 * @description Closes a ticket channel, generates a transcript, and posts it to the log channel.
 *
 * ─── Overview ────────────────────────────────────────────────────────────────
 * When a ticket is closed, this command:
 *   1. Validates the channel is a legitimate ticket.
 *   2. Checks authorization (ticket owner or moderator).
 *   3. Collects the full message history from the channel.
 *   4. Generates a formatted .txt transcript file.
 *   5. Posts the transcript as an attachment to the configured log channel.
 *   6. Clears the ticket state in MongoDB.
 *   7. Deletes the channel after a 5-second grace period.
 *
 * ─── Transcript format ────────────────────────────────────────────────────────
 * Plain text — chosen for universality (no special software needed to open it).
 *
 * Format per message:
 *   [YYYY-MM-DD HH:MM:SS] Username#0000 (ID): Message content
 *   [Attachment: filename.ext — https://cdn...]
 *
 * ─── Message fetching ────────────────────────────────────────────────────────
 * Discord's API returns at most 100 messages per request. To collect the full
 * history, we use a pagination loop:
 *   - Fetch 100 messages before the oldest message we have.
 *   - Repeat until fewer than 100 messages are returned (end of history).
 *   - Reverse the final array to restore chronological order.
 *
 * This is the standard "batch fetch" pattern for Discord message history.
 *
 * ─── Log channel resolution ───────────────────────────────────────────────────
 * The log channel is read from GuildConfig.ticketPanel.logChannelId.
 * If not configured, the transcript is still generated but sent as a
 * DM to the moderator who ran /close instead.
 */

const {
	AttachmentBuilder,
	EmbedBuilder,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require("discord.js")
const GuildConfig = require("../models/GuildConfig")
const GuildUser = require("../models/GuildUser")

module.exports = {
	data: new SlashCommandBuilder()
		.setName("close")
		.setDescription("Close the current ticket and save a transcript."),

	/**
	 * @param {import('discord.js').ChatInputCommandInteraction} interaction
	 */
	async execute(interaction) {
		const { channel, guild, member, user } = interaction

		await interaction.deferReply()

		try {
			// ── Step 1: Resolve ticket record ─────────────────────────────────
			const ticketOwnerRecord = await GuildUser.findOne({
				guildId: guild.id,
				ticketChannelId: channel.id,
				activateTicket: true,
			})

			if (!ticketOwnerRecord && !channel.name?.startsWith("ticket-")) {
				return interaction.editReply({
					content: "This channel is not recognized as a ticket.",
				})
			}

			// ── Step 2: Authorization ─────────────────────────────────────────
			const isOwner = ticketOwnerRecord?.userId === user.id
			const isModerator = member.permissions.has(PermissionFlagsBits.ManageChannels)

			if (!ticketOwnerRecord && !isModerator) {
				return interaction.editReply({
					content: "Only moderators can close unregistered ticket channels.",
				})
			}

			if (ticketOwnerRecord && !isOwner && !isModerator) {
				return interaction.editReply({
					content: "You do not have permission to close this ticket.",
				})
			}

			// ── Step 3: Collect message history ───────────────────────────────
			await interaction.editReply({
				content: "🔒 Closing ticket — collecting transcript...",
			})

			const allMessages = await fetchAllMessages(channel)

			// ── Step 4: Generate transcript file ──────────────────────────────
			const transcriptText = buildTranscriptText(channel, guild, allMessages)
			const fileName = `transcript-${channel.name}-${Date.now()}.txt`

			const attachment = new AttachmentBuilder(Buffer.from(transcriptText, "utf-8"), {
				name: fileName,
				description: `Ticket transcript for ${channel.name}`,
			})

			// ── Step 5: Post transcript to log channel ────────────────────────
			const config = await GuildConfig.getOrCreate(guild.id)
			const logChannelId = config.ticketPanel?.logChannelId

			if (logChannelId) {
				const logChannel =
					guild.channels.cache.get(logChannelId) ??
					(await guild.channels.fetch(logChannelId).catch(() => null))

				if (logChannel?.isTextBased()) {
					const logEmbed = buildLogEmbed(channel, user, ticketOwnerRecord, allMessages.length)

					await logChannel.send({
						embeds: [logEmbed],
						files: [attachment],
					})
				}
			} else {
				// Fallback: DM the transcript to the moderator who closed the ticket
				await user.send({
					content: `📋 No log channel configured — here is the transcript for **${channel.name}**:`,
					files: [attachment],
				}).catch(() => null)
			}

			// ── Step 6: Clear database state ──────────────────────────────────
			if (ticketOwnerRecord) {
				await ticketOwnerRecord.clearActiveTicket()
			}

			// ── Step 7: Delete channel after grace period ─────────────────────
			await interaction.editReply({
				content: "✅ Transcript saved. This channel will be deleted in 5 seconds...",
			})

			setTimeout(async () => {
				await channel.delete().catch(err =>
					console.error("[/close] Channel deletion failed:", err),
				)
			}, 5_000)
		} catch (error) {
			console.error("[/close] Command error:", error)

			const payload = { content: "An error occurred while closing the ticket." }

			if (interaction.replied || interaction.deferred) {
				return interaction.editReply(payload).catch(() => null)
			}

			return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null)
		}
	},
}

// ─── Message fetcher ──────────────────────────────────────────────────────────

/**
 * Fetches the complete message history of a channel using batch pagination.
 *
 * Discord's messages.fetch() limit is 100 per call. To retrieve all messages:
 *   1. Fetch the 100 most recent messages.
 *   2. Record the ID of the oldest message in that batch (last in the array).
 *   3. Fetch the next 100 messages BEFORE that ID.
 *   4. Repeat until a batch returns fewer than 100 messages (end of history).
 *   5. Reverse the final array to restore chronological (oldest-first) order.
 *
 * Why reverse at the end?
 * Each fetch returns messages newest-first. Prepending batches to a list
 * maintains newest-first order throughout. A single reverse at the end
 * is O(n) and avoids repeated array reconstruction mid-loop.
 *
 * @param {import('discord.js').TextChannel} channel
 * @returns {Promise<import('discord.js').Message[]>}
 */
async function fetchAllMessages(channel) {
	const messages = []
	let lastMessageId = null

	while (true) {
		const options = { limit: 100 }
		if (lastMessageId) options.before = lastMessageId

		const batch = await channel.messages.fetch(options)

		if (batch.size === 0) break

		messages.push(...batch.values())
		lastMessageId = batch.last()?.id

		// Fewer than 100 messages means we've reached the beginning of history
		if (batch.size < 100) break
	}

	// Restore chronological (oldest-first) order
	return messages.reverse()
}

// ─── Transcript builder ───────────────────────────────────────────────────────

/**
 * Generates a plain-text transcript from the collected messages.
 *
 * Format:
 *   === TICKET TRANSCRIPT ===
 *   Channel : ticket-username
 *   Server  : My Discord Server
 *   Opened  : 2024-01-15
 *   Closed  : 2024-01-15 by Moderator#0000
 *   Messages: 42
 *   ========================
 *
 *   [2024-01-15 14:32:01] User#1234 (123456789): Hello!
 *   [2024-01-15 14:32:10] Moderator#0000 (987654321): How can I help?
 *   [Attachment: screenshot.png — https://cdn.discordapp.com/...]
 *
 * Rationale for plain text:
 *   - No special software required to open
 *   - Easy to search with Ctrl+F
 *   - Small file size
 *   - Git-friendly if stored in a repository
 *
 * @param {import('discord.js').TextChannel} channel
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').Message[]} messages
 * @returns {string}
 */
function buildTranscriptText(channel, guild, messages) {
	const now = new Date()
	const lines = []

	// ── Header ────────────────────────────────────────────────────────────────
	lines.push("=".repeat(60))
	lines.push("TICKET TRANSCRIPT")
	lines.push("=".repeat(60))
	lines.push(`Channel  : ${channel.name}`)
	lines.push(`Server   : ${guild.name} (${guild.id})`)
	lines.push(`Generated: ${formatTimestamp(now)}`)
	lines.push(`Messages : ${messages.length}`)
	lines.push("=".repeat(60))
	lines.push("")

	// ── Messages ──────────────────────────────────────────────────────────────
	for (const msg of messages) {
		const timestamp = formatTimestamp(msg.createdAt)
		const author = `${msg.author.username} (${msg.author.id})`

		// Message content (may be empty if message is attachment-only)
		if (msg.content) {
			lines.push(`[${timestamp}] ${author}: ${msg.content}`)
		}

		// Attachments (images, files, etc.)
		for (const attachment of msg.attachments.values()) {
			lines.push(`[${timestamp}] ${author} [Attachment: ${attachment.name} — ${attachment.url}]`)
		}

		// Embeds (note presence but don't try to serialize — too complex)
		if (msg.embeds.length > 0 && !msg.content && msg.attachments.size === 0) {
			lines.push(`[${timestamp}] ${author} [Embed: ${msg.embeds[0]?.title ?? "untitled"}]`)
		}
	}

	lines.push("")
	lines.push("=".repeat(60))
	lines.push("END OF TRANSCRIPT")
	lines.push("=".repeat(60))

	return lines.join("\n")
}

// ─── Log embed builder ────────────────────────────────────────────────────────

/**
 * Builds the summary embed posted alongside the transcript in the log channel.
 *
 * Provides at-a-glance information:
 *   - Ticket owner (if known from DB)
 *   - Closed by (moderator)
 *   - Channel name
 *   - Total message count
 *
 * @param {import('discord.js').TextChannel} channel
 * @param {import('discord.js').User} closedBy
 * @param {object|null} ownerRecord  GuildUser document or null
 * @param {number} messageCount
 * @returns {EmbedBuilder}
 */
function buildLogEmbed(channel, closedBy, ownerRecord, messageCount) {
	return new EmbedBuilder()
		.setTitle("🎫 Ticket Closed")
		.setColor("Red")
		.addFields(
			{
				name: "Channel",
				value: channel.name,
				inline: true,
			},
			{
				name: "Closed by",
				value: `<@${closedBy.id}>`,
				inline: true,
			},
			{
				name: "Ticket owner",
				value: ownerRecord ? `<@${ownerRecord.userId}>` : "Unknown",
				inline: true,
			},
			{
				name: "Total messages",
				value: String(messageCount),
				inline: true,
			},
		)
		.setTimestamp()
		.setFooter({ text: "Transcript attached below" })
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Formats a Date object as a human-readable timestamp for the transcript.
 * Output: "YYYY-MM-DD HH:MM:SS" in UTC.
 *
 * Using UTC avoids timezone ambiguity in logs that may be reviewed across
 * different regions or stored long-term.
 *
 * @param {Date} date
 * @returns {string}
 */
function formatTimestamp(date) {
	return date.toISOString().replace("T", " ").slice(0, 19)
}
