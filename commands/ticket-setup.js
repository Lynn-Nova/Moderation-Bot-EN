/**
 * @file ticket-setup.js
 * @description Interactive ticket panel setup with full customization support.
 *
 * ─── Overview ────────────────────────────────────────────────────────────────
 * Replaces the static /ticket-setup command with a two-step configuration flow:
 *
 *   Step 1 — /ticket-setup
 *     Sends an ephemeral configuration panel to the admin with a Select Menu
 *     for choosing which aspect to customize:
 *       • Panel message (title, description, emoji, color)
 *       • Button label and emoji
 *       • Log channel for ticket transcripts
 *
 *   Step 2 — Admin confirms via "Publish Panel" button
 *     The bot posts the fully customized embed + ticket button to the channel.
 *
 * ─── Customization options ────────────────────────────────────────────────────
 *   Title         — embed title (supports emojis)
 *   Description   — embed description (multi-line, supports emojis)
 *   Color         — hex color code (e.g. #5865F2)
 *   Button label  — text on the open-ticket button (supports emojis)
 *   Log channel   — channel ID where ticket transcripts are saved on /close
 *
 * ─── Persistence ─────────────────────────────────────────────────────────────
 * Customization is stored in GuildConfig.ticketPanel (new subdocument).
 * The /close command reads ticketPanel.logChannelId to know where to post
 * the transcript after collecting the channel's message history.
 *
 * ─── Component ID conventions ────────────────────────────────────────────────
 * All IDs are prefixed with "tks_" (ticket setup):
 *   tks_menu              — setup Select Menu
 *   tks_modal_panel       — panel appearance modal
 *   tks_modal_button      — button label modal
 *   tks_modal_log         — log channel modal
 *   tks_publish           — publish confirmation button
 */

const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
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
const MODAL_LOG = "tks_modal_log"
const PUBLISH_BTN_ID = "tks_publish"

/** Default ticket panel appearance used before any customization. */
const DEFAULTS = {
	title: "🎫 Support Ticket System",
	description:
		"Need help from the moderation team?\n\nClick the button below to create a private support channel.\nOnly you and the moderation team will be able to see it.",
	color: 0x5865f2, // Discord blurple
	buttonLabel: "Open Ticket",
	buttonEmoji: "📩",
}

// ─── Slash command ────────────────────────────────────────────────────────────

module.exports = {
	data: new SlashCommandBuilder()
		.setName("ticket-setup")
		.setDescription("Configure and publish the support ticket panel.")
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

	/**
	 * Sends the configuration panel to the admin (ephemeral).
	 * Shows a preview of the current config and the setup Select Menu.
	 *
	 * @param {import('discord.js').ChatInputCommandInteraction} interaction
	 */
	async execute(interaction) {
		const config = await GuildConfig.getOrCreate(interaction.guild.id)
		const panel = config.ticketPanel ?? {}

		const previewEmbed = buildPreviewEmbed(panel)
		const configEmbed = buildConfigStatusEmbed(panel)
		const row = buildSetupMenu()
		const publishRow = buildPublishButton()

		await interaction.reply({
			content: "**Ticket Panel Setup** — Customize the panel below, then publish it.",
			embeds: [configEmbed, previewEmbed],
			components: [row, publishRow],
			flags: MessageFlags.Ephemeral,
		})
	},

	// Exported for index.js routing
	handleTicketSetupInteraction,
	PUBLISH_BTN_ID,
}

// ─── Interaction router ───────────────────────────────────────────────────────

/**
 * Handles all tks_* component and modal interactions.
 * Called from index.js whenever customId starts with "tks_".
 *
 * @param {import('discord.js').Interaction} interaction
 */
async function handleTicketSetupInteraction(interaction) {
	const guildId = interaction.guild.id

	try {
		if (interaction.isStringSelectMenu() && interaction.customId === MENU_ID) {
			const selected = interaction.values[0]
			if (selected === "panel") return await showPanelModal(interaction)
			if (selected === "button") return await showButtonModal(interaction)
			if (selected === "log") return await showLogModal(interaction)
		}

		if (interaction.isModalSubmit()) {
			if (interaction.customId === MODAL_PANEL)
				return await handlePanelModal(interaction, guildId)
			if (interaction.customId === MODAL_BUTTON)
				return await handleButtonModal(interaction, guildId)
			if (interaction.customId === MODAL_LOG)
				return await handleLogModal(interaction, guildId)
		}

		if (interaction.isButton() && interaction.customId === PUBLISH_BTN_ID) {
			return await handlePublish(interaction, guildId)
		}
	} catch (error) {
		console.error("[Ticket Setup] Interaction error:", error)
		const payload = { content: "An error occurred. Please try again.", flags: MessageFlags.Ephemeral }
		if (interaction.replied || interaction.deferred) return interaction.followUp(payload).catch(() => null)
		return interaction.reply(payload).catch(() => null)
	}
}

// ─── UI builders ──────────────────────────────────────────────────────────────

