/**
 * @file index.js
 * @description Application bootstrap and orchestration layer for the Discord bot.
 *
 * ─── Responsibilities ─────────────────────────────────────────────────────────
 * This file is intentionally thin. It does NOT contain business logic.
 * Each concern is delegated to a dedicated module:
 *
 *   • Command modules (/commands)   — define slash commands and their handlers
 *   • Event modules  (/events)      — attach listeners for non-command events
 *   • Data models    (/models)      — define MongoDB schemas and methods
 *
 * Bootstrap is intentionally sequential:
 *   1. Validate environment     — fail fast before any I/O
 *   2. Create Discord client    — sets up the in-memory command registry
 *   3. Load command modules     — dynamically discovered from /commands
 *   4. Register event handlers  — AutoMod listener + interaction router
 *   5. Connect to MongoDB       — must succeed before bot goes online
 *   6. Login to Discord         — begins receiving events
 *
 * Steps 5 and 6 are ordered deliberately: if the database is unavailable,
 * the bot should not come online and accept commands it cannot fulfill.
 *
 * ─── Interaction routing ──────────────────────────────────────────────────────
 * All incoming interactions are handled by the single `interactionCreate`
 * listener in `registerEventHandlers`. It dispatches based on interaction type:
 *   - ChatInputCommand → looks up command in client.commands Collection
 *   - Button (open_ticket) → handleTicketButton
 *
 * Adding new button handlers: add an additional `isButton()` branch here.
 * Adding new interaction types: add a new type guard (isModalSubmit, etc.).
 *
 * ─── AutoMod integration ──────────────────────────────────────────────────────
 * The AutoMod system attaches its own `messageCreate` listener via
 * `autoMod.register(client)`. It is registered before `client.login()`
 * so no messages are missed in the window between login and listener attach.
 */

require("dotenv").config()

const fs = require("node:fs")
const path = require("node:path")
const mongoose = require("mongoose")
const {
	ChannelType,
	Client,
	Collection,
	GatewayIntentBits,
	MessageFlags,
	PermissionFlagsBits,
	REST,
	Routes,
} = require("discord.js")

const GuildUser = require("./models/GuildUser")
const { handleAutoModSetupInteraction } = require("./commands/automod-setup")
const { handleTicketSetupInteraction, PUBLISH_BTN_ID } = require("./commands/ticket-setup")
const autoMod = require("./events/autoMod")

// ─── Configuration constants ──────────────────────────────────────────────────

/**
 * Environment variables required at startup.
 * The bot performs a hard exit if any are missing, printing a descriptive error.
 * This "fail-fast" pattern surfaces misconfiguration immediately rather than
 * silently failing later during a database connect or API call.
 */
const REQUIRED_ENV_VARS = ["DISCORD_TOKEN", "MONGO_URI"]

/**
 * Absolute path to the commands directory.
 * Using path.join(__dirname, ...) ensures portability across operating systems
 * and is resilient to the working directory changing at runtime.
 */
const COMMANDS_DIRECTORY = path.join(__dirname, "commands")

/**
 * Guild-scoped command deployment target.
 *
 * Guild commands propagate instantly (vs global commands, which can take up to
 * 1 hour). Using guild scope during development and testing is strongly recommended.
 * For production, switch to Routes.applicationCommands() (no guild ID required).
 */
const APPLICATION_GUILD_ID = "860520561943379998"

/**
 * Custom ID routing key for the "Open Ticket" button.
 * Must exactly match the customId set in ticket.js.
 */
const TICKET_BUTTON_ID = "open_ticket"

// ─── Environment validation ───────────────────────────────────────────────────

/**
 * Checks that all required environment variables are defined.
 *
 * Uses Array.filter to collect ALL missing variables before throwing,
 * so the developer sees the complete list in one error — not just the first.
 *
 * @throws {Error} If one or more required variables are absent
 */
function validateEnvironment() {
	const missingVariables = REQUIRED_ENV_VARS.filter(key => !process.env[key])

	if (missingVariables.length > 0) {
		throw new Error(
			`Missing required environment variables: ${missingVariables.join(", ")}`,
		)
	}
}

