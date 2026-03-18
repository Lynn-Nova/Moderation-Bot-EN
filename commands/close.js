/**
 * @file close.js
 * @description Close the current ticket channel.
 *
 * This module demonstrates:
 * - contextual validation based on the current channel
 * - owner/moderator authorization logic
 * - persistence cleanup before destructive channel deletion
 * - delayed deletion so the user can still read the closing confirmation
 */

const {
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require("discord.js")
const GuildUser = require("../models/GuildUser")

function isTicketLikeChannel(channel) {
	return channel?.name?.startsWith("ticket-")
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName("close")
		.setDescription("Close the current ticket and clear the stored link."),

	async execute(interaction) {
		const { channel, guild, member, user } = interaction
		const guildId = guild.id

		const ticketOwnerRecord = await GuildUser.findOne({
			guildId,
			ticketChannelId: channel.id,
			activateTicket: true,
		})

		if (!ticketOwnerRecord && !isTicketLikeChannel(channel)) {
			return interaction.reply({
				content: "This channel is not recognized as a ticket.",
				flags: MessageFlags.Ephemeral,
			})
		}

		const isOwner = ticketOwnerRecord?.userId === user.id
		const isModerator = member.permissions.has(
			PermissionFlagsBits.ManageChannels,
		)

		if (!ticketOwnerRecord && !isModerator) {
			return interaction.reply({
				content: "Only moderators can close unregistered ticket channels.",
				flags: MessageFlags.Ephemeral,
			})
		}

		if (ticketOwnerRecord && !isOwner && !isModerator) {
			return interaction.reply({
				content: "You do not have permission to close this ticket.",
				flags: MessageFlags.Ephemeral,
			})
		}

		try {
			if (ticketOwnerRecord) {
				await ticketOwnerRecord.clearActiveTicket()
			}

			await interaction.reply({
				content: "🔒 This ticket will be closed and deleted in 5 seconds...",
			})

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

			if (interaction.replied || interaction.deferred) {
				return interaction.followUp(payload).catch(() => null)
			}

			return interaction.reply(payload).catch(() => null)
		}
	},
}