/**
 * Builds a live preview of how the published panel will look.
 * Uses current config values (or defaults) so the admin sees the real result.
 *
 * @param {object} panel  ticketPanel config subdocument
 * @returns {EmbedBuilder}
 */
function buildPreviewEmbed(panel) {
	const color = hexToInt(panel.color) ?? DEFAULTS.color

	return new EmbedBuilder()
		.setTitle(panel.title ?? DEFAULTS.title)
		.setDescription(panel.description ?? DEFAULTS.description)
		.setColor(color)
		.setFooter({ text: "👆 This is a preview of the published panel" })
}

/**
 * Builds the config status embed showing current settings.
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
				value: panel.title ?? DEFAULTS.title,
				inline: true,
			},
			{
				name: "Color",
				value: panel.color ?? "#5865F2",
				inline: true,
			},
			{
				name: "Button Label",
				value: `${panel.buttonEmoji ?? DEFAULTS.buttonEmoji} ${panel.buttonLabel ?? DEFAULTS.buttonLabel}`,
				inline: true,
			},
			{
				name: "Log Channel",
				value: panel.logChannelId ? `<#${panel.logChannelId}>` : "Not set",
				inline: true,
			},
		)
}

/** Builds the setup Select Menu. */
function buildSetupMenu() {
	const menu = new StringSelectMenuBuilder()
		.setCustomId(MENU_ID)
		.setPlaceholder("🎨 Customize the ticket panel...")
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
				.setDescription("Set the channel for ticket transcripts")
				.setValue("log")
				.setEmoji("📋"),
		)

	return new ActionRowBuilder().addComponents(menu)
}

/** Builds the publish confirmation button. */
function buildPublishButton() {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(PUBLISH_BTN_ID)
			.setLabel("✅ Publish Panel")
			.setStyle(ButtonStyle.Success),
	)
}

// ─── Modal openers ────────────────────────────────────────────────────────────

/** Shows the panel appearance modal (title, description, color). */
async function showPanelModal(interaction) {
	const config = await GuildConfig.getOrCreate(interaction.guild.id)
	const panel = config.ticketPanel ?? {}

	const modal = new ModalBuilder()
		.setCustomId(MODAL_PANEL)
		.setTitle("Customize Panel Appearance")

	modal.addComponents(
		new ActionRowBuilder().addComponents(
			new TextInputBuilder()
				.setCustomId("title")
				.setLabel("Panel title (emojis supported)")
				.setStyle(TextInputStyle.Short)
				.setValue(panel.title ?? DEFAULTS.title)
				.setMaxLength(256)
				.setRequired(true),
		),
		new ActionRowBuilder().addComponents(
			new TextInputBuilder()
				.setCustomId("description")
				.setLabel("Panel description (emojis supported)")
				.setStyle(TextInputStyle.Paragraph)
				.setValue(panel.description ?? DEFAULTS.description)
				.setMaxLength(2048)
				.setRequired(true),
		),
		new ActionRowBuilder().addComponents(
			new TextInputBuilder()
				.setCustomId("color")
				.setLabel("Color (hex code, e.g. #5865F2)")
				.setStyle(TextInputStyle.Short)
				.setValue(panel.color ?? "#5865F2")
				.setMinLength(4)
				.setMaxLength(7)
				.setRequired(true),
		),
	)

	await interaction.showModal(modal)
}

/** Shows the button customization modal (label, emoji). */
async function showButtonModal(interaction) {
	const config = await GuildConfig.getOrCreate(interaction.guild.id)
	const panel = config.ticketPanel ?? {}

	const modal = new ModalBuilder()
		.setCustomId(MODAL_BUTTON)
		.setTitle("Customize Open Ticket Button")

	modal.addComponents(
		new ActionRowBuilder().addComponents(
			new TextInputBuilder()
				.setCustomId("label")
				.setLabel("Button label")
				.setStyle(TextInputStyle.Short)
				.setValue(panel.buttonLabel ?? DEFAULTS.buttonLabel)
				.setMaxLength(80)
				.setRequired(true),
		),
		new ActionRowBuilder().addComponents(
			new TextInputBuilder()
				.setCustomId("emoji")
				.setLabel("Button emoji (Unicode or Discord emoji)")
				.setStyle(TextInputStyle.Short)
				.setValue(panel.buttonEmoji ?? DEFAULTS.buttonEmoji)
				.setMaxLength(50)
				.setRequired(false),
		),
	)

	await interaction.showModal(modal)
}

/** Shows the log channel modal. */
async function showLogModal(interaction) {
	const modal = new ModalBuilder()
		.setCustomId(MODAL_LOG)
		.setTitle("Ticket Log Channel")

	modal.addComponents(
		new ActionRowBuilder().addComponents(
			new TextInputBuilder()
				.setCustomId("channel_id")
				.setLabel("Channel ID for ticket transcripts")
				.setStyle(TextInputStyle.Short)
				.setPlaceholder("123456789012345678")
				.setRequired(true),
		),
	)

	await interaction.showModal(modal)
}

