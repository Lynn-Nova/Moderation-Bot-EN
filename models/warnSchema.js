/**
 * @file warnSchema.js
 * @description Alternative persistence model for storing user warning history.
 *
 * Architectural purpose:
 * This schema demonstrates a different data modeling strategy compared to GuildUser:
 * instead of embedding warnings inside a single document, warnings are stored in a
 * dedicated collection.
 *
 * Design comparison:
 *
 * Embedded model (GuildUser):
 * - Pros:
 *   - Faster reads (single document fetch)
 *   - Simpler queries
 *   - Atomic updates
 * - Cons:
 *   - Document size grows with warning count
 *
 * Separate collection model (this file):
 * - Pros:
 *   - Better scalability for large moderation histories
 *   - More flexible querying (e.g., filtering, pagination)
 *   - Easier to extend (attachments, metadata, audit logs)
 * - Cons:
 *   - Requires additional queries
 *   - Slightly more complex logic
 *
 * Use cases:
 * - Prefer this model when:
 *   - Warning volume is high
 *   - Advanced querying/reporting is required
 * - Prefer embedded model when:
 *   - Simplicity and performance are priorities
 *
 * This file exists to document extensibility and migration paths.
 */

const mongoose = require("mongoose")

/**
 * Subdocument schema representing an individual warning entry.
 *
 * Key difference from embedded version:
 * - `_id` is ENABLED here to uniquely identify each warning entry
 *
 * Rationale:
 * - Enables direct reference, editing, or deletion by ID
 * - Useful for advanced moderation workflows (e.g., audit logs, edits)
 */
const warningEntrySchema = new mongoose.Schema(
	{
		reason: {
			type: String,
			required: true,
			trim: true,
		},
		moderatorId: {
			type: String,
			required: true,
		},
		createdAt: {
			type: Date,
			default: Date.now,
		},
	},
	{
		_id: true, // Each warning has its own identifier
	},
)

/**
 * Main schema representing warning history for a user in a guild.
 *
 * Fields:
 * - GuildID: Discord guild identifier
 * - UserID: Discord user identifier
 * - Content: array of warning entries
 *
 * Design note:
 * This still stores warnings per user, but separates them from
 * other moderation state (tickets, etc.).
 */
const warnSchema = new mongoose.Schema(
	{
		GuildID: {
			type: String,
			required: true,
			index: true,
		},
		UserID: {
			type: String,
			required: true,
			index: true,
		},
		Content: {
			type: [warningEntrySchema],
			default: [],
		},
	},
	{
		timestamps: true,
	},
)

/**
 * Compound unique index ensuring one document per (GuildID, UserID).
 *
 * Purpose:
 * - Prevent duplicate warning histories
 * - Maintain a single authoritative record per user per guild
 */
warnSchema.index({ GuildID: 1, UserID: 1 }, { unique: true })

/**
 * Adds a new warning entry to the user's record.
 *
 * Behavior:
 * - Normalizes reason (trim)
 * - Appends new entry
 * - Persists changes
 *
 * Note:
 * Unlike GuildUser, normalization is handled locally instead of via static helper.
 *
 * @param {string} moderatorId
 * @param {string} reason
 * @returns {Promise<Document>}
 */
warnSchema.methods.addWarning = async function addWarning(moderatorId, reason) {
	this.Content.push({
		moderatorId,
		reason: String(reason).trim(),
	})

	await this.save()
	return this
}

/**
 * Removes a warning entry by its zero-based index.
 *
 * Validation:
 * - Index must be within array bounds
 *
 * Behavior:
 * - Returns null instead of throwing on invalid input
 *
 * Design choice:
 * This differs from GuildUser (which throws an error).
 * It demonstrates an alternative error-handling strategy:
 * - "fail silently with null" vs "fail loudly with exception"
 *
 * @param {number} index
 * @returns {Promise<Object|null>}
 */
warnSchema.methods.removeWarningByIndex = async function removeWarningByIndex(
	index,
) {
	if (!Number.isInteger(index) || index < 0 || index >= this.Content.length) {
		return null
	}

	const removedWarning = this.Content.splice(index, 1)[0]
	await this.save()

	return removedWarning
}

/**
 * Model export.
 *
 * Note:
 * Model name uses "warnSchema" for demonstration,
 * but in production it would typically be renamed to something like "Warning".
 */
module.exports = mongoose.model("warnSchema", warnSchema)
