/**
 * @file automod-setup.js
 * @description Interactive AutoMod configuration panel using Select Menus and Modals.
 *
 * ─── Overview ────────────────────────────────────────────────────────────────
 * Replaces the subcommand-based /automod with a fully visual setup panel.
 * Administrators interact with a persistent embed containing a Select Menu
 * to choose which setting to configure. Each option opens the appropriate
 * Modal or responds inline.
 *
 * ─── Interaction flow ────────────────────────────────────────────────────────
 * /automod-setup
 *   └─ Sends the setup embed with a Select Menu
 *        ├─ "Banned Words"     → Modal (add/remove words)
 *        ├─ "Spam Limit"       → Modal (max messages + window seconds)
 *        ├─ "Mute Role"        → RoleSelectMenu (native Discord role picker)
 *        │    └─ If no role exists yet, admin can create one via a follow-up
 *        │       button that opens a Modal with just the role name.
 *        ├─ "Action"           → Second Select Menu (delete/warn/timeout/kick/ban)
 *        ├─ "Log Channel"      → Modal (channel ID or #mention)
 *        ├─ "Exempt Role"      → Modal (role ID or name + add/remove)
 *        └─ "Toggle"           → Inline enable/disable toggle
 *
 * ─── Component ID conventions ────────────────────────────────────────────────
 * All custom IDs are prefixed with "ams_" (automod setup) to avoid collisions:
 *   ams_menu              — main Select Menu
 *   ams_modal_*           — Modal submissions
 *   ams_action_select     — action picker Select Menu
 *   ams_role_select       — RoleSelectMenu for mute role
 *   ams_create_role_btn   — button to open the "create role" modal
 *   ams_modal_create_role — modal for new role name
 *
 * ─── State management ────────────────────────────────────────────────────────
 * Config is read from and written to MongoDB (GuildConfig) on every interaction.
 * The in-memory cache in autoMod.js is invalidated after each save so the
 * messageCreate handler picks up new settings immediately.
 *
 * ─── Routing ─────────────────────────────────────────────────────────────────
 * The interactionCreate router in index.js must forward:
 *   - StringSelectMenu interactions with customId starting with "ams_"
 *   - RoleSelectMenu interactions with customId "ams_role_select"
 *   - Button interactions with customId "ams_create_role_btn"
 *   - ModalSubmit interactions with customId starting with "ams_"
 * to the handler exported by this module: `handleAutoModSetupInteraction`.
 */

const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	MessageFlags,
	ModalBuilder,
	PermissionFlagsBits,
	RoleSelectMenuBuilder,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextInputBuilder,
	TextInputStyle,
} = require("discord.js")
const GuildConfig = require("../models/GuildConfig")
const autoMod = require("../events/autoMod")

// ─── Constants ────────────────────────────────────────────────────────────────

const MENU_ID = "ams_menu"
const ACTION_SELECT_ID = "ams_action_select"
const ROLE_SELECT_ID = "ams_role_select"
const CREATE_ROLE_BTN_ID = "ams_create_role_btn"

const MODAL_BANNED_WORDS = "ams_modal_banned_words"
const MODAL_SPAM = "ams_modal_spam"
const MODAL_LOG_CHANNEL = "ams_modal_log_channel"
const MODAL_EXEMPT_ROLE = "ams_modal_exempt_role"
const MODAL_CREATE_ROLE = "ams_modal_create_role"

// ─── Slash command definition ─────────────────────────────────────────────────

module.exports = {
	data: new SlashCommandBuilder()
		.setName("automod-setup")
		.setDescription("Open the interactive AutoMod configuration panel.")
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

	/**
	 * Sends the AutoMod setup panel to the channel.
	 * The panel is ephemeral so only the admin sees it.
	 *
	 * @param {import('discord.js').ChatInputCommandInteraction} interaction
	 */
	async execute(interaction) {
		const config = await GuildConfig.getOrCreate(interaction.guild.id)

		const embed = buildSetupEmbed(config)
		const row = buildMainMenu()

		await interaction.reply({
			embeds: [embed],
			components: [row],
			flags: MessageFlags.Ephemeral,
		})
	},

	// Exported so index.js can forward component/modal interactions here
	handleAutoModSetupInteraction,
	ROLE_SELECT_ID,
	CREATE_ROLE_BTN_ID,
}

