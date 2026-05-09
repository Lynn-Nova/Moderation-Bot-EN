/**
 * @file warnings.js
 * @description Moderation command for issuing warnings and browsing warning history.
 *
 * ─── Overview ────────────────────────────────────────────────────────────────
 * Subcommands:
 *   add  — Issues a new warning and persists it in MongoDB.
 *   list — Displays paginated warning history with interactive navigation buttons.
 *
 * ─── Pagination system (list subcommand) ─────────────────────────────────────
 * When a user has many warnings, displaying them all in a single embed is
 * impractical (Discord's embed description limit is 4 096 characters) and
 * overwhelming to read.
 *
 * This command implements button-driven pagination using Discord.js's
 * `ComponentCollector`:
 *
 *   • Warnings are split into pages of WARNINGS_PER_PAGE entries.
 *   • Two buttons (◀ Previous / ▶ Next) are presented below the embed.
 *   • Each button press triggers an UPDATE to the existing message (no new reply).
 *   • Buttons are disabled when the first or last page is active.
 *   • The collector expires after COLLECTOR_TIMEOUT_MS of inactivity,
 *     at which point all buttons are disabled to signal that the session ended.
 *
 * Why use buttonInteraction.update() inside the collector instead of editReply()?
 * The collector receives ButtonInteraction events — distinct from the original
 * ChatInputCommandInteraction. Calling update() on the button interaction is
 * the correct pattern: it acknowledges the button press AND edits the message
 * in a single API call, satisfying Discord's 3-second acknowledgement window.
 *
 * ─── Design principles ───────────────────────────────────────────────────────
 * - Separation of concerns: embed construction, pagination state, and
 *   interaction lifecycle are handled in dedicated helper functions.
 * - Defensive filtering: the collector only accepts button presses from the
 *   user who invoked the command, preventing others from hijacking navigation.
 * - Graceful cleanup: on collector end, buttons are disabled rather than
 *   removed, giving clear visual feedback that the session has expired.
 */

const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require("discord.js")
const GuildUser = require("../models/GuildUser")

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum warning entries displayed per embed page.
 * 5 entries keep the embed readable and within Discord's character limits.
 */
const WARNINGS_PER_PAGE = 5

/**
 * Idle timeout for the button collector (milliseconds).
 * Resets on every valid button press. After 2 minutes of inactivity,
 * the collector stops and buttons are disabled.
 */
const COLLECTOR_TIMEOUT_MS = 2 * 60 * 1_000

/**
 * Custom IDs for pagination buttons.
 * Namespaced with "warn_page_" to avoid collisions with other buttons.
 */
const BUTTON_PREV_ID = "warn_page_prev"
const BUTTON_NEXT_ID = "warn_page_next"

// ─── Module export ────────────────────────────────────────────────────────────

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
				.setDescription("Browse the warning history of a member (paginated).")
				.addUserOption(option =>
					option
						.setName("target")
						.setDescription("Member whose warnings will be displayed.")
						.setRequired(true),
				),
		),

	/**
	 * Routes execution to the appropriate subcommand handler.
	 *
	 * Uses early deferral because pagination setup (DB read + collector init)
	 * may exceed Discord's 3-second interaction acknowledgement deadline.
	 *
	 * @param {import('discord.js').ChatInputCommandInteraction} interaction
	 */
	async execute(interaction) {
		try {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral })

			const subcommand = interaction.options.getSubcommand()
			const target = interaction.options.getUser("target")
			const guildId = interaction.guild.id

			if (subcommand === "add") {
				return await handleAddWarning(interaction, target, guildId)
			}

			if (subcommand === "list") {
				return await handleListWarnings(interaction, target, guildId)
			}
		} catch (error) {
			console.error("Warn command failed:", error)

			const payload = {
				content: "An error occurred while processing the warning command.",
			}

			if (interaction.deferred || interaction.replied) {
				return interaction.editReply(payload).catch(() => null)
			}

			return interaction
				.reply({ ...payload, flags: MessageFlags.Ephemeral })
				.catch(() => null)
		}
	},
}

// ─── Subcommand handlers ──────────────────────────────────────────────────────

