/**
 * @file automod-setup.js
 * @description Interactive AutoMod configuration panel using Select Menus and Modals.
 *
 * ─── Interaction flow ────────────────────────────────────────────────────────
 * /automod-setup
 *   └─ Sends the setup embed with a Select Menu
 *        ├─ "Toggle"        → inline enable/disable
 *        ├─ "Action"        → StringSelectMenu (delete/warn/mute/timeout/kick/ban)
 *        ├─ "Banned Words"  → Modal (add / remove words)
 *        ├─ "Spam Limit"    → Modal (max messages + window seconds)
 *        ├─ "Mute Role"     → RoleSelectMenu + "➕ Create Role" button → Modal
 *        ├─ "Log Channel"   → ChannelSelectMenu + "➕ Create Channel" button → Modal
 *        └─ "Exempt Role"   → RoleSelectMenu + "➕ Add" / "➖ Remove" buttons
 *
 * ─── Component ID conventions ────────────────────────────────────────────────
 *   ams_menu                — main StringSelectMenu
 *   ams_action_select       — action StringSelectMenu
 *   ams_mute_role_select    — RoleSelectMenu for mute role
 *   ams_create_role_btn     — button → create-role modal
 *   ams_log_channel_select  — ChannelSelectMenu for log channel
 *   ams_create_channel_btn  — button → create-channel modal
 *   ams_exempt_role_select  — RoleSelectMenu for exempt roles
 *   ams_exempt_add_btn      — button → confirm add selected exempt role
 *   ams_exempt_remove_btn   — button → confirm remove selected exempt role
 *   ams_modal_banned_words  — modal
 *   ams_modal_spam          — modal
 *   ams_modal_create_role   — modal
 *   ams_modal_create_channel— modal
 */

const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelSelectMenuBuilder,
	ChannelType,
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

const MENU_ID               = "ams_menu"
const ACTION_SELECT_ID      = "ams_action_select"
const MUTE_ROLE_SELECT_ID   = "ams_mute_role_select"
const CREATE_ROLE_BTN_ID    = "ams_create_role_btn"
const LOG_CHANNEL_SELECT_ID = "ams_log_channel_select"
const CREATE_CHANNEL_BTN_ID = "ams_create_channel_btn"
const EXEMPT_ROLE_SELECT_ID = "ams_exempt_role_select"
const EXEMPT_ADD_BTN_ID     = "ams_exempt_add_btn"
const EXEMPT_REMOVE_BTN_ID  = "ams_exempt_remove_btn"

const MODAL_BANNED_WORDS    = "ams_modal_banned_words"
const MODAL_SPAM            = "ams_modal_spam"
const MODAL_CREATE_ROLE     = "ams_modal_create_role"
const MODAL_CREATE_CHANNEL  = "ams_modal_create_channel"

// Temporary in-memory store for the exempt role selected before add/remove
// keyed by userId so concurrent admins don't collide
const pendingExemptRole = new Map()

// ─── Module export ────────────────────────────────────────────────────────────

module.exports = {
	data: new SlashCommandBuilder()
		.setName("automod-setup")
		.setDescription("Open the interactive AutoMod configuration panel.")
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

	async execute(interaction) {
		const config = await GuildConfig.getOrCreate(interaction.guild.id)
		await interaction.reply({
			embeds: [buildSetupEmbed(config)],
			components: [buildMainMenu()],
			flags: MessageFlags.Ephemeral,
		})
	},

	handleAutoModSetupInteraction,
}

// ─── Interaction router ───────────────────────────────────────────────────────