// ─── Interaction router ───────────────────────────────────────────────────────

/**
 * Central handler for all AutoMod setup component and modal interactions.
 * Called from index.js whenever customId starts with "ams_".
 *
 * Routes by interaction type and customId:
 *   StringSelectMenu → ams_menu or ams_action_select
 *   RoleSelectMenu   → ams_role_select
 *   Button           → ams_create_role_btn
 *   ModalSubmit      → ams_modal_*
 *
 * @param {import('discord.js').Interaction} interaction
 */
async function handleAutoModSetupInteraction(interaction) {
	const guildId = interaction.guild.id

	try {
		// ── Select Menu: main options ─────────────────────────────────────────
		if (interaction.isStringSelectMenu() && interaction.customId === MENU_ID) {
			const selected = interaction.values[0]

			if (selected === "banned_words") return await showBannedWordsModal(interaction)
			if (selected === "spam") return await showSpamModal(interaction)
			if (selected === "mute_role") return await showMuteRoleSelect(interaction)
			if (selected === "action") return await showActionSelect(interaction)
			if (selected === "log_channel") return await showLogChannelModal(interaction)
			if (selected === "exempt_role") return await showExemptRoleModal(interaction)
			if (selected === "toggle") return await handleToggle(interaction, guildId)
		}

		// ── Select Menu: action picker ────────────────────────────────────────
		if (interaction.isStringSelectMenu() && interaction.customId === ACTION_SELECT_ID) {
			return await handleActionSelect(interaction, guildId)
		}

		// ── RoleSelectMenu: mute role picker ──────────────────────────────────
		if (interaction.isRoleSelectMenu() && interaction.customId === ROLE_SELECT_ID) {
			return await handleMuteRoleSelect(interaction, guildId)
		}

		// ── Button: open "create role" modal ──────────────────────────────────
		if (interaction.isButton() && interaction.customId === CREATE_ROLE_BTN_ID) {
			return await showCreateRoleModal(interaction)
		}

		// ── Modal submissions ─────────────────────────────────────────────────
		if (interaction.isModalSubmit()) {
			if (interaction.customId === MODAL_BANNED_WORDS)
				return await handleBannedWordsModal(interaction, guildId)
			if (interaction.customId === MODAL_SPAM)
				return await handleSpamModal(interaction, guildId)
			if (interaction.customId === MODAL_LOG_CHANNEL)
				return await handleLogChannelModal(interaction, guildId)
			if (interaction.customId === MODAL_EXEMPT_ROLE)
				return await handleExemptRoleModal(interaction, guildId)
			if (interaction.customId === MODAL_CREATE_ROLE)
				return await handleCreateRoleModal(interaction, guildId)
		}
	} catch (error) {
		console.error("[AutoMod Setup] Interaction error:", error)

		const payload = { content: "An error occurred. Please try again.", flags: MessageFlags.Ephemeral }

		if (interaction.replied || interaction.deferred) {
			return interaction.followUp(payload).catch(() => null)
		}

		return interaction.reply(payload).catch(() => null)
	}
}

// ─── UI builders ──────────────────────────────────────────────────────────────

/**
 * Builds the setup panel embed showing the current AutoMod configuration.
 * Updated and re-sent after every setting change so the admin always
 * sees the current state without running a separate status command.
 *
 * @param {import('mongoose').Document} config  GuildConfig document
 * @returns {EmbedBuilder}
 */