/**
 * Issues a new warning to the target user.
 *
 * Flow:
 *   1. Normalise the reason string via the model's static helper.
 *   2. Upsert the GuildUser record (getOrCreate prevents duplicate documents
 *      even under concurrent writes).
 *   3. Append the warning entry via the instance method (encapsulates mutation).
 *   4. Attempt DM notification — expected to fail silently if DMs are disabled.
 *   5. Reply with a confirmation embed including the updated warning count.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').User} target
 * @param {string} guildId
 */
async function handleAddWarning(interaction, target, guildId) {
	const reason = GuildUser.normalizeReason(
		interaction.options.getString("reason"),
	)

	const userRecord = await GuildUser.getOrCreate(guildId, target.id)
	await userRecord.addWarning(interaction.user.id, reason)

	await notifyTargetUser(
		target,
		interaction.guild.name,
		interaction.user.tag,
		reason,
	).catch(() => console.log(`DM delivery skipped for ${target.tag}.`))

	const confirmationEmbed = new EmbedBuilder()
		.setTitle("⚠️ Warning Applied")
		.setDescription(`${target} has received a warning.`)
		.addFields(
			{ name: "Reason", value: reason },
			{
				name: "Total Warnings",
				// warningCount is a virtual property — computed at runtime,
				// not stored in the database, keeping the document lean.
				value: String(userRecord.warningCount),
				inline: true,
			},
		)
		.setColor("Yellow")
		.setTimestamp()

	return interaction.editReply({ embeds: [confirmationEmbed] })
}

/**
 * Displays the target user's warning history with interactive pagination.
 *
 * Flow:
 *   1. Fetch GuildUser with .lean() — returns a plain JS object instead of
 *      a Mongoose Document. lean() skips hydration, which is correct here
 *      because we only need to READ the data, not call instance methods.
 *   2. Return early if no warnings exist.
 *   3. Calculate total pages and build the initial embed + button row.
 *   4. Send the reply (editReply returns the sent Message, used for collector).
 *   5. Attach a ComponentCollector to the reply message.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').User} target
 * @param {string} guildId
 */
async function handleListWarnings(interaction, target, guildId) {
	const userRecord = await GuildUser.findOne({ guildId, userId: target.id }).lean()

	if (!userRecord?.warnings?.length) {
		return interaction.editReply({
			content: `${target.tag} does not have any warnings registered.`,
		})
	}

	const warnings = userRecord.warnings
	const totalPages = Math.ceil(warnings.length / WARNINGS_PER_PAGE)
	let currentPage = 0

	const embed = buildWarningPageEmbed(warnings, target, currentPage, totalPages)
	const row = buildNavigationRow(currentPage, totalPages)

	// editReply returns the Message object — required to attach the collector
	const reply = await interaction.editReply({ embeds: [embed], components: [row] })

	// ── Component collector ───────────────────────────────────────────────────
	// createMessageComponentCollector scopes the listener to this specific message.
	// It will not fire for button interactions on any other message in the guild.
	const collector = reply.createMessageComponentCollector({
		/**
		 * Filter: only accept button presses from the user who ran /warn list.
		 *
		 * Without this filter, any user who can see the ephemeral reply
		 * (in practice, only the invoker since it's ephemeral) could navigate.
		 * The filter also prevents potential edge cases with button ID collisions.
		 */
		filter: buttonInteraction =>
			buttonInteraction.user.id === interaction.user.id,

		/**
		 * idle: resets the timer on each valid collection.
		 * Unlike "time" which sets a hard deadline, "idle" gives the user
		 * 2 full minutes from their last interaction before the session expires.
		 */
		idle: COLLECTOR_TIMEOUT_MS,
	})

	/**
	 * "collect" fires for each button press that passes the filter.
	 *
	 * We update currentPage based on which button was pressed, rebuild the
	 * embed and row, then call buttonInteraction.update() to:
	 *   a) Acknowledge the button interaction (required within 3 seconds).
	 *   b) Replace the message content with the new page (single API call).
	 *
	 * Math.max / Math.min guard against going out of bounds even if
	 * Discord somehow delivers a duplicate event or the filter is bypassed.
	 */
	collector.on("collect", async buttonInteraction => {
		if (buttonInteraction.customId === BUTTON_PREV_ID) {
			currentPage = Math.max(0, currentPage - 1)
		} else if (buttonInteraction.customId === BUTTON_NEXT_ID) {
			currentPage = Math.min(totalPages - 1, currentPage + 1)
		}

		const updatedEmbed = buildWarningPageEmbed(warnings, target, currentPage, totalPages)
		const updatedRow = buildNavigationRow(currentPage, totalPages)

		await buttonInteraction.update({ embeds: [updatedEmbed], components: [updatedRow] })
	})

	/**
	 * "end" fires when the collector stops for any reason:
	 *   - "idle": COLLECTOR_TIMEOUT_MS elapsed with no button press
	 *   - "user": manually stopped (not used here)
	 *   - "messageDelete": the reply was deleted
	 *
	 * We disable all buttons to visually communicate that the session is over.
	 * This is preferable to removing the components entirely, as it preserves
	 * the last rendered page for reference.
	 */
	collector.on("end", async () => {
		const disabledRow = buildNavigationRow(currentPage, totalPages, true)
		await interaction.editReply({ components: [disabledRow] }).catch(() => null)
	})
}

