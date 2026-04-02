/**
 * @file mod.js
 * @description Unified moderation command module handling kick, ban, and timeout actions.
 *
 * Core design principles:
 * - Consolidates multiple moderation actions into a single command surface using subcommands
 * - Enforces validation and safety checks to prevent invalid or abusive moderation actions
 * - Persists moderation events for auditability and historical tracking
 * - Provides structured feedback via embeds for both moderators and affected users
 * - Handles Discord interaction lifecycle constraints (defer/edit reply pattern)
 *
 * Architectural note:
 * This module separates:
 * - validation logic
 * - execution logic
 * - persistence layer interaction
 * - user notification handling
 *
 * This improves maintainability and reduces duplication across moderation actions.
 */

const {
	EmbedBuilder,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require("discord.js")
const GuildUser = require("../models/GuildUser")

/**
 * Maximum timeout duration allowed by Discord (in minutes).
 *
 * Constraint:
 * Discord enforces a hard cap of 28 days for timeouts.
 * This constant ensures validation remains aligned with API limits.
 */
const MAX_TIMEOUT_MINUTES = 40_320

/**
 * Constructs a standardized moderation embed for logging and user notification.
 *
 * Design considerations:
 * - Ensures consistent formatting across all moderation actions
 * - Encodes key metadata (target, moderator, reason)
 * - Uses color coding to visually distinguish action severity
 *
 * @param {Object} options
 * @param {string} options.action - Moderation action type (Kick, Ban, Timeout)
 * @param {User} options.targetUser - User being moderated
 * @param {User} options.moderatorUser - Moderator performing the action
 * @param {string} options.reason - Reason for moderation
 * @param {Object} [options.extraField] - Optional additional embed field (e.g., timeout duration)
 *
 * @returns {EmbedBuilder}
 */
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

/**
 * Validates whether a target member can be moderated.
 *
 * Validation rules:
 * - Target must exist in the guild (cannot moderate users not present)
 * - Prevent self-moderation (logical constraint)
 * - Prevent moderation of the bot itself
 * - Ensure role hierarchy allows the action (Discord permission model)
 *
 * Important:
 * The `manageable` property reflects Discord’s role hierarchy enforcement.
 * Even if a user has permissions, hierarchy can still block the action.
 *
 * @param {CommandInteraction} interaction
 * @param {GuildMember|null} targetMember
 * @param {User} targetUser
 *
 * @returns {string|null} Error message if invalid, otherwise null
 */
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

/**
 * Persists moderation actions as warnings in the database.
 *
 * Rationale:
 * Even non-warning actions (kick/ban/timeout) are logged as warnings
 * to maintain a unified moderation history for each user.
 *
 * Data consistency:
 * Uses a "get or create" pattern to ensure a record always exists.
 *
 * @param {Object} params
 * @param {string} params.guildId
 * @param {string} params.userId
 * @param {string} params.moderatorId
 * @param {string} params.reason
 */
async function persistModerationLog({ guildId, userId, moderatorId, reason }) {
	const userRecord = await GuildUser.getOrCreate(guildId, userId)
	await userRecord.addWarning(moderatorId, reason)
}

/**
 * Attempts to notify the moderated user via direct message.
 *
 * Behavior:
 * - Sends a structured embed describing the moderation action
 * - Failure is expected in some cases (e.g., DMs disabled)
 *
 * Important:
 * Errors are intentionally not thrown to avoid breaking the moderation flow.
 *
 * @param {User} targetUser
 * @param {EmbedBuilder} embed
 */
async function notifyModeratedUser(targetUser, embed) {
	await targetUser.send({ embeds: [embed] })
}

module.exports = {
	/**
	 * Slash command definition using subcommands.
	 *
	 * Design rationale:
	 * - Reduces command clutter (/kick, /ban, /timeout → /mod <action>)
	 * - Provides a unified permission model
	 * - Simplifies future extensibility
	 */
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

	/**
	 * Main command execution handler.
	 *
	 * Execution flow:
	 * 1. Defer interaction to avoid timeout (Discord requires response within ~3s)
	 * 2. Extract and validate inputs
	 * 3. Route logic based on subcommand
	 * 4. Execute moderation action
	 * 5. Persist moderation record
	 * 6. Notify user (best-effort)
	 * 7. Respond to moderator with result
	 *
	 * Error handling:
	 * - Wrapped in try/catch to prevent unhandled promise rejections
	 * - Adapts response method depending on interaction state
	 *
	 * @param {CommandInteraction} interaction
	 */
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

			/**
			 * TIMEOUT FLOW
			 *
			 * Converts duration from minutes to milliseconds,
			 * applies timeout, logs action, and notifies the user.
			 */
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

			/**
			 * KICK FLOW
			 */
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

			/**
			 * BAN FLOW (default fallback)
			 */
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
