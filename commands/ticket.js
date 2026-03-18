/**
 * @file ticket.js
 * @description Publish the ticket system panel.
 *
 * This command renders the entry UI, while the button interaction itself is handled centrally in index.js.
 */

const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require("discord.js")

module.exports = {
	data: new SlashCommandBuilder()
		.setName("ticket-setup")
		.setDescription("Create the support ticket panel.")
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

	async execute(interaction) {
		const ticketPanelEmbed = new EmbedBuilder()
			.setTitle("🎫 Support Ticket System")
			.setDescription(
				[
					"Need help from the moderation team?",
					"",
					"Click the button below to create a private support channel.",
					"Only you and the moderation team will be able to see it.",
				].join("\n"),
			)
			.setTimestamp()

		const actionRow = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId("open_ticket")
				.setLabel("Open Ticket")
				.setEmoji("📩")
				.setStyle(ButtonStyle.Primary),
		)

		return interaction.reply({
			embeds: [ticketPanelEmbed],
			components: [actionRow],
		})
	},
}