async function handleAutoModSetupInteraction(interaction) {
	const guildId = interaction.guild.id

	try {
		// ── Main menu ─────────────────────────────────────────────────────────
		if (interaction.isStringSelectMenu() && interaction.customId === MENU_ID) {
			const selected = interaction.values[0]
			if (selected === "toggle")       return await handleToggle(interaction, guildId)
			if (selected === "action")       return await showActionSelect(interaction)
			if (selected === "banned_words") return await showBannedWordsModal(interaction)
			if (selected === "spam")         return await showSpamModal(interaction)
			if (selected === "mute_role")    return await showMuteRoleSelect(interaction)
			if (selected === "log_channel")  return await showLogChannelSelect(interaction)
			if (selected === "exempt_role")  return await showExemptRoleSelect(interaction)
		}

		// ── Action picker ─────────────────────────────────────────────────────
		if (interaction.isStringSelectMenu() && interaction.customId === ACTION_SELECT_ID) {
			return await handleActionSelect(interaction, guildId)
		}

		// ── Mute role select ──────────────────────────────────────────────────
		if (interaction.isRoleSelectMenu() && interaction.customId === MUTE_ROLE_SELECT_ID) {
			return await handleMuteRoleSelect(interaction, guildId)
		}

		// ── Create role button ────────────────────────────────────────────────
		if (interaction.isButton() && interaction.customId === CREATE_ROLE_BTN_ID) {
			return await showCreateRoleModal(interaction)
		}

		// ── Log channel select ────────────────────────────────────────────────
		if (interaction.isChannelSelectMenu() && interaction.customId === LOG_CHANNEL_SELECT_ID) {
			return await handleLogChannelSelect(interaction, guildId)
		}

		// ── Create channel button ─────────────────────────────────────────────
		if (interaction.isButton() && interaction.customId === CREATE_CHANNEL_BTN_ID) {
			return await showCreateChannelModal(interaction)
		}

		// ── Exempt role select ────────────────────────────────────────────────
		if (interaction.isRoleSelectMenu() && interaction.customId === EXEMPT_ROLE_SELECT_ID) {
			return await handleExemptRoleSelect(interaction)
		}

		// ── Exempt add / remove buttons ───────────────────────────────────────
		if (interaction.isButton() && interaction.customId === EXEMPT_ADD_BTN_ID) {
			return await handleExemptConfirm(interaction, guildId, "add")
		}
		if (interaction.isButton() && interaction.customId === EXEMPT_REMOVE_BTN_ID) {
			return await handleExemptConfirm(interaction, guildId, "remove")
		}

		// ── Modal submissions ─────────────────────────────────────────────────
		if (interaction.isModalSubmit()) {
			if (interaction.customId === MODAL_BANNED_WORDS)
				return await handleBannedWordsModal(interaction, guildId)
			if (interaction.customId === MODAL_SPAM)
				return await handleSpamModal(interaction, guildId)
			if (interaction.customId === MODAL_CREATE_ROLE)
				return await handleCreateRoleModal(interaction, guildId)
			if (interaction.customId === MODAL_CREATE_CHANNEL)
				return await handleCreateChannelModal(interaction, guildId)
		}
	} catch (error) {
		console.error("[AutoMod Setup] Interaction error:", error)
		const payload = { content: "An error occurred. Please try again.", flags: MessageFlags.Ephemeral }
		if (interaction.replied || interaction.deferred) return interaction.followUp(payload).catch(() => null)
		return interaction.reply(payload).catch(() => null)
	}
}

// ─── UI builders ──────────────────────────────────────────────────────────────

function buildSetupEmbed(config) {
	const am = config.autoMod

	const bannedList = am.bannedWords.length > 0
		? am.bannedWords.map(w => `\`${w}\``).join(", ")
		: "None"

	const spamInfo = am.maxMessagesPerWindow > 0
		? `${am.maxMessagesPerWindow} msgs / ${am.spamWindowMs / 1_000}s`
		: "Disabled"

	const exemptRoles = am.exemptRoleIds.length > 0
		? am.exemptRoleIds.map(id => `<@&${id}>`).join(", ")
		: "None"

	return new EmbedBuilder()
		.setTitle("⚙️ AutoMod Setup Panel")
		.setDescription("Use the menu below to configure each AutoMod setting.\nChanges take effect immediately.")
		.setColor(am.enabled ? 0x57f287 : 0x95a5a6)
		.addFields(
			{ name: "Status",       value: am.enabled ? "✅ Enabled" : "❌ Disabled", inline: true },
			{ name: "Action",       value: am.action.toUpperCase(),                   inline: true },
			{ name: "Mute Role",    value: am.muteRoleId ? `<@&${am.muteRoleId}>` : "Not set", inline: true },
			{ name: "Banned Words", value: bannedList },
			{ name: "Spam Limit",   value: spamInfo,   inline: true },
			{ name: "Log Channel",  value: am.logChannelId ? `<#${am.logChannelId}>` : "Not set", inline: true },
			{ name: "Exempt Roles", value: exemptRoles },
		)
		.setFooter({ text: "AutoMod Setup • Changes are saved automatically" })
		.setTimestamp()
}