// ─── UI builders ──────────────────────────────────────────────────────────────

/**
 * Constructs the embed for a single page of warnings.
 *
 * Slices the warnings array to isolate the current page's entries,
 * then maps each to a structured multi-line string block.
 *
 * Discord timestamp syntax `<t:UNIX:R>` renders as a live relative time
 * string (e.g., "2 hours ago") that updates in the client automatically.
 *
 * @param {Array<Object>} warnings   Full warnings array from the lean() document
 * @param {import('discord.js').User} target
 * @param {number} currentPage       Zero-based page index
 * @param {number} totalPages
 * @returns {EmbedBuilder}
 */
function buildWarningPageEmbed(warnings, target, currentPage, totalPages) {
	const start = currentPage * WARNINGS_PER_PAGE
	const pageWarnings = warnings.slice(start, start + WARNINGS_PER_PAGE)

	const description = pageWarnings
		.map((warning, index) => {
			const globalIndex = start + index + 1 // Convert to 1-based for display
			const moderatorMention = warning.moderatorId
				? `<@${warning.moderatorId}>`
				: "Unknown moderator"
			const relativeDate = warning.date
				? `<t:${Math.floor(new Date(warning.date).getTime() / 1_000)}:R>`
				: "Unknown date"

			return [
				`**Warning #${globalIndex}**`,
				`**Reason:** ${warning.reason}`,
				`**Moderator:** ${moderatorMention}`,
				`**Issued:** ${relativeDate}`,
			].join("\n")
		})
		.join("\n\n")

	return new EmbedBuilder()
		.setTitle(`⚠️ Warning history — ${target.username}`)
		.setDescription(description)
		.setColor("Red")
		.setFooter({
			text: `Page ${currentPage + 1} of ${totalPages} • ${warnings.length} total warning(s)`,
		})
		.setTimestamp()
}

/**
 * Builds the ActionRow containing Previous and Next navigation buttons.
 *
 * Buttons are automatically disabled at page boundaries:
 *   - "Previous" is disabled on page 0 (first page).
 *   - "Next" is disabled on the last page.
 *   - forceDisable=true disables both (used when the collector ends).
 *
 * ActionRow is required by Discord — buttons cannot be sent standalone.
 *
 * @param {number} currentPage
 * @param {number} totalPages
 * @param {boolean} [forceDisable=false]
 * @returns {ActionRowBuilder}
 */
function buildNavigationRow(currentPage, totalPages, forceDisable = false) {
	const prevButton = new ButtonBuilder()
		.setCustomId(BUTTON_PREV_ID)
		.setLabel("◀ Previous")
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(forceDisable || currentPage === 0)

	const nextButton = new ButtonBuilder()
		.setCustomId(BUTTON_NEXT_ID)
		.setLabel("Next ▶")
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(forceDisable || currentPage === totalPages - 1)

	return new ActionRowBuilder().addComponents(prevButton, nextButton)
}

// ─── DM notification helper ───────────────────────────────────────────────────

/**
 * Sends a structured warning notification to the user via DM.
 *
 * Does NOT handle errors internally — the caller catches them and logs
 * a skip notice. This separates the concerns of "warning persisted" and
 * "user notified", which are independent outcomes with different failure modes.
 *
 * @param {import('discord.js').User} target
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
