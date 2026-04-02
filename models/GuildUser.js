/**
 * @file GuildUser.js
 * @description Primary persistence model representing a user's moderation state within a guild.
 *
 * Data model strategy:
 * - One document per (guildId, userId) pair ensures a single source of truth
 * - Embeds warnings as a subdocument array for locality and atomic updates
 * - Stores ticket state alongside moderation data for simplified lookup
 *
 * Design advantages:
 * - Eliminates cross-collection joins
 * - Enables atomic updates on warnings and ticket state
 * - Centralizes all moderation-related data in a single document
 *
 * Consistency guarantees:
 * - Unique compound index prevents duplicate records
 * - Model methods encapsulate mutation logic to avoid inconsistent writes
 * - Validation rules enforce data integrity at the schema level
 */

const mongoose = require("mongoose")

/**
 * Subdocument schema representing a single warning entry.
 *
 * Characteristics:
 * - Embedded within the parent document for fast access
 * - Does not have its own _id to reduce storage overhead
 *
 * Fields:
 * - moderatorId: ID of the moderator who issued the warning
 * - reason: normalized reason string (validated and trimmed)
 * - date: timestamp of when the warning was issued
 */
const warningEntrySchema = new mongoose.Schema(
	{
		moderatorId: {
			type: String,
			required: true,
		},
		reason: {
			type: String,
			required: true,
			trim: true,
			maxlength: 500,
		},
		date: {
			type: Date,
			default: Date.now,
		},
	},
	{
		_id: false, // Prevents automatic ObjectId creation for each warning entry
	},
)

/**
 * Main schema representing a user's state within a guild.
 *
 * Fields:
 * - guildId: Discord guild identifier
 * - userId: Discord user identifier
 * - warnings: array of embedded warning entries
 * - activateTicket: indicates whether the user currently has an open ticket
 * - ticketChannelId: reference to the active ticket channel
 *
 * Schema options:
 * - timestamps: automatically tracks createdAt and updatedAt
 * - minimize: false ensures empty objects are persisted (important for consistency)
 */
const guildUserSchema = new mongoose.Schema(
	{
		guildId: {
			type: String,
			required: true,
			index: true,
		},
		userId: {
			type: String,
			required: true,
			index: true,
		},
		warnings: {
			type: [warningEntrySchema],
			default: [],
		},
		activateTicket: {
			type: Boolean,
			default: false,
		},
		ticketChannelId: {
			type: String,
			default: null,
		},
	},
	{
		timestamps: true,
		minimize: false,
	},
)

/**
 * Compound unique index enforcing one document per (guildId, userId).
 *
 * Rationale:
 * - Prevents duplicate records caused by concurrent writes
 * - Ensures all moderation data for a user is centralized
 *
 * Without this constraint, race conditions could create inconsistent state.
 */
guildUserSchema.index({ guildId: 1, userId: 1 }, { unique: true })

/**
 * Virtual property returning the total number of warnings.
 *
 * Characteristics:
 * - Computed at runtime (not stored in database)
 * - Reflects current state of the warnings array
 *
 * Advantage:
 * Avoids redundant storage while still providing convenient access.
 */
guildUserSchema.virtual("warningCount").get(function warningCount() {
	return this.warnings.length
})

/**
 * Normalizes a warning reason string before persistence.
 *
 * Behavior:
 * - Converts input to string
 * - Trims leading/trailing whitespace
 * - Collapses multiple spaces into a single space
 *
 * Rationale:
 * Ensures consistent formatting across all warning entries,
 * regardless of input source.
 *
 * @param {string} reason
 * @returns {string}
 */
guildUserSchema.statics.normalizeReason = function normalizeReason(reason) {
	return String(reason).trim().replace(/\s+/g, " ")
}

/**
 * Retrieves an existing document or creates one if it does not exist.
 *
 * Implementation details:
 * - Uses atomic upsert operation to prevent race conditions
 * - Ensures a valid document is always returned
 *
 * Benefits:
 * - Eliminates repetitive existence checks in command handlers
 * - Guarantees consistency under concurrent access
 *
 * @param {string} guildId
 * @param {string} userId
 * @returns {Promise<Document>}
 */
guildUserSchema.statics.getOrCreate = async function getOrCreate(
	guildId,
	userId,
) {
	return this.findOneAndUpdate(
		{ guildId, userId },
		{
			$setOnInsert: {
				guildId,
				userId,
			},
		},
		{
			upsert: true,
			returnDocument: "after",
			setDefaultsOnInsert: true,
		},
	)
}

/**
 * Adds a new warning entry to the user's record.
 *
 * Execution steps:
 * 1. Normalize reason string
 * 2. Append new warning object to array
 * 3. Persist changes
 *
 * Data integrity:
 * - Always normalizes input
 * - Uses atomic save operation
 *
 * @param {string} moderatorId
 * @param {string} reason
 * @returns {Promise<Document>}
 */
guildUserSchema.methods.addWarning = async function addWarning(
	moderatorId,
	reason,
) {
	const normalizedReason = this.constructor.normalizeReason(reason)

	this.warnings.push({
		moderatorId,
		reason: normalizedReason,
		date: new Date(),
	})

	await this.save()
	return this
}

/**
 * Removes a warning entry by its zero-based index.
 *
 * Validation:
 * - Index must be an integer
 * - Index must be within array bounds
 *
 * Behavior:
 * - Removes the warning entry
 * - Persists updated state
 * - Returns the removed warning object
 *
 * Error handling:
 * Throws RangeError if index is invalid.
 *
 * @param {number} index
 * @returns {Promise<Object>}
 */
guildUserSchema.methods.removeWarningByIndex =
	async function removeWarningByIndex(index) {
		if (
			!Number.isInteger(index) ||
			index < 0 ||
			index >= this.warnings.length
		) {
			throw new RangeError("Invalid warning index.")
		}

		const removedWarning = this.warnings.splice(index, 1)[0]
		await this.save()

		return removedWarning
	}

/**
 * Marks the user as having an active ticket.
 *
 * Behavior:
 * - Sets active flag
 * - Stores associated channel ID
 * - Persists changes
 *
 * @param {string} channelId
 * @returns {Promise<Document>}
 */
guildUserSchema.methods.setActiveTicket = async function setActivateTicket(
	channelId,
) {
	this.activateTicket = true
	this.ticketChannelId = channelId
	await this.save()
	return this
}

/**
 * Clears the user's active ticket state.
 *
 * Behavior:
 * - Resets active flag
 * - Removes stored channel reference
 * - Persists changes
 *
 * Rationale:
 * Prevents stale references after ticket deletion.
 *
 * @returns {Promise<Document>}
 */
guildUserSchema.methods.clearActiveTicket = async function clearActiveTicket() {
	this.activateTicket = false
	this.ticketChannelId = null
	await this.save()
	return this
}

/**
 * Model export.
 *
 * Provides access to:
 * - Static methods (getOrCreate, normalizeReason)
 * - Instance methods (addWarning, removeWarningByIndex, etc.)
 */
module.exports = mongoose.model("GuildUser", guildUserSchema)
