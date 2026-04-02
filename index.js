/**
 * @file index.js
 * @description Entry point and bootstrap coordinator for the Discord bot.
 *
 * Responsibilities:
 * - Validate runtime environment before initialization
 * - Initialize core infrastructure (Discord client + database)
 * - Dynamically discover and register command modules
 * - Synchronize application commands with Discord API
 * - Centralize interaction routing (commands + components)
 * - Provide defensive error handling boundaries for async workflows
 *
 * Architectural note:
 * This file intentionally acts as an orchestration layer only.
 * Business logic is delegated to command modules and data models,
 * ensuring separation of concerns and maintainability.
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

/**
 * List of required environment variables.
 * These represent external dependencies (credentials, URIs) that must be present
 * for the application to function correctly.
 */
const REQUIRED_ENV_VARS = ["DISCORD_TOKEN", "MONGO_URI"]

/**
 * Absolute path to the commands directory.
 * Used for runtime module discovery instead of static imports,
 * enabling plug-and-play extensibility.
 */
const COMMANDS_DIRECTORY = path.join(__dirname, "commands")

/**
 * Guild-scoped command registration target.
 * Limits slash command deployment to a specific guild for faster updates
 * (global commands can take up to 1 hour to propagate).
 */
const APPLICATION_GUILD_ID = "860520561943379998"

/**
 * Custom ID used to identify the "Open Ticket" button interaction.
 * This acts as a routing key inside the interaction dispatcher.
 */
const TICKET_BUTTON_ID = "open_ticket"

/**
 * Validates that all required environment variables are defined.
 *
 * Rationale:
 * Failing fast during startup prevents undefined behavior later
 * (e.g., failed authentication, database connection errors).
 *
 * This approach improves observability and deployment reliability
 * by surfacing configuration issues immediately.
 *
 * @throws {Error} If one or more required variables are missing
 */
function validateEnvironment() {
	const missingVariables = REQUIRED_ENV_VARS.filter(key => !process.env[key])

	if (missingVariables.length > 0) {
		throw new Error(
			`Missing required environment variables: ${missingVariables.join(", ")}`,
		)
	}
}

/**
 * Instantiates the Discord client and attaches an in-memory command registry.
 *
 * Design decisions:
 * - Uses Collection for O(1) command lookup by name
 * - Avoids conditional dispatch patterns (if/switch chains)
 * - Attaches registry directly to client for global accessibility
 *
 * @returns {Client} Configured Discord client instance
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

	/**
	 * In-memory command registry.
	 * Key: command name
	 * Value: command module (data + execute handler)
	 */
	client.commands = new Collection()

	return client
}

/**
 * Dynamically loads command modules from the filesystem.
 *
 * Execution flow:
 * 1. Read all files in /commands directory
 * 2. Filter for valid JavaScript modules
 * 3. Require each module
 * 4. Validate expected interface (data + execute)
 * 5. Register into client.commands collection
 *
 * Fault tolerance:
 * Invalid modules are skipped instead of crashing the application,
 * allowing partial functionality during development.
 *
 * @param {Client} client - Discord client instance
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

/**
 * Establishes a connection to MongoDB using Mongoose.
 *
 * Ordering guarantee:
 * This function is awaited before the bot logs in,
 * ensuring that any command relying on persistence
 * does not execute against an uninitialized database.
 *
 * @returns {Promise<void>}
 */
async function connectDatabase() {
	await mongoose.connect(process.env.MONGO_URI)
	console.log("🍃 MongoDB connection established successfully.")
}

/**
 * Registers (or updates) slash commands with the Discord API.
 *
 * Implementation details:
 * - Uses guild-scoped registration for rapid iteration
 * - Serializes command metadata via toJSON()
 * - Performs a full overwrite (PUT) to ensure consistency
 *
 * Trade-offs:
 * - Overwriting guarantees sync accuracy
 * - Slightly higher API usage compared to diff-based updates
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

/**
 * Executes a slash command within a controlled error boundary.
 *
 * Key constraints:
 * - Discord allows only ONE initial interaction response
 * - Subsequent responses must use followUp()
 *
 * Error handling strategy:
 * - Catch all execution errors to prevent process crashes
 * - Detect interaction state (replied/deferred)
 * - Choose correct response method dynamically
 *
 * @param {ChatInputCommandInteraction} interaction
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
 * Handles ticket creation triggered by a button interaction.
 *
 * Responsibilities:
 * - Prevent duplicate active tickets per user
 * - Normalize username for safe channel naming
 * - Create a private text channel with controlled permissions
 * - Persist ticket state in the database
 *
 * Data consistency:
 * Uses an upsert operation to ensure a single record per (guildId, userId).
 *
 * Security considerations:
 * - Denies @everyone visibility
 * - Grants access only to the user and the bot
 *
 * @param {ButtonInteraction} interaction
 */
async function handleTicketButton(interaction) {
	const { guild, user } = interaction

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
	 * Sanitizes username to comply with Discord channel naming rules.
	 * - Lowercase only
	 * - Alphanumeric + hyphen
	 * - Length capped to avoid API rejection
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
				id: guild.id,
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

/**
 * Registers all runtime event listeners.
 *
 * Design rationale:
 * Centralizing event binding improves traceability and debugging,
 * as all entry points into the system are declared in one location.
 *
 * @param {Client} client
 */
function registerEventHandlers(client) {
	client.on("interactionCreate", async interaction => {
		try {
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

/**
 * Main application bootstrap sequence.
 *
 * Execution order is critical:
 * 1. Validate environment
 * 2. Initialize client
 * 3. Load commands
 * 4. Register event handlers
 * 5. Connect database
 * 6. Authenticate with Discord
 *
 * This guarantees all dependencies are ready before handling interactions.
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
 * Global fatal error handler.
 *
 * Ensures that unrecoverable startup failures:
 * - Are logged for debugging
 * - Terminate the process with a non-zero exit code
 */
bootstrap().catch(error => {
	console.error("Fatal startup error:", error)
	process.exit(1)
})