// ─── Client factory ───────────────────────────────────────────────────────────

/**
 * Creates and configures the Discord client.
 *
 * Intent selection rationale:
 *   Guilds         — required for guild/channel/role data.
 *   GuildMessages  — required to receive messageCreate events (AutoMod).
 *   GuildMembers   — required for member-level operations (kick, ban, timeout).
 *   MessageContent — required to read message text content for AutoMod filtering.
 *                    Note: MessageContent is a privileged intent. It must be
 *                    enabled in the Discord Developer Portal under "Bot > Intents".
 *
 * client.commands is a discord.js Collection (extends Map) used as the
 * in-memory command registry. Collection provides O(1) command lookup by name
 * and avoids large if/switch dispatch chains in the interaction router.
 *
 * @returns {Client}
 */
function createClient() {
	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.GuildMembers,
			GatewayIntentBits.MessageContent,
		],
	})

	/** @type {Collection<string, {data: SlashCommandBuilder, execute: Function}>} */
	client.commands = new Collection()

	return client
}

// ─── Command loader ───────────────────────────────────────────────────────────

/**
 * Dynamically discovers and loads all command modules from /commands.
 *
 * Discovery flow:
 *   1. Read the /commands directory.
 *   2. Filter for .js files only (skips hidden files, READMEs, etc.).
 *   3. require() each file.
 *   4. Validate that it exports { data, execute } — the expected interface.
 *   5. Register it in client.commands keyed by command name.
 *
 * Invalid modules are SKIPPED (not crashed) with a console.warn.
 * This allows partial functionality during development (e.g., a WIP command
 * file that hasn't implemented execute yet won't bring down the entire bot).
 *
 * @param {Client} client
 */
function loadCommands(client) {
	const commandFiles = fs
		.readdirSync(COMMANDS_DIRECTORY)
		.filter(file => file.endsWith(".js"))

	for (const fileName of commandFiles) {
		const filePath = path.join(COMMANDS_DIRECTORY, fileName)
		const command = require(filePath)

		if (!command?.data || typeof command.execute !== "function") {
			console.warn(`Skipping invalid command module: ${fileName}`)
			continue
		}

		client.commands.set(command.data.name, command)
		console.log(`Loaded command: ${command.data.name}`)
	}
}

// ─── Database ─────────────────────────────────────────────────────────────────

/**
 * Connects to MongoDB via Mongoose.
 *
 * Awaited before client.login() to guarantee that no interaction handler
 * runs against an uninitialised database connection. Any command that reads
 * or writes to MongoDB would fail with an unhandled promise rejection if
 * login preceded the connection.
 *
 * Mongoose manages a connection pool internally — this call establishes
 * the pool and resolves once the first connection is ready.
 *
 * @returns {Promise<void>}
 */
async function connectDatabase() {
	await mongoose.connect(process.env.MONGO_URI)
	console.log("🍃 MongoDB connection established successfully.")
}

// ─── Slash command registration ───────────────────────────────────────────────

/**
 * Deploys (or updates) slash commands to the Discord API for the target guild.
 *
 * Uses a PUT request which performs a FULL OVERWRITE of the guild's command
 * list. This is intentional:
 *   - Ensures deleted command files are also removed from Discord.
 *   - Guarantees exact parity between client.commands and what Discord shows.
 *   - Slightly higher API cost than a diff-based approach, but negligible at boot.
 *
 * command.data.toJSON() serialises the SlashCommandBuilder to the raw API
 * payload format Discord expects (plain object, not a class instance).
 *
 * @param {Client} client
 */
async function registerSlashCommands(client) {
	const commandsPayload = client.commands.map(command => command.data.toJSON())
	const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN)

	console.log(
		`⌛ Synchronizing ${commandsPayload.length} application commands...`,
	)

	await rest.put(
		Routes.applicationGuildCommands(client.user.id, APPLICATION_GUILD_ID),
		{ body: commandsPayload },
	)

	console.log("✅ Slash commands synchronized successfully.")
}

