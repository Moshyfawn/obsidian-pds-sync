/** `pds_publish` replaces `publish`, a property Obsidian Publish owns. */

export const FLAG_PRIVATE = "pds";
export const FLAG_PUBLIC = "pds_publish";

export type FlagKey = typeof FLAG_PRIVATE | typeof FLAG_PUBLIC;

const TRUE_TEXT = new Set(["true", "yes", "on"]);

/** Obsidian may store the flag as text instead of a checkbox, so accept both. */
export function flagged(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string")
		return TRUE_TEXT.has(value.trim().toLowerCase());
	return false;
}
