/**
 * @file ticket-setup.js
 * @description Interactive ticket panel setup with full customization support.
 *
 * ─── Overview ────────────────────────────────────────────────────────────────
 * Two-step configuration flow:
 *
 *   Step 1 — /ticket-setup
 *     Sends an ephemeral panel to the admin with a Select Menu:
 *       • Panel Appearance  → Modal (title, description, color)
 *       • Button            → Modal (label, emoji)
 *       • Log Channel       → ChannelSelectMenu (choose from server channels)
 *
 *   Step 2 — Admin clicks "✅ Publish Panel"
 *     Posts the customized embed + ticket button publicly to the channel.
 *
 * ─── Bug fixes vs previous version ──────────────────────────────────────────
 * - handlePanelModal and handleButtonModal now call interaction.message.edit()
 *   to update the original setup panel in-place, so the preview always
 *   reflects the latest saved values without needing a separate reply.
 * - handlePublish reads config fresh from DB (not stale local reference)
 *   and calls .toObject() on the Mongoose subdocument before reading fields,
 *   preventing undefined values when ticketPanel was saved but not hydrated.
 * - Log channel selection uses ChannelSelectMenu (no ID typing needed).
 *
 * ─── Component ID conventions ────────────────────────────────────────────────
 *   tks_menu              — setup Select Menu
 *   tks_modal_panel       — panel appearance modal
 *   tks_modal_button      — button label/emoji modal
 *   tks_channel_select    — channel picker (ChannelSelectMenu)
 *   tks_publish           — publish button
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
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextInputBuilder,
	TextInputStyle,
} = require("discord.js")
const GuildConfig = require("../models/GuildConfig")

// ─── Constants ────────────────────────────────────────────────────────────────

const MENU_ID = "tks_menu"
const MODAL_PANEL = "tks_modal_panel"
const MODAL_BUTTON = "tks_modal_button"
const CHANNEL_SELECT_ID = "tks_channel_select"
const PUBLISH_BTN_ID = "tks_publish"

/** Default ticket panel appearance (used for fields not yet customized). */
const DEFAULTS = {
	title: "🎫 Support Ticket System",
	description:
		"Need help from the moderation team?\n\nClick the button below to create a private support channel.\nOnly you and the moderation team will be able to see it.",
	color: 0x5865f2,
	colorHex: "#5865F2",
	buttonLabel: "Open Ticket",
	buttonEmoji: "📩",
}

// ─── Module export ────────────────────────────────────────────────────────────

module.exports = {
	data: new SlashCommandBuilder()
		.setName("ticket-setup")
		.setDescription("Configure and publish the support ticket panel.")
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

	/**
	 * Sends the setup panel to the admin (ephemeral).
	 *
	 * @param {import('discord.js').ChatInputCommandInteraction} interaction
	 */
	async execute(interaction) {
		const config = await GuildConfig.getOrCreate(interaction.guild.id)

		// .toObject() converts the Mongoose subdocument to a plain JS object,
		// ensuring field access works correctly even on freshly-loaded documents.
		const panel = config.ticketPanel?.toObject?.() ?? config.ticketPanel ?? {}

		await interaction.reply({
			content: "**Ticket Panel Setup** — Customize below, then publish.",
			embeds: [buildConfigStatusEmbed(panel), buildPreviewEmbed(panel)],
			components: [buildSetupMenu(), buildPublishButton()],
			flags: MessageFlags.Ephemeral,
		})
	},

	handleTicketSetupInteraction,
	PUBLISH_BTN_ID,
	CHANNEL_SELECT_ID,
}

// ─── Interaction router ───────────────────────────────────────────────────────

/**
 * Routes all tks_* interactions from index.js.
 *
 * @param {import('discord.js').Interaction} interaction
 */