function buildSetupEmbed(config) {
	const am = config.autoMod

	const bannedList =
		am.bannedWords.length > 0
			? am.bannedWords.map(w => `\`${w}\``).join(", ")
			: "None"

	const spamInfo =
		am.maxMessagesPerWindow > 0
			? `${am.maxMessagesPerWindow} msgs / ${am.spamWindowMs / 1_000}s`
			: "Disabled"

	const exemptRoles =
		am.exemptRoleIds.length > 0
			? am.exemptRoleIds.map(id => `<@&${id}>`).join(", ")
			: "None"

	return new EmbedBuilder()
		.setTitle("⚙️ AutoMod Setup Panel")
		.setDescription(
			"Use the menu below to configure each AutoMod setting.\nChanges take effect immediately.",
		)
		.setColor(am.enabled ? 0x57f287 : 0x95a5a6) // Green when enabled, grey when off
		.addFields(
			{
				name: "Status",
				value: am.enabled ? "✅ Enabled" : "❌ Disabled",
				inline: true,
			},
			{
				name: "Action",
				value: am.action.toUpperCase(),
				inline: true,
			},
			{
				name: "Mute Role",
				value: am.muteRoleId ? `<@&${am.muteRoleId}>` : "Not set",
				inline: true,
			},
			{
				name: "Banned Words",
				value: bannedList,
			},
			{
				name: "Spam Limit",
				value: spamInfo,
				inline: true,
			},
			{
				name: "Log Channel",
				value: am.logChannelId ? `<#${am.logChannelId}>` : "Not set",
				inline: true,
			},
			{
				name: "Exempt Roles",
				value: exemptRoles,
			},
		)
		.setFooter({ text: "AutoMod Setup • Changes are saved automatically" })
		.setTimestamp()
}

/**
 * Builds the main Select Menu with all configurable options.
 *
 * Each option maps to either a Modal or an inline handler.
 * The placeholder text guides the admin on how to use the menu.
 *
 * @returns {ActionRowBuilder}
 */
function buildMainMenu() {
	const menu = new StringSelectMenuBuilder()
		.setCustomId(MENU_ID)
		.setPlaceholder("⚙️ Select a setting to configure...")
		.addOptions(
			new StringSelectMenuOptionBuilder()
				.setLabel("Toggle AutoMod")
				.setDescription("Enable or disable the AutoMod system")
				.setValue("toggle")
				.setEmoji("🔘"),
			new StringSelectMenuOptionBuilder()
				.setLabel("Punitive Action")
				.setDescription("Set what happens when a rule is triggered")
				.setValue("action")
				.setEmoji("⚡"),
			new StringSelectMenuOptionBuilder()
				.setLabel("Banned Words")
				.setDescription("Add or remove words from the filter list")
				.setValue("banned_words")
				.setEmoji("🚫"),
			new StringSelectMenuOptionBuilder()
				.setLabel("Spam Limit")
				.setDescription("Configure anti-spam threshold and window")
				.setValue("spam")
				.setEmoji("💬"),
			new StringSelectMenuOptionBuilder()
				.setLabel("Mute Role")
				.setDescription("Pick an existing role or create a new one")
				.setValue("mute_role")
				.setEmoji("🔇"),
			new StringSelectMenuOptionBuilder()
				.setLabel("Log Channel")
				.setDescription("Set the channel for violation logs")
				.setValue("log_channel")
				.setEmoji("📋"),
			new StringSelectMenuOptionBuilder()
				.setLabel("Exempt Role")
				.setDescription("Add or remove a role from AutoMod exemptions")
				.setValue("exempt_role")
				.setEmoji("🛡️"),
		)

	return new ActionRowBuilder().addComponents(menu)
}

/**
 * Builds the action picker Select Menu (secondary menu, shown inline).
 *
 * @returns {ActionRowBuilder}
 */
