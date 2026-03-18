/**
 * @file warnings.js
 * @description Slash command for warning management.
 *
 * Implementation details:
 * - uses one command with subcommands instead of duplicated modules
 * - keeps persistence concerns close to model helpers
 * - gracefully handles DM delivery
 * - formats moderation history for audit readability
 * - defers the interaction early to prevent timeout-related failures
 */

const {
	EmbedBuilder,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require("discord.js")
const GuildUser = require("../models/GuildUser")

function buildWarningListDescription(warnings = []) {
	return warnings
		.map((warning, index) => {
			const moderatorMention = warning.moderatorId
				? `<@${warning.moderatorId}>`
				: "Unknown moderator"

			const relativeDate = warning.date
				? `<t:${Math.floor(new Date(warning.date).getTime() / 1000)}:R>`
				: "Unknown date"

			return [
				`**Warning ID:** #${index + 1}`,
				`**Reason:** ${warning.reason}`,
				`**Moderator:** ${moderatorMention}`,
				`**Issued:** ${relativeDate}`,
			].join("\n")
		})
		.join("\n\n")
}

async function notifyTargetUser(target, guildName, moderatorTag, reason) {
	const dmEmbed = new EmbedBuilder()
		.setTitle("⚠️ Warning Received")
		.setDescription(`You received a warning in **${guildName}**.`)
		.addFields(
			{ name: "Reason", value: reason },
			{ name: "Moderator", value: moderatorTag },
		)
		.setColor("Orange")
		.setTimestamp()

	await target.send({ embeds: [dmEmbed] })
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName("warn")
		.setDescription("Warning management command set.")
		.setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
		.addSubcommand(subcommand =>
			subcommand
				.setName("add")
				.setDescription("Issue a warning to a member.")
				.addUserOption(option =>
					option
						.setName("target")
						.setDescription("Member who will receive the warning.")
						.setRequired(true),
				)
				.addStringOption(option =>
					option
						.setName("reason")
						.setDescription("Reason for the warning.")
						.setRequired(true),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName("list")
				.setDescription("Display the warning history of a member.")
				.addUserOption(option =>
					option
						.setName("target")
						.setDescription("Member whose warnings will be displayed.")
						.setRequired(true),
				),
		),

	async execute(interaction) {
		try {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral })

			const subcommand = interaction.options.getSubcommand()
			const target = interaction.options.getUser("target")
			const guildId = interaction.guild.id

			if (subcommand === "add") {
				const reason = GuildUser.normalizeReason(
					interaction.options.getString("reason"),
				)

				const userRecord = await GuildUser.getOrCreate(guildId, target.id)
				await userRecord.addWarning(interaction.user.id, reason)

				try {
					await notifyTargetUser(
						target,
						interaction.guild.name,
						interaction.user.tag,
						reason,
					)
				} catch {
					console.log(`DM delivery skipped for ${target.tag}.`)
				}

				const confirmationEmbed = new EmbedBuilder()
					.setTitle("⚠️ Warning Applied")
					.setDescription(`${target} has received a warning.`)
					.addFields(
						{ name: "Reason", value: reason },
						{
							name: "Total Warnings",
							value: String(userRecord.warningCount),
							inline: true,
						},
					)
					.setColor("Yellow")
					.setTimestamp()

				return interaction.editReply({ embeds: [confirmationEmbed] })
			}

			const userRecord = await GuildUser.findOne({
				guildId,
				userId: target.id,
			}).lean()

			if (!userRecord?.warnings?.length) {
				return interaction.editReply({
					content: `${target.tag} does not have any warnings registered.`,
				})
			}

			const listEmbed = new EmbedBuilder()
				.setTitle(`Warning history for ${target.username}`)
				.setColor("Red")
				.setDescription(buildWarningListDescription(userRecord.warnings))
				.setFooter({ text: `Total warnings: ${userRecord.warnings.length}` })
				.setTimestamp()

			return interaction.editReply({ embeds: [listEmbed] })
		} catch (error) {
			console.error("Warn command failed:", error)

			const payload = {
				content: "An error occurred while processing the warning command.",
			}

			if (interaction.deferred || interaction.replied) {
				return interaction.editReply(payload).catch(() => null)
			}

			return interaction
				.reply({
					...payload,
					flags: MessageFlags.Ephemeral,
				})
				.catch(() => null)
		}
	},
}
