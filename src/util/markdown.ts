/**
 * Frontmatter-aware markdown helpers.
 *
 * Obsidian's metadata cache parses frontmatter for us (we use it for values),
 * but syncing needs the *body* with the block removed. We strip it from the
 * freshly-read text rather than slicing by the cache's frontmatterPosition /
 * headings, which are snapshots that can lag a file that just changed - these
 * operate on the exact bytes we're about to push, so they can't drift.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Strip a leading YAML frontmatter block, returning just the note body. */
export function stripFrontmatter(content: string): string {
	return content.replace(FRONTMATTER_RE, "").replace(/^\s+/, "");
}

/** Light markdown -> plaintext, for the `textContent` fallback (which must not contain formatting). */
export function markdownToPlain(md: string): string {
	return md
		.replace(/```[\s\S]*?```/g, "") // fenced code
		.replace(/`([^`]+)`/g, "$1") // inline code
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> text
		.replace(/^#{1,6}\s+/gm, "") // headings
		.replace(/^\s{0,3}>\s?/gm, "") // blockquotes
		.replace(/^\s*[-*+]\s+/gm, "") // bullet markers
		.replace(/[*_~]/g, "") // emphasis
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