function buildActionSelectMenu() {
	const menu = new StringSelectMenuBuilder()
		.setCustomId(ACTION_SELECT_ID)
		.setPlaceholder("Choose an action...")
		.addOptions(
			new StringSelectMenuOptionBuilder()
				.setLabel("Delete only")
				.setDescription("Remove the message, no punishment applied")
				.setValue("delete")
				.setEmoji("🗑️"),
			new StringSelectMenuOptionBuilder()
				.setLabel("Warn")
				.setDescription("Delete + add a warning to the user's record")
				.setValue("warn")
				.setEmoji("⚠️"),
			new StringSelectMenuOptionBuilder()
				.setLabel("Mute (Role)")
				.setDescription("Delete + apply the configured mute role")
				.setValue("mute")
				.setEmoji("🔇"),
			new StringSelectMenuOptionBuilder()
				.setLabel("Timeout")
				.setDescription("Delete + apply a Discord timeout")
				.setValue("timeout")
				.setEmoji("⏱️"),
			new StringSelectMenuOptionBuilder()
				.setLabel("Kick")
				.setDescription("Delete + kick the member from the server")
				.setValue("kick")
				.setEmoji("👢"),
			new StringSelectMenuOptionBuilder()
				.setLabel("Ban")
				.setDescription("Delete + permanently ban the member")
				.setValue("ban")
				.setEmoji("🔨"),
		)

	return new ActionRowBuilder().addComponents(menu)
}

/**
 * Builds the RoleSelectMenu row for picking an existing role as mute role.
 *
 * @returns {ActionRowBuilder}
 */
function buildMuteRoleSelectMenu() {
	const roleSelect = new RoleSelectMenuBuilder()
		.setCustomId(ROLE_SELECT_ID)
		.setPlaceholder("🔇 Select the mute role...")

	return new ActionRowBuilder().addComponents(roleSelect)
}

/**
 * Builds the "Create new role" button row shown alongside the RoleSelectMenu.
 * Gives the admin an alternative if the mute role doesn't exist yet.
 *
 * @returns {ActionRowBuilder}
 */
function buildCreateRoleButton() {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(CREATE_ROLE_BTN_ID)
			.setLabel("➕ Create New Mute Role")
			.setStyle(ButtonStyle.Secondary),
	)
}

// ─── Modal openers ────────────────────────────────────────────────────────────

/**
 * Shows the banned words configuration modal.
 *
 * The modal presents two text inputs:
 *   - "Add" field: comma-separated words to add
 *   - "Remove" field: comma-separated words to remove
 *
 * Both fields are optional — leaving one blank skips that operation.
 * This design avoids needing two separate modals for add vs remove.
 */
async function showBannedWordsModal(interaction) {
	const modal = new ModalBuilder()
		.setCustomId(MODAL_BANNED_WORDS)
		.setTitle("Configure Banned Words")

	const addInput = new TextInputBuilder()
		.setCustomId("add_words")
		.setLabel("Words to ADD (comma-separated)")
		.setStyle(TextInputStyle.Paragraph)
		.setPlaceholder("spam, badword, example phrase")
		.setRequired(false)

	const removeInput = new TextInputBuilder()
		.setCustomId("remove_words")
		.setLabel("Words to REMOVE (comma-separated)")
		.setStyle(TextInputStyle.Paragraph)
		.setPlaceholder("word1, word2")
		.setRequired(false)

	modal.addComponents(
		new ActionRowBuilder().addComponents(addInput),
		new ActionRowBuilder().addComponents(removeInput),
	)

	await interaction.showModal(modal)
}

/** Shows the spam limit configuration modal. */
async function showSpamModal(interaction) {
	const modal = new ModalBuilder()
		.setCustomId(MODAL_SPAM)
		.setTitle("Configure Spam Detection")

	const maxMsgsInput = new TextInputBuilder()
		.setCustomId("max_messages")
		.setLabel("Max messages per window (0 = disabled)")
		.setStyle(TextInputStyle.Short)
		.setPlaceholder("5")
		.setMinLength(1)
		.setMaxLength(3)
		.setRequired(true)

	const windowInput = new TextInputBuilder()
		.setCustomId("window_seconds")
		.setLabel("Window duration (seconds)")
		.setStyle(TextInputStyle.Short)
		.setPlaceholder("5")
		.setMinLength(1)
		.setMaxLength(4)
		.setRequired(true)

	modal.addComponents(
		new ActionRowBuilder().addComponents(maxMsgsInput),
		new ActionRowBuilder().addComponents(windowInput),
	)

	await interaction.showModal(modal)
}