// ─── Interaction handlers ─────────────────────────────────────────────────────

/**
 * Executes a slash command within a controlled error boundary.
 *
 * Discord's interaction lifecycle constraint:
 * Each interaction must receive exactly ONE initial response. Subsequent
 * responses must use followUp(). If the command calls deferReply(), the
 * initial response slot is consumed — subsequent responses must use editReply().
 *
 * Error recovery strategy:
 *   1. Catch all execution errors (prevents unhandled rejections crashing the process).
 *   2. Check interaction state (replied / deferred).
 *   3. Use the appropriate response method (followUp vs reply).
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {Client} client
 */
async function handleChatInputCommand(interaction, client) {
	const command = client.commands.get(interaction.commandName)

	if (!command) {
		return interaction.reply({
			content: "This command is not currently available.",
			flags: MessageFlags.Ephemeral,
		})
	}

	try {
		await command.execute(interaction, { client })
	} catch (error) {
		console.error(
			`Command execution failed for /${interaction.commandName}:`,
			error,
		)

		const payload = {
			content: "An unexpected error occurred while executing this command.",
			flags: MessageFlags.Ephemeral,
		}

		if (interaction.replied || interaction.deferred) {
			return interaction.followUp(payload).catch(() => null)
		}

		return interaction.reply(payload).catch(() => null)
	}
}

/**
 * Handles ticket channel creation triggered by the "Open Ticket" button.
 *
 * Data consistency approach:
 *   Uses findOneAndUpdate with upsert to atomically create or update the
 *   GuildUser record. This prevents duplicate ticket channels from being
 *   created if the user double-clicks the button faster than the first
 *   await resolves (race condition protection).
 *
 * Channel naming:
 *   Username is sanitised to comply with Discord's channel name rules:
 *   lowercase alphanumeric + hyphens, max 100 chars. We cap at 20 to keep
 *   names readable when combined with the "ticket-" prefix.
 *
 * Permission model:
 *   @everyone: ViewChannel denied (private channel)
 *   User: ViewChannel + SendMessages + AttachFiles + ReadMessageHistory
 *   Bot:  ViewChannel + SendMessages + ManageChannels + ReadMessageHistory
 *         (ManageChannels is required to delete the channel on /close)
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleTicketButton(interaction) {
	const { guild, user } = interaction

	// Check for an existing active ticket before creating a new one
	const existingRecord = await GuildUser.findOne({
		guildId: guild.id,
		userId: user.id,
	})

	const existingChannelId = existingRecord?.ticketChannelId

	if (existingRecord?.activateTicket && existingChannelId) {
		const existingChannel = guild.channels.cache.get(existingChannelId)

		if (existingChannel) {
			return interaction.reply({
				content: `You already have an open ticket in ${existingChannel}.`,
				flags: MessageFlags.Ephemeral,
			})
		}
	}

	/**
	 * Sanitise username for channel naming:
	 * - toLowerCase(): Discord channel names are case-insensitive; normalise for consistency.
	 * - replace(/[^a-z0-9-]/g, ""): strip characters Discord doesn't allow in channel names.
	 * - slice(0, 20): keep names short and readable.
	 * - || "user": fallback for users whose username consists entirely of special characters.
	 */
	const sanitizedUsername =
		user.username
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "")
			.slice(0, 20) || "user"

	const ticketChannel = await guild.channels.create({
		name: `ticket-${sanitizedUsername}`,
		type: ChannelType.GuildText,
		permissionOverwrites: [
			{
				id: guild.id, // @everyone role
				deny: [PermissionFlagsBits.ViewChannel],
			},
			{
				id: user.id,
				allow: [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.SendMessages,
					PermissionFlagsBits.AttachFiles,
					PermissionFlagsBits.ReadMessageHistory,
				],
			},
			{
				id: interaction.client.user.id,
				allow: [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.SendMessages,
					PermissionFlagsBits.ManageChannels,
					PermissionFlagsBits.ReadMessageHistory,
				],
			},
		],
	})

	// Atomic upsert — safe under concurrent button presses
	await GuildUser.findOneAndUpdate(
		{ guildId: guild.id, userId: user.id },
		{
			$set: {
				activateTicket: true,
				ticketChannelId: ticketChannel.id,
			},
			$setOnInsert: {
				guildId: guild.id,
				userId: user.id,
			},
		},
		{
			upsert: true,
			returnDocument: "after",
			setDefaultsOnInsert: true,
		},
	)

	await ticketChannel.send({
		content: `${user}, your support ticket has been created. A moderator will assist you shortly.`,
	})

	return interaction.reply({
		content: `Ticket created successfully: ${ticketChannel}`,
		flags: MessageFlags.Ephemeral,
	})
}

