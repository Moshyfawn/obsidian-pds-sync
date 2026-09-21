import type { App } from "obsidian";
import { FLAG_PUBLIC, flagged } from "./flags";
import { readIndex } from "./frontmatter";

/**
 * Only notes this plugin synced carry a `pds_*` index. A note with `publish` and
 * no index belongs to Obsidian Publish, so it is left alone.
 */
export async function migratePublishFlag(app: App): Promise<number> {
	let moved = 0;
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || !flagged(fm["publish"]) || !readIndex(fm)) continue;
		await app.fileManager.processFrontMatter(
			file,
			(f: Record<string, unknown>) => {
				delete f["publish"];
				f[FLAG_PUBLIC] = true;
			},
		);
		moved++;
	}
	return moved;
}