/**
 * Shows a RoleSelectMenu so the admin can pick an existing role as mute role,
 * plus a "Create New Mute Role" button for when no suitable role exists yet.
 *
 * Why two components?
 *   Discord's RoleSelectMenu only shows existing roles. If the server doesn't
 *   have a mute role yet, the admin needs another path. The button opens a
 *   small modal that only asks for the new role's name — the bot handles
 *   creation and channel overrides automatically.
 */
async function showMuteRoleSelect(interaction) {
	await interaction.reply({
		content:
			"Pick an existing role to use as the mute role, or create a new one:",
		components: [buildMuteRoleSelectMenu(), buildCreateRoleButton()],
		flags: MessageFlags.Ephemeral,
	})
}

/** Shows the log channel configuration modal. */
async function showLogChannelModal(interaction) {
	const modal = new ModalBuilder()
		.setCustomId(MODAL_LOG_CHANNEL)
		.setTitle("Configure Log Channel")

	const channelInput = new TextInputBuilder()
		.setCustomId("channel_id")
		.setLabel("Channel ID")
		.setStyle(TextInputStyle.Short)
		.setPlaceholder("123456789012345678")
		.setRequired(true)

	modal.addComponents(new ActionRowBuilder().addComponents(channelInput))

	await interaction.showModal(modal)
}

/** Shows the exempt role configuration modal. */
async function showExemptRoleModal(interaction) {
	const modal = new ModalBuilder()
		.setCustomId(MODAL_EXEMPT_ROLE)
		.setTitle("Configure Exempt Role")

	const roleInput = new TextInputBuilder()
		.setCustomId("role_id")
		.setLabel("Role ID")
		.setStyle(TextInputStyle.Short)
		.setPlaceholder("123456789012345678")
		.setRequired(true)

	const operationInput = new TextInputBuilder()
		.setCustomId("operation")
		.setLabel("Operation: type  add  or  remove")
		.setStyle(TextInputStyle.Short)
		.setPlaceholder("add")
		.setRequired(true)

	modal.addComponents(
		new ActionRowBuilder().addComponents(roleInput),
		new ActionRowBuilder().addComponents(operationInput),
	)

	await interaction.showModal(modal)
}

/**
 * Shows a small modal that asks only for the new role's name.
 * The bot handles role creation and channel overrides automatically
 * when the modal is submitted.
 */
async function showCreateRoleModal(interaction) {
	const modal = new ModalBuilder()
		.setCustomId(MODAL_CREATE_ROLE)
		.setTitle("Create Mute Role")

	const roleNameInput = new TextInputBuilder()
		.setCustomId("role_name")
		.setLabel("New role name")
		.setStyle(TextInputStyle.Short)
		.setPlaceholder("Muted")
		.setMaxLength(100)
		.setRequired(true)

	modal.addComponents(new ActionRowBuilder().addComponents(roleNameInput))

	await interaction.showModal(modal)
}

/** Shows the action picker as a second Select Menu (inline, no modal needed). */
async function showActionSelect(interaction) {
	await interaction.reply({
		content: "Choose the action AutoMod will apply when a rule is triggered:",
		components: [buildActionSelectMenu()],
		flags: MessageFlags.Ephemeral,
	})
}

// ─── Interaction handlers ─────────────────────────────────────────────────────

/**
 * Toggles AutoMod enabled state and refreshes the setup panel.
 *
 * Uses update() on the Select Menu interaction to edit the original
 * panel message in-place — no new message is created.
 */
async function handleToggle(interaction, guildId) {
	const config = await GuildConfig.getOrCreate(guildId)
	config.autoMod.enabled = !config.autoMod.enabled
	await config.save()
	autoMod.invalidateCache(guildId)

	const newState = config.autoMod.enabled ? "enabled ✅" : "disabled ❌"

	await interaction.update({
		embeds: [buildSetupEmbed(config)],
		components: [buildMainMenu()],
		content: `AutoMod is now **${newState}**.`,
	})
}