// ─── Modal handlers ───────────────────────────────────────────────────────────

/** Saves panel appearance settings and refreshes the preview. */
async function handlePanelModal(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const title = interaction.fields.getTextInputValue("title").trim()
	const description = interaction.fields.getTextInputValue("description").trim()
	const color = interaction.fields.getTextInputValue("color").trim()

	// Validate hex color
	if (!/^#[0-9A-Fa-f]{3,6}$/.test(color)) {
		return interaction.editReply({
			content: "❌ Invalid color format. Use a hex code like `#5865F2`.",
		})
	}

	const config = await GuildConfig.getOrCreate(guildId)

	// MongoDB does not support dot-notation assignment on nested paths
	// in all Mongoose versions — always reassign the full subdocument
	config.ticketPanel = {
		...(config.ticketPanel ?? {}),
		title,
		description,
		color,
	}
	config.markModified("ticketPanel")
	await config.save()

	const previewEmbed = buildPreviewEmbed(config.ticketPanel)
	const configEmbed = buildConfigStatusEmbed(config.ticketPanel)

	await interaction.editReply({
		content: "✅ Panel appearance updated. Preview refreshed.",
		embeds: [configEmbed, previewEmbed],
	})
}

/** Saves button customization. */
async function handleButtonModal(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const label = interaction.fields.getTextInputValue("label").trim()
	const emoji = interaction.fields.getTextInputValue("emoji").trim()

	const config = await GuildConfig.getOrCreate(guildId)
	config.ticketPanel = {
		...(config.ticketPanel ?? {}),
		buttonLabel: label,
		buttonEmoji: emoji || DEFAULTS.buttonEmoji,
	}
	config.markModified("ticketPanel")
	await config.save()

	await interaction.editReply({
		content: `✅ Button updated: ${emoji || DEFAULTS.buttonEmoji} **${label}**`,
	})
}

/** Saves log channel ID. */
async function handleLogModal(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const channelId = interaction.fields
		.getTextInputValue("channel_id")
		.trim()
		.replace(/[<#>]/g, "")

	const channel =
		interaction.guild.channels.cache.get(channelId) ??
		(await interaction.guild.channels.fetch(channelId).catch(() => null))

	if (!channel?.isTextBased()) {
		return interaction.editReply({
			content: "❌ Channel not found or is not a text channel.",
		})
	}

	const config = await GuildConfig.getOrCreate(guildId)
	config.ticketPanel = {
		...(config.ticketPanel ?? {}),
		logChannelId: channel.id,
	}
	config.markModified("ticketPanel")
	await config.save()

	await interaction.editReply({
		content: `✅ Ticket transcripts will be saved to ${channel}.`,
	})
}

// ─── Publish handler ──────────────────────────────────────────────────────────

/**
 * Publishes the configured ticket panel to the current channel.
 *
 * Reads the stored ticketPanel config (or uses defaults for unset fields)
 * and posts a public message with the customized embed and ticket button.
 *
 * The published message is permanent and public — the ephemeral setup panel
 * is separate and only visible to the admin.
 */
async function handlePublish(interaction, guildId) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	const config = await GuildConfig.getOrCreate(guildId)
	const panel = config.ticketPanel ?? {}

	const color = hexToInt(panel.color) ?? DEFAULTS.color

	const publishedEmbed = new EmbedBuilder()
		.setTitle(panel.title ?? DEFAULTS.title)
		.setDescription(panel.description ?? DEFAULTS.description)
		.setColor(color)
		.setTimestamp()

	const openButton = new ButtonBuilder()
		.setCustomId("open_ticket")
		.setLabel(panel.buttonLabel ?? DEFAULTS.buttonLabel)
		.setStyle(ButtonStyle.Primary)

	// Apply emoji — may be Unicode (string) or a Discord custom emoji (partial object)
	const emoji = panel.buttonEmoji ?? DEFAULTS.buttonEmoji
	if (emoji) {
		try {
			openButton.setEmoji(emoji)
		} catch {
			// Invalid emoji format — skip rather than crash the publish
			console.warn("[Ticket Setup] Invalid button emoji, skipping:", emoji)
		}
	}

	const actionRow = new ActionRowBuilder().addComponents(openButton)

	// Post to the channel where the admin ran the command
	await interaction.channel.send({
		embeds: [publishedEmbed],
		components: [actionRow],
	})

	await interaction.editReply({
		content: `✅ Ticket panel published successfully in ${interaction.channel}!`,
		embeds: [],
		components: [],
	})
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Converts a hex color string (e.g. "#5865F2") to an integer (0x5865F2).
 * Returns null if the input is not a valid hex color.
 *
 * Discord.js EmbedBuilder.setColor() accepts integers — not hex strings.
 *
 * @param {string|null|undefined} hex
 * @returns {number|null}
 */
function hexToInt(hex) {
	if (!hex) return null
	const cleaned = hex.replace("#", "")
	const int = Number.parseInt(cleaned, 16)
	return Number.isNaN(int) ? null : int
}