async function handleTicketSetupInteraction(interaction) {
	const guildId = interaction.guild.id

	try {
		// Main setup Select Menu
		if (interaction.isStringSelectMenu() && interaction.customId === MENU_ID) {
			const selected = interaction.values[0]
			if (selected === "panel") return await showPanelModal(interaction, guildId)
			if (selected === "button") return await showButtonModal(interaction, guildId)
			if (selected === "log") return await showChannelSelect(interaction)
		}

		// Channel picker for log channel
		if (interaction.isChannelSelectMenu() && interaction.customId === CHANNEL_SELECT_ID) {
			return await handleChannelSelect(interaction, guildId)
		}

		// Modal submissions
		if (interaction.isModalSubmit()) {
			if (interaction.customId === MODAL_PANEL)
				return await handlePanelModal(interaction, guildId)
			if (interaction.customId === MODAL_BUTTON)
				return await handleButtonModal(interaction, guildId)
		}

		// Publish button
		if (interaction.isButton() && interaction.customId === PUBLISH_BTN_ID) {
			return await handlePublish(interaction, guildId)
		}
	} catch (error) {
		console.error("[Ticket Setup] Interaction error:", error)
		const payload = {
			content: "An error occurred. Please try again.",
			flags: MessageFlags.Ephemeral,
		}
		if (interaction.replied || interaction.deferred)
			return interaction.followUp(payload).catch(() => null)
		return interaction.reply(payload).catch(() => null)
	}
}

// ─── UI builders ──────────────────────────────────────────────────────────────

/**
 * Builds the live preview embed — exactly how the published panel will look.
 * Always reads from the `panel` plain object (after toObject()) so values
 * are never undefined due to Mongoose subdocument quirks.
 *
 * @param {object} panel
 * @returns {EmbedBuilder}
 */
function buildPreviewEmbed(panel) {
	const color = hexToInt(panel.color) ?? DEFAULTS.color

	return new EmbedBuilder()
		.setTitle(panel.title || DEFAULTS.title)
		.setDescription(panel.description || DEFAULTS.description)
		.setColor(color)
		.setFooter({ text: "👆 Preview — this is how the published panel will look" })
}

/**
 * Builds the config status embed showing current saved settings.
 *
 * @param {object} panel
 * @returns {EmbedBuilder}
 */
function buildConfigStatusEmbed(panel) {
	return new EmbedBuilder()
		.setTitle("⚙️ Current Configuration")
		.setColor(0x2b2d31)
		.addFields(
			{
				name: "Title",
				value: panel.title || DEFAULTS.title,
				inline: true,
			},
			{
				name: "Color",
				value: panel.color || DEFAULTS.colorHex,
				inline: true,
			},
			{
				name: "Button",
				value: `${panel.buttonEmoji || DEFAULTS.buttonEmoji} ${panel.buttonLabel || DEFAULTS.buttonLabel}`,
				inline: true,
			},
			{
				name: "Log Channel",
				value: panel.logChannelId ? `<#${panel.logChannelId}>` : "Not set",
				inline: true,
			},
		)
}

/** Builds the main setup Select Menu. */
function buildSetupMenu() {
	const menu = new StringSelectMenuBuilder()
		.setCustomId(MENU_ID)
		.setPlaceholder("🎨 Choose a setting to customize...")
		.addOptions(
			new StringSelectMenuOptionBuilder()
				.setLabel("Panel Appearance")
				.setDescription("Set title, description, and color")
				.setValue("panel")
				.setEmoji("🎨"),
			new StringSelectMenuOptionBuilder()
				.setLabel("Button")
				.setDescription("Set the button label and emoji")
				.setValue("button")
				.setEmoji("🔘"),
			new StringSelectMenuOptionBuilder()
				.setLabel("Log Channel")
				.setDescription("Choose the channel where transcripts are saved")
				.setValue("log")
				.setEmoji("📋"),
		)

	return new ActionRowBuilder().addComponents(menu)
}

/** Builds the publish button row. */
function buildPublishButton() {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(PUBLISH_BTN_ID)
			.setLabel("✅ Publish Panel")
			.setStyle(ButtonStyle.Success),
	)
}

// ─── Modal openers ────────────────────────────────────────────────────────────

/**
 * Shows the panel appearance modal pre-filled with current saved values.
 * Pre-filling with current values lets the admin edit in-place rather than
 * re-typing everything from scratch on each change.
 */