/** Handles the action Select Menu submission. */
async function handleActionSelect(interaction, guildId) {
	const action = interaction.values[0]
	const config = await GuildConfig.getOrCreate(guildId)
	config.autoMod.action = action
	await config.save()
	autoMod.invalidateCache(guildId)

	await interaction.update({
		content: `✅ Action set to **${action.toUpperCase()}**.`,
		components: [],
	})
}

/**
 * Handles the RoleSelectMenu submission for mute role.
 *
 * The selected role is saved directly to config — no creation needed.
 * interaction.roles is a Collection of the selected roles; we take the first.
 */
async function handleMuteRoleSelect(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const role = interaction.roles.first()

	if (!role) {
		return interaction.editReply({ content: "❌ No role selected." })
	}

	const config = await GuildConfig.getOrCreate(guildId)
	config.autoMod.muteRoleId = role.id
	await config.save()
	autoMod.invalidateCache(guildId)

	await interaction.editReply({
		content: `✅ Mute role set to ${role} (\`${role.name}\`).`,
	})
}

/**
 * Handles the "create role" modal submission.
 *
 * Creates a new role with the given name, applies channel permission
 * overrides in all text channels to deny sending messages, then saves
 * the new role's ID to config.
 *
 * Why apply overrides on creation?
 * Discord roles with denied permissions must have explicit channel-level
 * overrides to take effect. Iterating all text channels on creation is a
 * one-time cost that ensures the role works immediately in all channels.
 */
async function handleCreateRoleModal(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const roleName = interaction.fields.getTextInputValue("role_name").trim()
	const { guild } = interaction

	const muteRole = await guild.roles.create({
		name: roleName,
		color: 0x2b2d31,
		reason: "AutoMod mute role — created automatically by setup panel",
	})

	// Apply channel overrides in all text-based channels
	const { PermissionFlagsBits } = require("discord.js")
	const textChannels = guild.channels.cache.filter(c => c.isTextBased())

	for (const [, channel] of textChannels) {
		await channel.permissionOverwrites
			.create(muteRole, {
				SendMessages: false,
				AddReactions: false,
				CreatePublicThreads: false,
				CreatePrivateThreads: false,
			})
			.catch(() => null) // Non-fatal — some channels may lack permission
	}

	const config = await GuildConfig.getOrCreate(guildId)
	config.autoMod.muteRoleId = muteRole.id
	await config.save()
	autoMod.invalidateCache(guildId)

	await interaction.editReply({
		content: `✅ Created and saved mute role: ${muteRole} (\`${muteRole.name}\`). Channel overrides applied.`,
	})
}

/**
 * Processes the banned words modal submission.
 *
 * Parsing logic:
 *   - Split each field by comma
 *   - Trim and lowercase each entry
 *   - Filter empty strings (from trailing commas or blank lines)
 *   - Add: skip duplicates
 *   - Remove: skip entries not in the list (no-op with feedback)
 */
async function handleBannedWordsModal(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const addRaw = interaction.fields.getTextInputValue("add_words")
	const removeRaw = interaction.fields.getTextInputValue("remove_words")

	const config = await GuildConfig.getOrCreate(guildId)
	const results = []

	// Process additions
	if (addRaw.trim()) {
		const toAdd = addRaw
			.split(",")
			.map(w => w.trim().toLowerCase())
			.filter(Boolean)

		for (const word of toAdd) {
			if (config.autoMod.bannedWords.includes(word)) {
				results.push(`⚠️ \`${word}\` already in list`)
			} else {
				config.autoMod.bannedWords.push(word)
				results.push(`✅ Added \`${word}\``)
			}
		}
	}

	// Process removals
	if (removeRaw.trim()) {
		const toRemove = removeRaw
			.split(",")
			.map(w => w.trim().toLowerCase())
			.filter(Boolean)

		for (const word of toRemove) {
			const index = config.autoMod.bannedWords.indexOf(word)
			if (index === -1) {
				results.push(`❌ \`${word}\` not found`)
			} else {
				config.autoMod.bannedWords.splice(index, 1)
				results.push(`🗑️ Removed \`${word}\``)
			}
		}
	}

	if (results.length === 0) {
		return interaction.editReply({ content: "No changes were made (both fields were empty)." })
	}

	await config.save()
	autoMod.invalidateCache(guildId)

	await interaction.editReply({ content: results.join("\n") })
}

