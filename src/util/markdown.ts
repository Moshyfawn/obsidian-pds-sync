import { getFrontMatterInfo } from "obsidian";

/** Works on the file's current text, because the metadata cache can lag a recent edit. */
export function stripFrontmatter(content: string): string {
	return content.slice(getFrontMatterInfo(content).contentStart);
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
