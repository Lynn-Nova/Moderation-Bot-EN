/**
 * @file warn-remove.js
 * @description Removes a specific warning entry from a user’s moderation record.
 *
 * Core responsibilities:
 * - Translate user-facing warning identifiers into internal indices
 * - Validate existence of warnings before attempting mutation
 * - Delegate removal logic to the data model layer
 * - Provide clear feedback for both success and failure cases
 *
 * Design considerations:
 * - Uses 1-based indexing for user interaction (UX-friendly)
 * - Converts to 0-based indexing for internal array operations
 * - Prevents invalid mutations through explicit validation and controlled error handling
 */

const {
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require("discord.js")
const GuildUser = require("../models/GuildUser")

module.exports = {
	/**
	 * Slash command definition.
	 *
	 * Permission model:
	 * Restricted to members with moderation privileges to prevent unauthorized
	 * manipulation of moderation history.
	 *
	 * Inputs:
	 * - target: user whose warning will be removed
	 * - id: user-facing warning identifier (1-based index)
	 */
	data: new SlashCommandBuilder()
		.setName("warn-remove")
		.setDescription("Remove a specific warning from a member.")
		.addUserOption(option =>
			option
				.setName("target")
				.setDescription("Member whose warning will be removed.")
				.setRequired(true),
		)
		.addIntegerOption(option =>
			option
				.setName("id")
				.setDescription("Warning ID as displayed by /warn list.")
				.setRequired(true)
				.setMinValue(1),
		)
		.setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

	/**
	 * Executes the warning removal workflow.
	 *
	 * Execution flow:
	 * 1. Extract input parameters
	 * 2. Convert user-facing ID (1-based) to internal index (0-based)
	 * 3. Retrieve user moderation record
	 * 4. Validate that warnings exist
	 * 5. Attempt removal via model method
	 * 6. Handle success or failure accordingly
	 *
	 * Important:
	 * The command does NOT manipulate the warnings array directly.
	 * Instead, it delegates mutation logic to the model layer,
	 * ensuring consistency and encapsulation of business rules.
	 *
	 * @param {CommandInteraction} interaction
	 */
	async execute(interaction) {
		const target = interaction.options.getUser("target")

		/**
		 * User-facing identifier (starts at 1).
		 * Example:
		 * - User sees warning #1, #2, #3...
		 */
		const requestedWarningId = interaction.options.getInteger("id")

		/**
		 * Internal array index (starts at 0).
		 *
		 * Translation rationale:
		 * JavaScript arrays are 0-based, so we adjust the value
		 * to match internal data structure expectations.
		 */
		const internalWarningIndex = requestedWarningId - 1

		const guildId = interaction.guild.id

		/**
		 * Retrieve the moderation record for the target user.
		 *
		 * If no record exists OR warnings array is empty,
		 * there is nothing to remove.
		 */
		const userRecord = await GuildUser.findOne({ guildId, userId: target.id })

		if (!userRecord?.warnings?.length) {
			return interaction.reply({
				content: `${target.tag} does not have any warnings registered.`,
				flags: MessageFlags.Ephemeral,
			})
		}

		try {
			/**
			 * Delegate removal logic to the model layer.
			 *
			 * Expected behavior:
			 * - Valid index → removes and returns the warning
			 * - Invalid index → throws an error
			 *
			 * This ensures:
			 * - Centralized validation
			 * - Consistent mutation behavior
			 */
			const removedWarning =
				await userRecord.removeWarningByIndex(internalWarningIndex)

			return interaction.reply({
				content: `✅ Warning **#${requestedWarningId}** was removed from **${target.tag}**. Removed reason: **${removedWarning.reason}**.`,
			})
		} catch {
			/**
			 * Error handling:
			 * Triggered when the provided index is out of bounds.
			 *
			 * Instead of exposing internal errors, a user-friendly
			 * validation message is returned.
			 */
			return interaction.reply({
				content: `Invalid warning ID. ${target.tag} only has ${userRecord.warnings.length} warning(s).`,
				flags: MessageFlags.Ephemeral,
			})
		}
	},
}