/** Processes the spam limit modal submission. */
async function handleSpamModal(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const maxMessages = Number.parseInt(
		interaction.fields.getTextInputValue("max_messages"),
		10,
	)
	const windowSeconds = Number.parseInt(
		interaction.fields.getTextInputValue("window_seconds"),
		10,
	)

	if (Number.isNaN(maxMessages) || Number.isNaN(windowSeconds)) {
		return interaction.editReply({ content: "❌ Both values must be valid numbers." })
	}

	if (windowSeconds < 1 || windowSeconds > 60) {
		return interaction.editReply({ content: "❌ Window must be between 1 and 60 seconds." })
	}

	const config = await GuildConfig.getOrCreate(guildId)
	config.autoMod.maxMessagesPerWindow = maxMessages
	config.autoMod.spamWindowMs = windowSeconds * 1_000
	await config.save()
	autoMod.invalidateCache(guildId)

	const msg =
		maxMessages === 0
			? "✅ Spam detection disabled."
			: `✅ Spam limit set to **${maxMessages} messages** per **${windowSeconds}s**.`

	await interaction.editReply({ content: msg })
}

/** Processes the log channel modal submission. */
async function handleLogChannelModal(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const channelId = interaction.fields
		.getTextInputValue("channel_id")
		.trim()
		.replace(/[<#>]/g, "") // Strip mention formatting if pasted as #channel

	const channel =
		interaction.guild.channels.cache.get(channelId) ??
		(await interaction.guild.channels.fetch(channelId).catch(() => null))

	if (!channel?.isTextBased()) {
		return interaction.editReply({
			content: "❌ Channel not found or is not a text channel. Make sure you entered the correct ID.",
		})
	}

	const config = await GuildConfig.getOrCreate(guildId)
	config.autoMod.logChannelId = channel.id
	await config.save()
	autoMod.invalidateCache(guildId)

	await interaction.editReply({
		content: `✅ AutoMod violation logs will be posted in ${channel}.`,
	})
}

/** Processes the exempt role modal submission. */
async function handleExemptRoleModal(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const roleId = interaction.fields.getTextInputValue("role_id").trim()
	const operation = interaction.fields
		.getTextInputValue("operation")
		.trim()
		.toLowerCase()

	if (operation !== "add" && operation !== "remove") {
		return interaction.editReply({
			content: '❌ Operation must be exactly `add` or `remove`.',
		})
	}

	const role =
		interaction.guild.roles.cache.get(roleId) ??
		(await interaction.guild.roles.fetch(roleId).catch(() => null))

	if (!role) {
		return interaction.editReply({
			content: "❌ Role not found. Make sure you entered a valid role ID.",
		})
	}

	const config = await GuildConfig.getOrCreate(guildId)

	if (operation === "add") {
		if (config.autoMod.exemptRoleIds.includes(role.id)) {
			return interaction.editReply({ content: `⚠️ ${role} is already exempt.` })
		}
		config.autoMod.exemptRoleIds.push(role.id)
		await config.save()
		autoMod.invalidateCache(guildId)
		return interaction.editReply({ content: `✅ ${role} is now exempt from AutoMod.` })
	}

	const index = config.autoMod.exemptRoleIds.indexOf(role.id)
	if (index === -1) {
		return interaction.editReply({ content: `⚠️ ${role} is not in the exemption list.` })
	}
	config.autoMod.exemptRoleIds.splice(index, 1)
	await config.save()
	autoMod.invalidateCache(guildId)
	return interaction.editReply({ content: `✅ ${role} removed from AutoMod exemptions.` })
}