async function showPanelModal(interaction, guildId) {
	const config = await GuildConfig.getOrCreate(guildId)
	const panel = config.ticketPanel?.toObject?.() ?? config.ticketPanel ?? {}

	const modal = new ModalBuilder()
		.setCustomId(MODAL_PANEL)
		.setTitle("Customize Panel Appearance")

	modal.addComponents(
		new ActionRowBuilder().addComponents(
			new TextInputBuilder()
				.setCustomId("title")
				.setLabel("Title (emojis supported)")
				.setStyle(TextInputStyle.Short)
				.setValue(panel.title || DEFAULTS.title)
				.setMaxLength(256)
				.setRequired(true),
		),
		new ActionRowBuilder().addComponents(
			new TextInputBuilder()
				.setCustomId("description")
				.setLabel("Description (emojis supported)")
				.setStyle(TextInputStyle.Paragraph)
				.setValue(panel.description || DEFAULTS.description)
				.setMaxLength(2048)
				.setRequired(true),
		),
		new ActionRowBuilder().addComponents(
			new TextInputBuilder()
				.setCustomId("color")
				.setLabel("Color (hex, e.g. #5865F2)")
				.setStyle(TextInputStyle.Short)
				.setValue(panel.color || DEFAULTS.colorHex)
				.setMinLength(4)
				.setMaxLength(7)
				.setRequired(true),
		),
	)

	await interaction.showModal(modal)
}

/**
 * Shows the button customization modal pre-filled with current saved values.
 */
async function showButtonModal(interaction, guildId) {
	const config = await GuildConfig.getOrCreate(guildId)
	const panel = config.ticketPanel?.toObject?.() ?? config.ticketPanel ?? {}

	const modal = new ModalBuilder()
		.setCustomId(MODAL_BUTTON)
		.setTitle("Customize Ticket Button")

	modal.addComponents(
		new ActionRowBuilder().addComponents(
			new TextInputBuilder()
				.setCustomId("label")
				.setLabel("Button label")
				.setStyle(TextInputStyle.Short)
				.setValue(panel.buttonLabel || DEFAULTS.buttonLabel)
				.setMaxLength(80)
				.setRequired(true),
		),
		new ActionRowBuilder().addComponents(
			new TextInputBuilder()
				.setCustomId("emoji")
				.setLabel("Button emoji")
				.setStyle(TextInputStyle.Short)
				.setValue(panel.buttonEmoji || DEFAULTS.buttonEmoji)
				.setMaxLength(50)
				.setRequired(false),
		),
	)

	await interaction.showModal(modal)
}

/**
 * Shows a ChannelSelectMenu for picking the log channel.
 *
 * ChannelSelectMenu renders Discord's native channel picker UI —
 * the admin clicks and selects from their actual server channels,
 * no ID typing required. Filtered to text-based channels only.
 */
async function showChannelSelect(interaction) {
	const channelSelect = new ChannelSelectMenuBuilder()
		.setCustomId(CHANNEL_SELECT_ID)
		.setPlaceholder("📋 Select the log channel for ticket transcripts...")
		.setChannelTypes(
			ChannelType.GuildText,
			ChannelType.GuildAnnouncement,
		)

	await interaction.reply({
		content: "Choose the channel where ticket transcripts will be saved when a ticket is closed:",
		components: [new ActionRowBuilder().addComponents(channelSelect)],
		flags: MessageFlags.Ephemeral,
	})
}

// ─── Interaction handlers ─────────────────────────────────────────────────────

/**
 * Saves the panel appearance settings to MongoDB and updates the setup panel
 * in-place so the admin sees the new preview immediately.
 *
 * Key fix: after saving, calls interaction.message.edit() to update the
 * original ephemeral setup message (embeds + components) instead of sending
 * a separate editReply — this ensures the preview the admin sees is always
 * the current saved state, not stale data from when /ticket-setup was run.
 *
 * Uses spread over toObject() to avoid mutating a Mongoose subdocument
 * directly, which can cause Mongoose to miss the change for markModified.
 */
async function handlePanelModal(interaction, guildId) {
	await interaction.deferUpdate()

	const title = interaction.fields.getTextInputValue("title").trim()
	const description = interaction.fields.getTextInputValue("description").trim()
	const color = interaction.fields.getTextInputValue("color").trim()

	if (!/^#[0-9A-Fa-f]{3,6}$/.test(color)) {
		// Can't show a modal error after deferUpdate; send a followUp instead
		return interaction.followUp({
			content: "❌ Invalid color. Use a hex code like `#5865F2`.",
			flags: MessageFlags.Ephemeral,
		})
	}

	const config = await GuildConfig.getOrCreate(guildId)
	const existing = config.ticketPanel?.toObject?.() ?? {}

	config.ticketPanel = { ...existing, title, description, color }
	config.markModified("ticketPanel")
	await config.save()

	// Re-read saved data to guarantee the preview reflects exactly what's in DB
	const saved = config.ticketPanel?.toObject?.() ?? config.ticketPanel ?? {}

	// Edit the original setup panel message in-place — the admin sees the
	// updated preview without any new message appearing in the channel.
	await interaction.editReply({
		content: "**Ticket Panel Setup** — Customize below, then publish.",
		embeds: [buildConfigStatusEmbed(saved), buildPreviewEmbed(saved)],
		components: [buildSetupMenu(), buildPublishButton()],
	})
}

