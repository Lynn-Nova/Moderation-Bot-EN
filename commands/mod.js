/**
 * @file mod.js
 * @description Consolidated moderation command for kick, ban and timeout.
 *
 * Module presents:
 * - subcommand-based API instead of fragmented command surface
 * - reusable validation helpers for moderation safety
 * - audit-friendly embeds and structured persistence writes
 * - graceful handling of DM notifications
 * - deferred interaction handling to prevent timeout-related failures
 */

const {
	EmbedBuilder,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require("discord.js")
const GuildUser = require("../models/GuildUser")

const MAX_TIMEOUT_MINUTES = 40_320

function buildModerationEmbed({
	action,
	targetUser,
	moderatorUser,
	reason,
	extraField,
}) {
	const embed = new EmbedBuilder()
		.setTitle(`Moderation Action: ${action}`)
		.setColor(
			action === "Ban" ? "Red" : action === "Kick" ? "Orange" : "Yellow",
		)
		.addFields(
			{ name: "Target", value: `${targetUser.tag}`, inline: true },
			{ name: "Moderator", value: `${moderatorUser.tag}`, inline: true },
			{ name: "Reason", value: reason },
		)
		.setTimestamp()

	if (extraField) {
		embed.addFields(extraField)
	}

	return embed
}

function validateTargetMember(interaction, targetMember, targetUser) {
	if (!targetMember) {
		return `Member ${targetUser.tag} was not found in this guild.`
	}

	if (targetUser.id === interaction.user.id) {
		return "You cannot moderate yourself."
	}

	if (targetUser.id === interaction.client.user.id) {
		return "You cannot use moderation commands on the bot."
	}

	if (!targetMember.manageable) {
		return `I do not have enough role hierarchy to moderate ${targetUser.tag}.`
	}

	return null
}

async function persistModerationLog({ guildId, userId, moderatorId, reason }) {
	const userRecord = await GuildUser.getOrCreate(guildId, userId)
	await userRecord.addWarning(moderatorId, reason)
}

async function notifyModeratedUser(targetUser, embed) {
	await targetUser.send({ embeds: [embed] })
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName("mod")
		.setDescription("Moderation command group.")
		.setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
		.addSubcommand(subcommand =>
			subcommand
				.setName("kick")
				.setDescription("Kick a member from the server.")
				.addUserOption(option =>
					option
						.setName("target")
						.setDescription("Member to kick.")
						.setRequired(true),
				)
				.addStringOption(option =>
					option.setName("reason").setDescription("Reason for the kick."),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName("ban")
				.setDescription("Ban a member from the server.")
				.addUserOption(option =>
					option
						.setName("target")
						.setDescription("Member to ban.")
						.setRequired(true),
				)
				.addStringOption(option =>
					option.setName("reason").setDescription("Reason for the ban."),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName("timeout")
				.setDescription("Temporarily timeout a member.")
				.addUserOption(option =>
					option
						.setName("target")
						.setDescription("Member to timeout.")
						.setRequired(true),
				)
				.addIntegerOption(option =>
					option
						.setName("duration")
						.setDescription("Timeout duration in minutes.")
						.setRequired(true)
						.setMinValue(1)
						.setMaxValue(MAX_TIMEOUT_MINUTES),
				)
				.addStringOption(option =>
					option.setName("reason").setDescription("Reason for the timeout."),
				),
		),

	async execute(interaction) {
		try {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral })

			const subcommand = interaction.options.getSubcommand()
			const targetUser = interaction.options.getUser("target")
			const targetMember = interaction.options.getMember("target")
			const reason =
				interaction.options.getString("reason") || "No reason provided."

			const validationError = validateTargetMember(
				interaction,
				targetMember,
				targetUser,
			)

			if (validationError) {
				return interaction.editReply({
					content: validationError,
				})
			}

			if (subcommand === "timeout") {
				const durationMinutes = interaction.options.getInteger("duration")
				const durationMs = durationMinutes * 60 * 1000
				const auditReason = `[TIMEOUT ${durationMinutes}m] ${reason}`

				await targetMember.timeout(durationMs, reason)

				await persistModerationLog({
					guildId: interaction.guild.id,
					userId: targetUser.id,
					moderatorId: interaction.user.id,
					reason: auditReason,
				})

				const embed = buildModerationEmbed({
					action: "Timeout",
					targetUser,
					moderatorUser: interaction.user,
					reason,
					extraField: {
						name: "Duration",
						value: `${durationMinutes} minute(s)`,
						inline: true,
					},
				})

				try {
					await notifyModeratedUser(targetUser, embed)
				} catch {
					console.log(`Timeout DM could not be delivered to ${targetUser.tag}.`)
				}

				return interaction.editReply({ embeds: [embed] })
			}

			if (subcommand === "kick") {
				await targetMember.kick(reason)

				await persistModerationLog({
					guildId: interaction.guild.id,
					userId: targetUser.id,
					moderatorId: interaction.user.id,
					reason: `[KICK] ${reason}`,
				})

				const embed = buildModerationEmbed({
					action: "Kick",
					targetUser,
					moderatorUser: interaction.user,
					reason,
				})

				try {
					await notifyModeratedUser(targetUser, embed)
				} catch {
					console.log(`Kick DM could not be delivered to ${targetUser.tag}.`)
				}

				return interaction.editReply({ embeds: [embed] })
			}

			await targetMember.ban({ reason })

			await persistModerationLog({
				guildId: interaction.guild.id,
				userId: targetUser.id,
				moderatorId: interaction.user.id,
				reason: `[BAN] ${reason}`,
			})

			const embed = buildModerationEmbed({
				action: "Ban",
				targetUser,
				moderatorUser: interaction.user,
				reason,
			})

			try {
				await notifyModeratedUser(targetUser, embed)
			} catch {
				console.log(`Ban DM could not be delivered to ${targetUser.tag}.`)
			}

			return interaction.editReply({ embeds: [embed] })
		} catch (error) {
			console.error("Mod command failed:", error)

			const payload = {
				content: "An error occurred while processing the moderation command.",
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