function buildMainMenu() {
	return new ActionRowBuilder().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(MENU_ID)
			.setPlaceholder("⚙️ Select a setting to configure...")
			.addOptions(
				new StringSelectMenuOptionBuilder().setLabel("Toggle AutoMod").setDescription("Enable or disable the AutoMod system").setValue("toggle").setEmoji("🔘"),
				new StringSelectMenuOptionBuilder().setLabel("Punitive Action").setDescription("Set what happens when a rule is triggered").setValue("action").setEmoji("⚡"),
				new StringSelectMenuOptionBuilder().setLabel("Banned Words").setDescription("Add or remove words from the filter list").setValue("banned_words").setEmoji("🚫"),
				new StringSelectMenuOptionBuilder().setLabel("Spam Limit").setDescription("Configure anti-spam threshold and window").setValue("spam").setEmoji("💬"),
				new StringSelectMenuOptionBuilder().setLabel("Mute Role").setDescription("Pick an existing role or create a new one").setValue("mute_role").setEmoji("🔇"),
				new StringSelectMenuOptionBuilder().setLabel("Log Channel").setDescription("Pick an existing channel or create a new one").setValue("log_channel").setEmoji("📋"),
				new StringSelectMenuOptionBuilder().setLabel("Exempt Role").setDescription("Add or remove a role from AutoMod exemptions").setValue("exempt_role").setEmoji("🛡️"),
			)
	)
}

function buildActionSelectMenu() {
	return new ActionRowBuilder().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(ACTION_SELECT_ID)
			.setPlaceholder("Choose an action...")
			.addOptions(
				new StringSelectMenuOptionBuilder().setLabel("Delete only").setDescription("Remove the message, no punishment").setValue("delete").setEmoji("🗑️"),
				new StringSelectMenuOptionBuilder().setLabel("Warn").setDescription("Delete + add a warning to the user's record").setValue("warn").setEmoji("⚠️"),
				new StringSelectMenuOptionBuilder().setLabel("Mute (Role)").setDescription("Delete + apply the configured mute role").setValue("mute").setEmoji("🔇"),
				new StringSelectMenuOptionBuilder().setLabel("Timeout").setDescription("Delete + apply a Discord timeout").setValue("timeout").setEmoji("⏱️"),
				new StringSelectMenuOptionBuilder().setLabel("Kick").setDescription("Delete + kick the member from the server").setValue("kick").setEmoji("👢"),
				new StringSelectMenuOptionBuilder().setLabel("Ban").setDescription("Delete + permanently ban the member").setValue("ban").setEmoji("🔨"),
			)
	)
}

// ─── Mute role UI ─────────────────────────────────────────────────────────────

async function showMuteRoleSelect(interaction) {
	await interaction.reply({
		content: "Pick an existing role to use as the mute role, or create a new one:",
		components: [
			new ActionRowBuilder().addComponents(
				new RoleSelectMenuBuilder()
					.setCustomId(MUTE_ROLE_SELECT_ID)
					.setPlaceholder("🔇 Select the mute role...")
			),
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(CREATE_ROLE_BTN_ID)
					.setLabel("➕ Create New Mute Role")
					.setStyle(ButtonStyle.Secondary)
			),
		],
		flags: MessageFlags.Ephemeral,
	})
}

