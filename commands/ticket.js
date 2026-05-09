/**
 * @file ticket.js
 * @description Renders the ticket system entry panel (UI layer only).
 *
 * Core responsibility:
 * - Provide an interactive entry point for users to initiate ticket creation
 *
 * Architectural separation:
 * This module is intentionally limited to UI rendering.
 * The actual ticket creation logic is handled centrally in the interaction
 * router (index.js) via button events.
 *
 * Rationale:
 * - Keeps command logic lightweight and focused
 * - Avoids duplicating ticket creation logic across multiple entry points
 * - Ensures all ticket creation flows go through a single controlled pathway
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
	/**
	 * Slash command definition for publishing the ticket panel.
	 *
	 * Permission model:
	 * Restricted to administrators to prevent unauthorized users
	 * from spawning multiple ticket panels across the server.
	 */
	data: new SlashCommandBuilder()
		.setName("ticket-setup")
		.setDescription("Create the support ticket panel.")
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

	/**
	 * Executes the panel creation.
	 *
	 * Execution flow:
	 * 1. Construct an informational embed explaining the ticket system
	 * 2. Create a button component used to trigger ticket creation
	 * 3. Send both as a single interaction response
	 *
	 * Important:
	 * - The button does NOT create the ticket directly
	 * - It emits an interaction event identified by its customId
	 * - That event is handled globally in index.js
	 *
	 * @param {CommandInteraction} interaction
	 */
	async execute(interaction) {
		/**
		 * Informational embed presented to users.
		 *
		 * Design considerations:
		 * - Clear instructions to reduce misuse
		 * - Minimal but sufficient context
		 * - Timestamp included for audit/reference purposes
		 */
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

		/**
		 * Action row containing interactive components.
		 *
		 * Constraint:
		 * Discord requires buttons to be wrapped inside an ActionRow.
		 */
		const actionRow = new ActionRowBuilder().addComponents(
			/**
			 * Ticket creation trigger button.
			 *
			 * Key detail:
			 * - customId acts as a routing identifier
			 * - must match the handler defined in index.js
			 *
			 * Interaction flow:
			 * User clicks → interactionCreate event → routed by customId → ticket created
			 */
			new ButtonBuilder()
				.setCustomId("open_ticket")
				.setLabel("Open Ticket")
				.setEmoji("📩")
				.setStyle(ButtonStyle.Primary),
		)

		/**
		 * Sends the panel to the current channel.
		 *
		 * Behavior:
		 * - Public message (not ephemeral)
		 * - Designed to persist as a reusable entry point
		 */
		return interaction.reply({
			embeds: [ticketPanelEmbed],
			components: [actionRow],
		})
	},
}
