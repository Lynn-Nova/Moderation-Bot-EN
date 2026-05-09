/**
 * @file GuildConfig.js
 * @description Per-guild configuration model for persistent bot settings.
 *
 * Architectural purpose:
 * Centralizes all guild-specific configuration in a single MongoDB document,
 * enabling runtime customization without redeployment or environment variable changes.
 *
 * Design rationale for a separate collection (vs embedding in GuildUser):
 * - Guild config is a singleton per guild; user records are 1-per-user.
 *   Mixing them would violate single-responsibility and complicate queries.
 * - Config reads happen on every message event — keeping it small and indexed
 *   by guildId alone makes those lookups as fast as possible.
 * - Separating concerns allows config to evolve independently from user data.
 *
 * Caching strategy:
 * Callers are responsible for caching the returned document in memory
 * (e.g., via a Map keyed by guildId) to avoid redundant DB reads on
 * high-frequency events like messageCreate. The static `getOrCreate`
 * helper returns a live Mongoose document so callers can call `.save()`
 * after mutations.
 */

const mongoose = require("mongoose")

/**
 * Schema for the AutoMod configuration block.
 *
 * Embedded as a subdocument inside GuildConfig so that all AutoMod fields
 * can be read and validated atomically. Using a nested schema (rather than
 * a plain Mixed type) enforces field-level validation and provides
 * self-documenting defaults.
 */
const autoModConfigSchema = new mongoose.Schema(
	{
		/**
		 * Master switch for the AutoMod system.
		 * When false, the messageCreate handler performs a single field check
		 * and exits immediately — zero performance cost.
		 */
		enabled: {
			type: Boolean,
			default: false,
		},

		/**
		 * List of exact-match or substring banned phrases.
		 * Stored in lowercase for case-insensitive matching at query time.
		 *
		 * Design note:
		 * Storing raw strings (not RegExp) keeps Mongo serialization simple.
		 * The matching logic in the event handler converts both the message
		 * content and the list entries to lowercase before comparison.
		 */
		bannedWords: {
			type: [String],
			default: [],
		},

		/**
		 * Anti-spam: maximum messages a user may send in `spamWindowMs`.
		 * A value of 0 disables the spam check without toggling `enabled`.
		 */
		maxMessagesPerWindow: {
			type: Number,
			default: 5,
			min: 0,
		},

		/**
		 * Rolling window duration (milliseconds) for the spam detector.
		 * Default: 5 000 ms (5 seconds).
		 *
		 * Implementation note:
		 * This window is enforced in-memory via a per-user timestamp array,
		 * not in the database — storing it here makes the threshold
		 * configurable per guild without a code change.
		 */
		spamWindowMs: {
			type: Number,
			default: 5_000,
			min: 1_000,
		},

		/**
		 * AutoMod action applied when a violation is detected.
		 * Supported values: "delete", "warn", "mute", "timeout", "kick", "ban"
		 *
		 * "delete" — removes the offending message only (no user punishment).
		 * "warn"   — deletes + adds a warning entry to GuildUser.
		 * "timeout"— deletes + applies a Discord timeout.
		 * "kick"   — deletes + kicks the member.
		 * "ban"    — deletes + bans the member permanently.
		 */
		action: {
			type: String,
			enum: ["delete", "warn", "mute", "timeout", "kick", "ban"],
			default: "warn",
		},

		/**
		 * Timeout duration (minutes) applied when action === "timeout".
		 * Ignored for all other action types.
		 */
		timeoutDurationMinutes: {
			type: Number,
			default: 10,
			min: 1,
			max: 40_320, // Discord's maximum (28 days)
		},

		/**
		 * Channel ID where AutoMod action logs are posted.
		 * Null means logging is disabled.
		 */
		logChannelId: {
			type: String,
			default: null,
		},

		/**
		 * Role IDs exempt from AutoMod checks.
		 * Members holding any of these roles bypass all AutoMod rules.
		 *
		 * Typical use: moderator roles, bot roles, trusted community roles.
		 */

		/**
		 * Role ID assigned to muted users when action === "mute".
		 * Created automatically by the setup panel if it does not exist.
		 * Null means no mute role is configured.
		 */
		muteRoleId: {
			type: String,
			default: null,
		},

				exemptRoleIds: {
			type: [String],
			default: [],
		},
	},
	{ _id: false }, // Embedded subdocument — no separate ObjectId needed
)

/**
 * Root schema for per-guild bot configuration.
 */

/**
 * Schema for the ticket panel configuration block.
 * Stores all customization options for the /ticket-setup panel.
 */
const ticketPanelSchema = new mongoose.Schema(
	{
		title: { type: String, default: null },
		description: { type: String, default: null },
		color: { type: String, default: null },
		buttonLabel: { type: String, default: null },
		buttonEmoji: { type: String, default: null },
		/**
		 * Channel ID where ticket transcripts (.txt files) are posted on /close.
		 * Null means transcripts are DM'd to the moderator who closed the ticket.
		 */
		logChannelId: { type: String, default: null },
	},
	{ _id: false },
)

const guildConfigSchema = new mongoose.Schema(
	{
		/**
		 * Discord guild (server) snowflake ID.
		 * Primary lookup key — indexed for O(log n) reads.
		 */
		guildId: {
			type: String,
			required: true,
			unique: true,
			index: true,
		},

		/**
		 * AutoMod subsystem configuration.
		 * Embedded as a typed subdocument (not Mixed) to retain schema validation.
		 */
		autoMod: {
			type: autoModConfigSchema,
			default: () => ({}), // Factory default — ensures subdocument defaults apply
		},
		ticketPanel: {
			type: ticketPanelSchema,
			default: () => ({}),
		},
	},
	{
		timestamps: true, // createdAt / updatedAt for auditing config changes
	},
)

// ─── Static helpers ───────────────────────────────────────────────────────────

/**
 * Retrieves the config document for a guild, creating it with defaults if absent.
 *
 * Uses an atomic findOneAndUpdate + upsert to avoid race conditions in
 * multi-process or cluster deployments where two shards might simultaneously
 * try to create the first config for a guild.
 *
 * @param {string} guildId - Discord guild snowflake ID
 * @returns {Promise<Document>} Live Mongoose document (mutations can be saved)
 */
guildConfigSchema.statics.getOrCreate = async function getOrCreate(guildId) {
	return this.findOneAndUpdate(
		{ guildId },
		{ $setOnInsert: { guildId } },
		{
			upsert: true,
			returnDocument: "after",
			setDefaultsOnInsert: true,
		},
	)
}

module.exports = mongoose.model("GuildConfig", guildConfigSchema)

// NOTE: muteRoleId field added to autoModConfigSchema after initial creation
// This is handled by adding it to the schema definition above in the actual file.