async function handleMuteRoleSelect(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })
	const role = interaction.roles.first()
	if (!role) return interaction.editReply({ content: "❌ No role selected." })

	const config = await GuildConfig.getOrCreate(guildId)
	config.autoMod.muteRoleId = role.id
	await config.save()
	autoMod.invalidateCache(guildId)

	await interaction.editReply({ content: `✅ Mute role set to ${role} (\`${role.name}\`).` })
	await resetMainPanel(interaction, config)
}

async function showCreateRoleModal(interaction) {
	await interaction.showModal(
		new ModalBuilder()
			.setCustomId(MODAL_CREATE_ROLE)
			.setTitle("Create Mute Role")
			.addComponents(
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId("role_name")
						.setLabel("New role name")
						.setStyle(TextInputStyle.Short)
						.setPlaceholder("Muted")
						.setMaxLength(100)
						.setRequired(true)
				)
			)
	)
}

async function handleCreateRoleModal(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })
	const roleName = interaction.fields.getTextInputValue("role_name").trim()
	const { guild } = interaction

	const muteRole = await guild.roles.create({
		name: roleName,
		color: 0x2b2d31,
		reason: "AutoMod mute role — created automatically by setup panel",
	})

	const textChannels = guild.channels.cache.filter(c => c.isTextBased())
	for (const [, channel] of textChannels) {
		await channel.permissionOverwrites.create(muteRole, {
			SendMessages: false,
			AddReactions: false,
			CreatePublicThreads: false,
			CreatePrivateThreads: false,
		}).catch(() => null)
	}

	const config = await GuildConfig.getOrCreate(guildId)
	config.autoMod.muteRoleId = muteRole.id
	await config.save()
	autoMod.invalidateCache(guildId)

	await interaction.editReply({
		content: `✅ Created and saved mute role: ${muteRole} (\`${muteRole.name}\`). Channel overrides applied.`,
	})
	await resetMainPanel(interaction, config)
}

// ─── Log channel UI ───────────────────────────────────────────────────────────

async function showLogChannelSelect(interaction) {
	await interaction.reply({
		content: "Pick an existing channel for AutoMod violation logs, or create a new one:",
		components: [
			new ActionRowBuilder().addComponents(
				new ChannelSelectMenuBuilder()
					.setCustomId(LOG_CHANNEL_SELECT_ID)
					.setPlaceholder("📋 Select the log channel...")
					.setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
			),
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(CREATE_CHANNEL_BTN_ID)
					.setLabel("➕ Create New Log Channel")
					.setStyle(ButtonStyle.Secondary)
			),
		],
		flags: MessageFlags.Ephemeral,
	})
}

async function handleLogChannelSelect(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })
	const channel = interaction.channels.first()
	if (!channel) return interaction.editReply({ content: "❌ No channel selected." })

	const config = await GuildConfig.getOrCreate(guildId)
	config.autoMod.logChannelId = channel.id
	await config.save()
	autoMod.invalidateCache(guildId)

	await interaction.editReply({ content: `✅ AutoMod violation logs will be posted in ${channel}.` })
	await resetMainPanel(interaction, config)
}

async function showCreateChannelModal(interaction) {
	await interaction.showModal(
		new ModalBuilder()
			.setCustomId(MODAL_CREATE_CHANNEL)
			.setTitle("Create Log Channel")
			.addComponents(
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId("channel_name")
						.setLabel("New channel name")
						.setStyle(TextInputStyle.Short)
						.setPlaceholder("automod-logs")
						.setMaxLength(100)
						.setRequired(true)
				)
			)
	)
}

async function handleCreateChannelModal(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })
	const channelName = interaction.fields.getTextInputValue("channel_name").trim()
		.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 100)

	const { guild } = interaction

	const logChannel = await guild.channels.create({
		name: channelName,
		type: ChannelType.GuildText,
		permissionOverwrites: [
			{
				id: guild.id, // @everyone can't send
				deny: [PermissionFlagsBits.SendMessages],
				allow: [PermissionFlagsBits.ViewChannel],
			},
			{
				id: interaction.client.user.id,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
			},
		],
		reason: "AutoMod log channel — created automatically by setup panel",
	})

	const config = await GuildConfig.getOrCreate(guildId)
	config.autoMod.logChannelId = logChannel.id
	await config.save()
	autoMod.invalidateCache(guildId)

	await interaction.editReply({ content: `✅ Created log channel ${logChannel} and saved.` })
	await resetMainPanel(interaction, config)
}

