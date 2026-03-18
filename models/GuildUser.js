/**
 * @file GuildUser.js
 * @description Primary persistence model for moderation state in a guild.
 *
 * This document is strong because:
 * - One document per guild/user pair avoids fragmented state
 * - Warnings remain centralized in a single persistence layer
 * - Model helpers keep business rules close to the data
 * - Indexes protect data integrity at the database level
 */

const mongoose = require("mongoose")

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
		_id: false,
	},
)

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

guildUserSchema.index({ guildId: 1, userId: 1 }, { unique: true })

guildUserSchema.virtual("warningCount").get(function warningCount() {
	return this.warnings.length
})

/**
 * Normalize warning reason text before persistence.
 * This keeps command handlers focused on interaction flow rather than text sanitation.
 */
guildUserSchema.statics.normalizeReason = function normalizeReason(reason) {
	return String(reason).trim().replace(/\s+/g, " ")
}

/**
 * Fetches or creates a guild/user record in a single operation.
 * Centralizing this logic avoids repeated upsert patterns in command handlers.
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
 * Appends a new warning entry to the user's moderation history.
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
 * Removes a warning by its zero-based array index.
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
 * Marks that the user currently has an active ticket.
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
 * Clears the active ticket flag for the user.
 */
guildUserSchema.methods.clearActiveTicket = async function clearActiveTicket() {
	this.activateTicket = false
	this.ticketChannelId = null
	await this.save()
	return this
}

module.exports = mongoose.model("GuildUser", guildUserSchema)
