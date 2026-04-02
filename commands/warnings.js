/**
 * @file warnings.js
 * @description Moderation command module for issuing and viewing warnings.
 *
 * Core responsibilities:
 * - Provide a unified interface for warning management (add + list)
 * - Persist moderation actions through the GuildUser model
 * - Format warning history for human-readable audit output
 * - Notify users of warnings via direct message (best-effort)
 *
 * Design principles:
 * - Uses subcommands to avoid fragmented command structure
 * - Delegates validation and mutation logic to the model layer
 * - Ensures interaction lifecycle compliance via early deferral
 * - Prioritizes audit clarity and traceability in output formatting
 */

const {
	EmbedBuilder,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require("discord.js")
const GuildUser = require("../models/GuildUser")

/**
 * Formats a list of warning objects into a readable embed description.
 *
 * Output structure:
 * Each warning entry includes:
 * - Sequential ID (1-based index)
 * - Reason for the warning
 * - Moderator responsible (resolved as mention if possible)
 * - Relative timestamp (Discord-formatted)
 *
 * Implementation details:
 * - Uses Discord's <t:timestamp:R> format for relative time display
 * - Handles missing data gracefully (fallback values)
 *
 * @param {Array<Object>} warnings
 * @returns {string}
 */
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

/**
 * Sends a direct message to the warned user.
 *
 * Behavior:
 * - Constructs a structured embed describing the warning
 * - Includes guild context, reason, and moderator identity
 *
 * Failure handling:
 * - This function does NOT handle errors internally
 * - Caller is responsible for catching failures (e.g., DMs disabled)
 *
 * @param {User} target
 * @param {string} guildName
 * @param {string} moderatorTag
 * @param {string} reason
 */
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
	/**
	 * Slash command definition using subcommands.
	 *
	 * Subcommands:
	 * - add: issues a new warning
	 * - list: retrieves warning history
	 *
	 * Permission model:
	 * Restricted to members with moderation privileges.
	 */
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

	/**
	 * Main execution handler for warning operations.
	 *
	 * Execution flow:
	 * 1. Defer interaction (prevents Discord timeout)
	 * 2. Determine subcommand type
	 * 3. Route to appropriate logic branch (add or list)
	 * 4. Interact with persistence layer
	 * 5. Format and return response
	 *
	 * Error handling:
	 * - Wrapped in try/catch to prevent crashes
	 * - Adapts response method based on interaction state
	 *
	 * @param {CommandInteraction} interaction
	 */
	async execute(interaction) {
		try {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral })

			const subcommand = interaction.options.getSubcommand()
			const target = interaction.options.getUser("target")
			const guildId = interaction.guild.id

			/**
			 * ADD WARNING FLOW
			 *
			 * Responsibilities:
			 * - Normalize input reason
			 * - Persist warning
			 * - Attempt DM notification
			 * - Return confirmation embed
			 */
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
					/**
					 * DM failures are expected (privacy settings).
					 * Logging is sufficient; execution continues normally.
					 */
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

			/**
			 * LIST WARNINGS FLOW
			 *
			 * Retrieves and formats the user's warning history.
			 */
			const userRecord = await GuildUser.findOne({
				guildId,
				userId: target.id,
			}).lean()

			/**
			 * Validation:
			 * If no warnings exist, return early.
			 */
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