// ─── Exempt role UI ───────────────────────────────────────────────────────────

async function showExemptRoleSelect(interaction) {
	await interaction.reply({
		content: "Select a role, then choose to add or remove it from the exemption list:",
		components: [
			new ActionRowBuilder().addComponents(
				new RoleSelectMenuBuilder()
					.setCustomId(EXEMPT_ROLE_SELECT_ID)
					.setPlaceholder("🛡️ Select a role...")
			),
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(EXEMPT_ADD_BTN_ID)
					.setLabel("✅ Add to Exemptions")
					.setStyle(ButtonStyle.Success),
				new ButtonBuilder()
					.setCustomId(EXEMPT_REMOVE_BTN_ID)
					.setLabel("🗑️ Remove from Exemptions")
					.setStyle(ButtonStyle.Danger),
			),
		],
		flags: MessageFlags.Ephemeral,
	})
}

/**
 * When the RoleSelectMenu is used, store the selected role ID temporarily.
 * The user then clicks Add or Remove to confirm the operation.
 */
async function handleExemptRoleSelect(interaction) {
	const role = interaction.roles.first()
	if (!role) return interaction.reply({ content: "❌ No role selected.", flags: MessageFlags.Ephemeral })

	// Store temporarily keyed by user ID
	pendingExemptRole.set(interaction.user.id, role.id)

	await interaction.reply({
		content: `Role ${role} selected. Now click **Add** or **Remove** below.`,
		flags: MessageFlags.Ephemeral,
	})
}

/**
 * Handles the Add or Remove button after the admin selects a role.
 */
async function handleExemptConfirm(interaction, guildId, operation) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const roleId = pendingExemptRole.get(interaction.user.id)
	if (!roleId) {
		return interaction.editReply({ content: "❌ No role selected. Please select a role first using the dropdown above." })
	}

	const role = interaction.guild.roles.cache.get(roleId)
		?? await interaction.guild.roles.fetch(roleId).catch(() => null)

	if (!role) {
		return interaction.editReply({ content: "❌ The previously selected role could not be found." })
	}

	const config = await GuildConfig.getOrCreate(guildId)

	if (operation === "add") {
		if (config.autoMod.exemptRoleIds.includes(role.id)) {
			return interaction.editReply({ content: `⚠️ ${role} is already exempt.` })
		}
		config.autoMod.exemptRoleIds.push(role.id)
		await config.save()
		autoMod.invalidateCache(guildId)
		pendingExemptRole.delete(interaction.user.id)
		await interaction.editReply({ content: `✅ ${role} is now exempt from AutoMod.` })
		await interaction.message?.edit({ content: `✅ ${role} added to exemptions.`, components: [] }).catch(() => null)
		return
	}

	// remove
	const index = config.autoMod.exemptRoleIds.indexOf(role.id)
	if (index === -1) {
		return interaction.editReply({ content: `⚠️ ${role} is not in the exemption list.` })
	}
	config.autoMod.exemptRoleIds.splice(index, 1)
	await config.save()
	autoMod.invalidateCache(guildId)
	pendingExemptRole.delete(interaction.user.id)
	await interaction.editReply({ content: `✅ ${role} removed from AutoMod exemptions.` })
	await interaction.message?.edit({ content: `✅ ${role} removed from exemptions.`, components: [] }).catch(() => null)
}

// ─── Other handlers ───────────────────────────────────────────────────────────

// ─── Helper: reset the panel message back to the main menu ────────────────────

/**
 * Edits the original setup panel message to restore the main menu,
 * clearing any sub-panel selection state so the same option can be
 * picked again. Call this after any handler that sends a separate
 * ephemeral reply (deferReply / reply) instead of update().
 *
 * @param {import('discord.js').MessageComponentInteraction} interaction
 * @param {object} config - fresh GuildConfig document
 */
