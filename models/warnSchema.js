/**
 * @file warnSchema.js
 * @description Alternative warning-history model.
 *
 * This file intentionally demonstrates a second valid persistence strategy: warnings can be stored either inside the main GuildUser
 * document or in a dedicated collection. Keeping this model documented shows awareness of schema trade-offs,
 * migration paths and extensibility patterns.
 */

const mongoose = require("mongoose")

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
		_id: true,
	},
)

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

warnSchema.index({ GuildID: 1, UserID: 1 }, { unique: true })

warnSchema.methods.addWarning = async function addWarning(moderatorId, reason) {
	this.Content.push({
		moderatorId,
		reason: String(reason).trim(),
	})

	await this.save()
	return this
}

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

module.exports = mongoose.model("warnSchema", warnSchema)