// ─── Event registration ───────────────────────────────────────────────────────

/**
 * Registers all Discord client event listeners.
 *
 * Why centralise here?
 * Declaring all entry points in one location makes the control flow of the
 * application traceable at a glance. Any developer can open index.js and
 * immediately understand what events the bot responds to.
 *
 * interactionCreate is used for ALL Discord UI interactions:
 *   - Slash commands (isChatInputCommand)
 *   - Buttons (isButton)
 *   - Select menus, modals, etc. (not yet implemented — add branches here)
 *
 * clientReady (once) fires exactly once after login succeeds and the client
 * cache is ready. Slash command registration is deferred to this event because
 * client.user.id is not available until the client has authenticated.
 *
 * @param {Client} client
 */
function registerEventHandlers(client) {
	// Register the AutoMod messageCreate listener
	autoMod.register(client)

	client.on("interactionCreate", async interaction => {
		try {
			// Route AutoMod setup interactions (Buttons + Select Menus + Modals prefixed with ams_)
			if (interaction.customId?.startsWith("ams_")) {
				return await handleAutoModSetupInteraction(interaction)
			}

			// Route Ticket setup interactions (Select Menus + Channel Select + Modals + Publish button)
			if (interaction.customId?.startsWith("tks_")) {
				return await handleTicketSetupInteraction(interaction)
			}

			if (interaction.isChatInputCommand()) {
				return await handleChatInputCommand(interaction, client)
			}

			if (interaction.isButton() && interaction.customId === TICKET_BUTTON_ID) {
				return await handleTicketButton(interaction)
			}
		} catch (error) {
			console.error("Interaction router failure:", error)

			if (!interaction.replied && !interaction.deferred) {
				await interaction
					.reply({
						content: "The interaction could not be completed.",
						flags: MessageFlags.Ephemeral,
					})
					.catch(() => null)
			}
		}
	})

	client.once("clientReady", async () => {
		console.log(`${client.user.tag} online.`)

		try {
			await registerSlashCommands(client)
		} catch (error) {
			console.error("Command synchronization failed:", error)
		}
	})
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Main application startup sequence.
 *
 * Order is critical and non-negotiable:
 *   1. validateEnvironment — must run before any process.env access downstream.
 *   2. createClient        — must run before loadCommands (attaches commands Collection).
 *   3. loadCommands        — must run before registerEventHandlers (commands must exist
 *                            before the interactionCreate handler fires).
 *   4. registerEventHandlers — must run before login (ensures no events are missed
 *                              in the window between login and listener attachment).
 *   5. connectDatabase     — must succeed before login (commands need DB access).
 *   6. client.login        — starts receiving Discord gateway events.
 */
async function bootstrap() {
	validateEnvironment()

	const client = createClient()
	loadCommands(client)
	registerEventHandlers(client)

	await connectDatabase()
	await client.login(process.env.DISCORD_TOKEN)
}

/**
 * Top-level fatal error handler.
 *
 * Catches any unrecoverable error from the bootstrap sequence.
 * Logs the error for debugging and terminates with exit code 1
 * (non-zero signals failure to process managers like PM2 or systemd,
 * allowing them to attempt a restart).
 */
bootstrap().catch(error => {
	console.error("Fatal startup error:", error)
	process.exit(1)
})