async function resetMainPanel(interaction, config) {
	await interaction.message?.edit({
		content: "",
		embeds: [buildSetupEmbed(config)],
		components: [buildMainMenu()],
	}).catch(() => null)
}

async function handleToggle(interaction, guildId) {
	const config = await GuildConfig.getOrCreate(guildId)
	config.autoMod.enabled = !config.autoMod.enabled
	await config.save()
	autoMod.invalidateCache(guildId)

	await interaction.update({
		embeds: [buildSetupEmbed(config)],
		components: [buildMainMenu()],
		content: `AutoMod is now **${config.autoMod.enabled ? "enabled ✅" : "disabled ❌"}**.`,
	})
}

async function showActionSelect(interaction) {
	await interaction.reply({
		content: "Choose the action AutoMod will apply when a rule is triggered:",
		components: [buildActionSelectMenu()],
		flags: MessageFlags.Ephemeral,
	})
}

async function handleActionSelect(interaction, guildId) {
	const action = interaction.values[0]
	const config = await GuildConfig.getOrCreate(guildId)
	config.autoMod.action = action
	await config.save()
	autoMod.invalidateCache(guildId)

	await interaction.update({
		content: `✅ Action set to **${action.toUpperCase()}**.`,
		embeds: [buildSetupEmbed(config)],
		components: [buildMainMenu()],
	})
}

async function showBannedWordsModal(interaction) {
	await interaction.showModal(
		new ModalBuilder()
			.setCustomId(MODAL_BANNED_WORDS)
			.setTitle("Configure Banned Words")
			.addComponents(
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId("add_words")
						.setLabel("Words to ADD (comma-separated)")
						.setStyle(TextInputStyle.Paragraph)
						.setPlaceholder("spam, badword, example phrase")
						.setRequired(false)
				),
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId("remove_words")
						.setLabel("Words to REMOVE (comma-separated)")
						.setStyle(TextInputStyle.Paragraph)
						.setPlaceholder("word1, word2")
						.setRequired(false)
				),
			)
	)
}

async function handleBannedWordsModal(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const addRaw    = interaction.fields.getTextInputValue("add_words")
	const removeRaw = interaction.fields.getTextInputValue("remove_words")
	const config    = await GuildConfig.getOrCreate(guildId)
	const results   = []

	if (addRaw.trim()) {
		for (const word of addRaw.split(",").map(w => w.trim().toLowerCase()).filter(Boolean)) {
			if (config.autoMod.bannedWords.includes(word)) {
				results.push(`⚠️ \`${word}\` already in list`)
			} else {
				config.autoMod.bannedWords.push(word)
				results.push(`✅ Added \`${word}\``)
			}
		}
	}

	if (removeRaw.trim()) {
		for (const word of removeRaw.split(",").map(w => w.trim().toLowerCase()).filter(Boolean)) {
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
	await resetMainPanel(interaction, config)
}

async function showSpamModal(interaction) {
	await interaction.showModal(
		new ModalBuilder()
			.setCustomId(MODAL_SPAM)
			.setTitle("Configure Spam Detection")
			.addComponents(
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId("max_messages")
						.setLabel("Max messages per window (0 = disabled)")
						.setStyle(TextInputStyle.Short)
						.setPlaceholder("5")
						.setMinLength(1).setMaxLength(3)
						.setRequired(true)
				),
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId("window_seconds")
						.setLabel("Window duration (seconds)")
						.setStyle(TextInputStyle.Short)
						.setPlaceholder("5")
						.setMinLength(1).setMaxLength(4)
						.setRequired(true)
				),
			)
	)
}

async function handleSpamModal(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const maxMessages   = Number.parseInt(interaction.fields.getTextInputValue("max_messages"), 10)
	const windowSeconds = Number.parseInt(interaction.fields.getTextInputValue("window_seconds"), 10)

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

	await interaction.editReply({
		content: maxMessages === 0
			? "✅ Spam detection disabled."
			: `✅ Spam limit set to **${maxMessages} messages** per **${windowSeconds}s**.`,
	})
	await resetMainPanel(interaction, config)
}