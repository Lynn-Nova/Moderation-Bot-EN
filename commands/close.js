/**
 * @file close.js
 * @description Handles closure and deletion of a ticket channel.
 *
 * Core responsibilities:
 * - Validate whether the current channel is a valid ticket context
 * - Enforce authorization rules (ticket owner vs moderator)
 * - Ensure persistence layer is updated before destructive actions
 * - Provide delayed deletion to preserve user feedback visibility
 *
 * Design considerations:
 * - Supports both database-backed tickets and fallback "name-based" tickets
 * - Prevents unauthorized users from deleting channels
 * - Avoids orphaned database records by cleaning state before deletion
 */

const {
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require("discord.js")
const GuildUser = require("../models/GuildUser")

/**
 * Determines whether a channel follows the expected ticket naming convention.
 *
 * Rationale:
 * This acts as a fallback validation mechanism when a database record is missing.
 * It allows moderators to still manage channels that were:
 * - created before persistence existed
 * - manually renamed or partially desynchronized
 *
 * Limitation:
 * This method is heuristic-based and not authoritative.
 *
 * @param {GuildChannel} channel
 * @returns {boolean}
 */
function isTicketLikeChannel(channel) {
	return channel?.name?.startsWith("ticket-")
}

module.exports = {
	/**
	 * Slash command definition.
	 *
	 * Note:
	 * No explicit permission restriction is defined here because
	 * authorization is handled dynamically at runtime based on:
	 * - ticket ownership
	 * - moderator privileges
	 */
	data: new SlashCommandBuilder()
		.setName("close")
		.setDescription("Close the current ticket and clear the stored link."),

	/**
	 * Executes the ticket closure workflow.
	 *
	 * Execution flow:
	 * 1. Identify ticket record (if exists)
	 * 2. Validate channel context (DB record OR naming convention)
	 * 3. Resolve authorization (owner vs moderator)
	 * 4. Clear persistence state
	 * 5. Notify user
	 * 6. Schedule delayed channel deletion
	 *
	 * @param {CommandInteraction} interaction
	 */
	async execute(interaction) {
		const { channel, guild, member, user } = interaction
		const guildId = guild.id

		/**
		 * Attempt to locate a database record associated with this channel.
		 *
		 * Matching conditions:
		 * - Same guild
		 * - Channel ID matches stored ticket channel
		 * - Ticket is currently marked as active
		 */
		const ticketOwnerRecord = await GuildUser.findOne({
			guildId,
			ticketChannelId: channel.id,
			activateTicket: true,
		})

		/**
		 * Context validation:
		 * A channel is considered a valid ticket if:
		 * - It has a database record OR
		 * - It matches the ticket naming convention (fallback)
		 */
		if (!ticketOwnerRecord && !isTicketLikeChannel(channel)) {
			return interaction.reply({
				content: "This channel is not recognized as a ticket.",
				flags: MessageFlags.Ephemeral,
			})
		}

		/**
		 * Authorization resolution:
		 * - Owner: user who created the ticket
		 * - Moderator: user with ManageChannels permission
		 */
		const isOwner = ticketOwnerRecord?.userId === user.id
		const isModerator = member.permissions.has(
			PermissionFlagsBits.ManageChannels,
		)

		/**
		 * If no DB record exists:
		 * Only moderators are allowed to close the channel,
		 * since ownership cannot be reliably determined.
		 */
		if (!ticketOwnerRecord && !isModerator) {
			return interaction.reply({
				content: "Only moderators can close unregistered ticket channels.",
				flags: MessageFlags.Ephemeral,
			})
		}

		/**
		 * If a DB record exists:
		 * Only the ticket owner OR a moderator may close it.
		 */
		if (ticketOwnerRecord && !isOwner && !isModerator) {
			return interaction.reply({
				content: "You do not have permission to close this ticket.",
				flags: MessageFlags.Ephemeral,
			})
		}

		try {
			/**
			 * Persistence cleanup:
			 * Clear active ticket state BEFORE deleting the channel
			 * to avoid orphaned references in the database.
			 */
			if (ticketOwnerRecord) {
				await ticketOwnerRecord.clearActiveTicket()
			}

			/**
			 * Notify users before deletion.
			 *
			 * Important:
			 * Immediate deletion would remove this message before it is seen,
			 * so a delay is intentionally introduced.
			 */
			await interaction.reply({
				content: "🔒 This ticket will be closed and deleted in 5 seconds...",
			})

			/**
			 * Delayed destructive operation.
			 *
			 * Implementation detail:
			 * setTimeout is used instead of awaiting a delay utility
			 * to keep the interaction lifecycle independent from deletion timing.
			 */
			setTimeout(async () => {
				await channel.delete().catch(error => {
					console.error("Channel deletion failed:", error)
				})
			}, 5_000)
		} catch (error) {
			console.error("Ticket close operation failed:", error)

			const payload = {
				content: "An error occurred while trying to close this ticket.",
				flags: MessageFlags.Ephemeral,
			}

			/**
			 * Interaction state-aware error response:
			 * Ensures we respond correctly depending on whether
			 * an initial reply has already been sent.
			 */
			if (interaction.replied || interaction.deferred) {
				return interaction.followUp(payload).catch(() => null)
			}

			return interaction.reply(payload).catch(() => null)
		}
	},
}
