import { type App, type TFile } from "obsidian";
import type { RemoteRef, TargetId } from "./target";

/**
 * The per-note sync index, stored in the note's own frontmatter.
 *
 * This is our "git index": it records which backend a note went to, the remote
 * record pointer (rkey/cid), and a content hash so the next run can decide
 * create / update / skip cheaply. Writes go through FileManager.processFrontMatter
 * so they are atomic and don't fight other plugins or corrupt YAML.
 */

export interface SyncIndex {
	target: TargetId;
	ref: RemoteRef;
	hash: string;
	syncedAt: string;
}

const KEY = {
	target: "pds_target",
	rkey: "pds_rkey",
	cid: "pds_cid",
	uri: "pds_uri",
	hash: "pds_hash",
	syncedAt: "pds_synced_at",
} as const;

/** Our own frontmatter keys - stripped from user frontmatter before storing/hashing. */
export const INDEX_KEYS: readonly string[] = Object.values(KEY);

/** Read the index from already-parsed frontmatter (from the metadata cache). */
export function readIndex(
	frontmatter: Record<string, unknown> | undefined,
): SyncIndex | null {
	if (!frontmatter) return null;
	const rkey = frontmatter[KEY.rkey];
	const cid = frontmatter[KEY.cid];
	const target = frontmatter[KEY.target];
	const hash = frontmatter[KEY.hash];
	if (
		typeof rkey !== "string" ||
		typeof cid !== "string" ||
		typeof target !== "string"
	) {
		return null;
	}
	return {
		target: target as TargetId,
		ref: {
			rkey,
			cid,
			uri:
				typeof frontmatter[KEY.uri] === "string"
					? (frontmatter[KEY.uri] as string)
					: "",
		},
		hash: typeof hash === "string" ? hash : "",
		syncedAt:
			typeof frontmatter[KEY.syncedAt] === "string"
				? (frontmatter[KEY.syncedAt] as string)
				: "",
	};
}

/** Mutate a frontmatter object with the index keys (combine with other edits in one write). */
export function applyIndex(
	fm: Record<string, unknown>,
	index: SyncIndex,
): void {
	fm[KEY.target] = index.target;
	fm[KEY.rkey] = index.ref.rkey;
	fm[KEY.cid] = index.ref.cid;
	fm[KEY.uri] = index.ref.uri;
	fm[KEY.hash] = index.hash;
	fm[KEY.syncedAt] = index.syncedAt;
}

/** Atomically persist the index back into the note. */
export async function writeIndex(
	app: App,
	file: TFile,
	index: SyncIndex,
): Promise<void> {
	await app.fileManager.processFrontMatter(
		file,
		(fm: Record<string, unknown>) => applyIndex(fm, index),
	);
}

/** Remove the index keys (e.g. after a remote delete). */
export async function clearIndex(app: App, file: TFile): Promise<void> {
	await app.fileManager.processFrontMatter(
		file,
		(fm: Record<string, unknown>) => {
			for (const k of Object.values(KEY)) delete fm[k];
		},
	);
}
