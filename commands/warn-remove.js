/**
 * @file warn-remove.js
 * @description Remove a specific warning from a member.
 *
 * This command demonstrates index translation, model-level mutation helpers and
 * explicit validation paths before any destructive change is committed.
 */

const {
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require("discord.js")
const GuildUser = require("../models/GuildUser")

module.exports = {
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

	async execute(interaction) {
		const target = interaction.options.getUser("target")
		const requestedWarningId = interaction.options.getInteger("id")
		const internalWarningIndex = requestedWarningId - 1
		const guildId = interaction.guild.id

		const userRecord = await GuildUser.findOne({ guildId, userId: target.id })

		if (!userRecord?.warnings?.length) {
			return interaction.reply({
				content: `${target.tag} does not have any warnings registered.`,
				flags: MessageFlags.Ephemeral,
			})
		}

		try {
			const removedWarning =
				await userRecord.removeWarningByIndex(internalWarningIndex)

			return interaction.reply({
				content: `✅ Warning **#${requestedWarningId}** was removed from **${target.tag}**. Removed reason: **${removedWarning.reason}**.`,
			})
		} catch {
			return interaction.reply({
				content: `Invalid warning ID. ${target.tag} only has ${userRecord.warnings.length} warning(s).`,
				flags: MessageFlags.Ephemeral,
			})
		}
	},
}
