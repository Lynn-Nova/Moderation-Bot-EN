/**
 * @file index.js
 * @description Application bootstrap for the Bot.
 *
 * This module contains:
 * - environment validation before runtime bootstrap
 * - controlled async startup sequence
 * - dynamic command discovery and registration
 * - centralized interaction routing
 * - defensive error handling for Discord API workflows
 * - separation between infrastructure concerns and command execution
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

const REQUIRED_ENV_VARS = ["DISCORD_TOKEN", "MONGO_URI"]
const COMMANDS_DIRECTORY = path.join(__dirname, "commands")
const APPLICATION_GUILD_ID = "860520561943379998"
const TICKET_BUTTON_ID = "open_ticket"

/**
 * Fail fast if a required environment variable is missing.
 * A startup validation step is preferable to letting the application crash later during login or database connection,
 * because the error becomes deterministic and easier to debug during deployment.
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
 * Create the Discord client once and attach a command registry.
 * Collection is used as an in-memory lookup table so command dispatching remains by command name instead of relying on nested if/else or switch blocks.
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

	client.commands = new Collection()
	return client
}

/**
 * Load slash command modules dynamically from disk.
 * Dynamic loading keeps the entry file small and makes the project extensible:
 * adding a new command only requires dropping a valid module into /commands.
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
 * Connect to MongoDB before the bot starts accepting interactions.
 * This ordering avoids a class of bugs where a command is executed while the persistence layer is still unavailable.
 */
async function connectDatabase() {
	await mongoose.connect(process.env.MONGO_URI)
	console.log("🍃 MongoDB connection established successfully.")
}

/**
 * Synchronize slash command metadata with Discord.
 * Registering commands during ready keeps the remote API aligned with the local source code and ensures newly added commands appear without manual dashboard edits.
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
 * Execute command modules behind a small safety boundary.
 * The guard handles both first responses and follow-ups because Discord only allows one initial interaction response.
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
 * Create a support ticket channel while preventing duplicates.
 * Ticket creation is intentionally centralized here because the button event is global application infrastructure, while /ticket-setup only renders the panel.
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
 * Route all interaction types through a single dispatcher.
 * Centralized routing is easier to audit because all entry points are visible in one place.
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

async function bootstrap() {
	validateEnvironment()

	const client = createClient()
	loadCommands(client)
	registerEventHandlers(client)

	await connectDatabase()
	await client.login(process.env.DISCORD_TOKEN)
}

bootstrap().catch(error => {
	console.error("Fatal startup error:", error)
	process.exit(1)
})