/**
 * Saves button label and emoji to MongoDB and updates the setup panel
 * in-place so the config status embed reflects the new button immediately.
 *
 * Same pattern as handlePanelModal: deferUpdate → save → editReply to
 * refresh the original ephemeral message rather than creating a new one.
 */
async function handleButtonModal(interaction, guildId) {
	await interaction.deferUpdate()

	const label = interaction.fields.getTextInputValue("label").trim()
	const emoji = interaction.fields.getTextInputValue("emoji").trim()

	const config = await GuildConfig.getOrCreate(guildId)
	const existing = config.ticketPanel?.toObject?.() ?? {}

	config.ticketPanel = {
		...existing,
		buttonLabel: label,
		buttonEmoji: emoji || DEFAULTS.buttonEmoji,
	}
	config.markModified("ticketPanel")
	await config.save()

	const saved = config.ticketPanel?.toObject?.() ?? config.ticketPanel ?? {}

	await interaction.editReply({
		content: "**Ticket Panel Setup** — Customize below, then publish.",
		embeds: [buildConfigStatusEmbed(saved), buildPreviewEmbed(saved)],
		components: [buildSetupMenu(), buildPublishButton()],
	})
}

/**
 * Handles the ChannelSelectMenu submission.
 *
 * interaction.channels is a Collection of the selected channels.
 * We take the first (only one is selected here) and save its ID.
 */
async function handleChannelSelect(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const channel = interaction.channels.first()

	if (!channel) {
		return interaction.editReply({ content: "❌ No channel selected." })
	}

	const config = await GuildConfig.getOrCreate(guildId)
	const existing = config.ticketPanel?.toObject?.() ?? {}

	config.ticketPanel = { ...existing, logChannelId: channel.id }
	config.markModified("ticketPanel")
	await config.save()

	await interaction.editReply({
		content: `✅ Ticket transcripts will be saved to ${channel}.`,
	})
}

/**
 * Publishes the configured ticket panel to the current channel.
 *
 * Critical fix: always fetches config fresh from DB here.
 * The previous version reused a stale `config` reference from execute(),
 * which did not reflect changes made after the setup panel was first sent.
 *
 * Also calls toObject() on the subdocument before reading fields to avoid
 * Mongoose subdocument quirks where getters return undefined on nested paths.
 */
async function handlePublish(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	// Always fetch fresh — config may have changed since the panel was opened
	const config = await GuildConfig.getOrCreate(guildId)
	const panel = config.ticketPanel?.toObject?.() ?? config.ticketPanel ?? {}

	const color = hexToInt(panel.color) ?? DEFAULTS.color
	const title = panel.title || DEFAULTS.title
	const description = panel.description || DEFAULTS.description
	const buttonLabel = panel.buttonLabel || DEFAULTS.buttonLabel
	const buttonEmoji = panel.buttonEmoji || DEFAULTS.buttonEmoji

	const publishedEmbed = new EmbedBuilder()
		.setTitle(title)
		.setDescription(description)
		.setColor(color)
		.setTimestamp()

	const openButton = new ButtonBuilder()
		.setCustomId("open_ticket")
		.setLabel(buttonLabel)
		.setStyle(ButtonStyle.Primary)

	if (buttonEmoji) {
		try {
			openButton.setEmoji(buttonEmoji)
		} catch {
			console.warn("[Ticket Setup] Invalid button emoji, skipping:", buttonEmoji)
		}
	}

	const actionRow = new ActionRowBuilder().addComponents(openButton)

	await interaction.channel.send({
		embeds: [publishedEmbed],
		components: [actionRow],
	})

	await interaction.editReply({
		content: `✅ Ticket panel published in ${interaction.channel}!`,
	})
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Converts a hex color string (e.g. "#5865F2") to an integer (0x5865F2).
 * EmbedBuilder.setColor() requires an integer, not a string.
 *
 * @param {string|null|undefined} hex
 * @returns {number|null}
 */
function hexToInt(hex) {
	if (!hex) return null
	const int = Number.parseInt(hex.replace("#", ""), 16)
	return Number.isNaN(int) ? null : int
}