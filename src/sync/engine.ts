import { type App, Notice, TFile, normalizePath } from "obsidian";
import type { AtpClient } from "../atproto/client";
import type { PdsSyncSettings } from "../settings";
import {
	applyIndex,
	clearIndex,
	INDEX_KEYS,
	readIndex,
	writeIndex,
	type SyncIndex,
} from "./frontmatter";
import { stripFrontmatter } from "../util/markdown";
import { shortHash, stableStringify } from "../util/hash";
import type {
	NoteInput,
	PulledNote,
	RemoteRef,
	SyncTarget,
	TargetId,
} from "./target";

export interface SyncOutcome {
	created: number;
	updated: number;
	deleted: number;
	conflicts: number;
	skipped: number;
	failed: number;
	errors: string[];
}

/** Frontmatter-aware content hash, so any change (body or user frontmatter) is detected. */
function noteHash(
	targetId: TargetId,
	note: {
		frontmatter?: Record<string, unknown>;
		title: string;
		markdown: string;
	},
): Promise<string> {
	return shortHash(
		`${targetId}\n${stableStringify(note.frontmatter ?? {})}\n${note.title}\n${note.markdown}`,
	);
}

export interface PullOutcome {
	restored: number;
	updated: number;
	deleted: number;
	conflicts: number;
	skipped: number;
	failed: number;
	errors: string[];
}

/**
 * Backend-agnostic sync orchestrator. One record per note, last-write-wins
 * (the PDS gives records, not merges): push hashes each note and creates /
 * updates / skips against the frontmatter index; pull reconciles remote
 * changes and deletions back into the vault with conflict copies.
 */
export class SyncEngine {
	constructor(
		private readonly app: App,
		private readonly client: AtpClient,
		private readonly settings: PdsSyncSettings,
		private readonly targets: Map<TargetId, SyncTarget>,
	) {}

	/**
	 * Decide which backend a note goes to, or null to skip/unpublish it.
	 *
	 * Routing is driven purely by the user's intent flags (`publish` / `pds`),
	 * NOT by our own `pds_target` index key - otherwise setting `publish: false`
	 * couldn't unpublish, because the index would keep forcing a sync.
	 */
	private selectTarget(
		frontmatter: Record<string, unknown> | undefined,
	): SyncTarget | null {
		const fm = frontmatter ?? {};
		if (fm["publish"] === true)
			return this.targets.get("standard-site") ?? null;
		if (fm["pds"] === true) return this.targets.get("e2ee-pds") ?? null;
		return null; // opt-in by default; false/absent flag -> unpublish if previously synced
	}

	private inScope(file: TFile): boolean {
		const folder = this.settings.syncFolder.trim();
		if (!folder) return true;
		const prefix = normalizePath(folder) + "/";
		return file.path === folder || file.path.startsWith(prefix);
	}

	/** A note's body, resolved title, and user frontmatter (our index keys stripped). */
	private async localParts(
		file: TFile,
		fm?: Record<string, unknown>,
	): Promise<{
		body: string;
		title: string;
		frontmatter: Record<string, unknown>;
	}> {
		const front =
			fm ?? this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const body = stripFrontmatter(await this.app.vault.cachedRead(file));
		const title =
			typeof front["title"] === "string" && front["title"].trim()
				? front["title"].trim()
				: file.basename;
		const frontmatter: Record<string, unknown> = { ...front };
		for (const k of INDEX_KEYS) delete frontmatter[k];
		return { body, title, frontmatter };
	}

	private async toNoteInput(
		file: TFile,
		fm: Record<string, unknown>,
	): Promise<NoteInput> {
		const { body, title, frontmatter } = await this.localParts(file, fm);
		const slug =
			typeof fm["slug"] === "string" ? fm["slug"] : undefined;
		const published =
			typeof fm["publishedAt"] === "string"
				? fm["publishedAt"]
				: new Date(file.stat.ctime).toISOString();
		return {
			path: file.path,
			title,
			markdown: body,
			slug,
			publishedAt: published,
			updatedAt: new Date(file.stat.mtime).toISOString(),
			frontmatter,
		};
	}

	async syncFile(file: TFile, outcome: SyncOutcome): Promise<void> {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		if (!this.inScope(file)) return;

		const prevAtStart = readIndex(fm);
		const target = this.selectTarget(fm);
		if (!target) {
			// Was synced before but the flag is now gone -> unpublish: delete the remote record.
			if (prevAtStart) {
				try {
					await this.targets
						.get(prevAtStart.target)
						?.delete(this.client, prevAtStart.ref);
					await clearIndex(this.app, file);
					console.debug(
						`[pds-sync] ${file.path}: flag removed -> deleted remote record`,
					);
					outcome.deleted++;
				} catch (err) {
					outcome.failed++;
					outcome.errors.push(
						`${file.path}: unpublish failed - ${errText(err)}`,
					);
				}
			} else {
				console.debug(`[pds-sync] ${file.path}: no backend selected -> skip`);
				outcome.skipped++;
			}
			return;
		}
		if (!target.isReady()) {
			outcome.failed++;
			outcome.errors.push(`${file.path}: ${target.readyError()}`);
			return;
		}

		try {
			const note = await this.toNoteInput(file, fm ?? {});
			const hash = await noteHash(target.id, note);

			if (
				prevAtStart &&
				prevAtStart.target === target.id &&
				prevAtStart.hash === hash
			) {
				console.debug(
					`[pds-sync] ${file.path}: unchanged (${target.id}) -> skip`,
				);
				outcome.skipped++;
				return;
			}

			// Note switched backends -> delete the now-orphaned record on the old one.
			if (prevAtStart && prevAtStart.target !== target.id) {
				const old = prevAtStart;
				await this.targets
					.get(old.target)
					?.delete(this.client, old.ref)
					.catch((err) =>
						console.warn(
							`[pds-sync] ${file.path}: old ${old.target} record not deleted:`,
							err,
						),
					);
			}

			const existing =
				prevAtStart && prevAtStart.target === target.id
					? prevAtStart.ref
					: undefined;
			const flagKey = target.id === "standard-site" ? "publish" : "pds";
			const result = await target.push(this.client, note, existing);

			if (result.status === "conflict") {
				// Remote changed under us. Preserve it as a conflict copy and adopt
				// the remote as our new base; the local edit re-pushes next sync.
				const remoteHash = await noteHash(target.id, result.remote.note);
				const cpath = conflictPath(file.path, result.current.rkey);
				await this.writeRemoteNote(
					cpath,
					result.remote.note,
					result.current,
					remoteHash,
					target.id,
					flagKey,
					false,
				);
				await writeIndex(this.app, file, {
					target: target.id,
					ref: result.current,
					hash: remoteHash,
					syncedAt: new Date().toISOString(),
				});
				console.warn(
					`[pds-sync] ${file.path}: remote changed externally -> wrote conflict copy ${cpath}; local re-pushes next sync`,
				);
				outcome.conflicts++;
				return;
			}

			await writeIndex(this.app, file, {
				target: target.id,
				ref: result.ref,
				hash,
				syncedAt: new Date().toISOString(),
			});
			if (existing) {
				console.debug(`[pds-sync] ${file.path}: updated ${result.ref.uri}`);
				outcome.updated++;
			} else {
				console.debug(`[pds-sync] ${file.path}: created ${result.ref.uri}`);
				outcome.created++;
			}
		} catch (err) {
			outcome.failed++;
			outcome.errors.push(
				`${file.path}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	async syncVault(): Promise<SyncOutcome> {
		const outcome: SyncOutcome = {
			created: 0,
			updated: 0,
			deleted: 0,
			conflicts: 0,
			skipped: 0,
			failed: 0,
			errors: [],
		};
		if (!this.client.isLoggedIn) {
			new Notice("PDS Sync: not logged in - check settings.");
			outcome.errors.push("not logged in");
			return outcome;
		}
		const files = this.app.vault.getMarkdownFiles();
		for (const file of files) {
			await this.syncFile(file, outcome);
		}
		return outcome;
	}

	/**
	 * Pull each backend into the vault: restore missing notes, remote-wins update unchanged ones,
	 * conflict-copy when both sides changed, and reflect remote deletions.
	 */
	async pull(): Promise<PullOutcome> {
		const outcome: PullOutcome = {
			restored: 0,
			updated: 0,
			deleted: 0,
			conflicts: 0,
			skipped: 0,
			failed: 0,
			errors: [],
		};
		if (!this.client.isLoggedIn) {
			new Notice("PDS Sync: not logged in - check settings.");
			outcome.errors.push("not logged in");
			return outcome;
		}
		const targets = (["e2ee-pds", "standard-site"] as TargetId[])
			.map((id) => this.targets.get(id))
			.filter((t): t is SyncTarget => !!t && t.isReady());
		if (targets.length === 0) {
			outcome.errors.push(
				"no ready backend to pull from (set a passphrase and/or publication)",
			);
			outcome.failed++;
			return outcome;
		}

		const byRkey = new Map<string, TFile>();
		const localIndexed: { file: TFile; idx: SyncIndex }[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const idx = readIndex(
				this.app.metadataCache.getFileCache(file)?.frontmatter,
			);
			if (!idx) continue;
			byRkey.set(idx.ref.rkey, file);
			localIndexed.push({ file, idx });
		}

		// Each backend pulls only its own scope (e2ee = our collection; standard-site =
		// only documents in our publication).
		for (const target of targets) {
			const flagKey = target.id === "standard-site" ? "publish" : "pds";
			let pulled: PulledNote[];
			try {
				pulled = await target.list(this.client);
			} catch (err) {
				outcome.failed++;
				outcome.errors.push(`${target.id}: ${errText(err)}`);
				continue;
			}
			const remoteRkeys = new Set(pulled.map((p) => p.ref.rkey));

			// 1. Remote -> local: restore / remote-wins update / conflict copy.
			for (const p of pulled) {
				try {
					await this.reconcile(target.id, flagKey, p, byRkey, outcome);
				} catch (err) {
					outcome.failed++;
					outcome.errors.push(`${p.ref.rkey}: ${errText(err)}`);
				}
			}

			// 2. This backend's local notes whose record is gone remotely -> reflect deletion.
			for (const { file, idx } of localIndexed) {
				if (idx.target !== target.id || remoteRkeys.has(idx.ref.rkey)) continue;
				try {
					await this.handleRemoteDeletion(target.id, file, idx, outcome);
				} catch (err) {
					outcome.failed++;
					outcome.errors.push(`${file.path}: ${errText(err)}`);
				}
			}
		}
		return outcome;
	}

	/** A record was deleted on the PDS. Trash the local note if unchanged; keep it if edited. */
	private async handleRemoteDeletion(
		targetId: TargetId,
		file: TFile,
		idx: SyncIndex,
		outcome: PullOutcome,
	): Promise<void> {
		const { body, title, frontmatter } = await this.localParts(file);
		const localHash = await noteHash(targetId, {
			frontmatter,
			title,
			markdown: body,
		});

		if (localHash === idx.hash) {
			await this.app.fileManager.trashFile(file); // recoverable; respects user setting
			console.debug(
				`[pds-sync] ${file.path}: deleted on PDS -> trashed locally`,
			);
			outcome.deleted++;
		} else {
			console.warn(
				`[pds-sync] ${file.path}: deleted on PDS but has local edits - kept locally (re-sync to re-publish).`,
			);
			outcome.conflicts++;
		}
	}

	private async reconcile(
		targetId: TargetId,
		flagKey: "pds" | "publish",
		p: PulledNote,
		byRkey: Map<string, TFile>,
		outcome: PullOutcome,
	): Promise<void> {
		const remoteHash = await noteHash(targetId, p.note);
		const local = byRkey.get(p.ref.rkey);

		if (!local) {
			await this.writeRemoteNote(
				p.note.path,
				p.note,
				p.ref,
				remoteHash,
				targetId,
				flagKey,
				false,
			);
			outcome.restored++;
			return;
		}

		const idx = readIndex(
			this.app.metadataCache.getFileCache(local)?.frontmatter,
		);
		if (idx && idx.ref.cid === p.ref.cid) {
			outcome.skipped++; // remote unchanged since last sync
			return;
		}

		// Remote changed. Did the local note change too?
		const { body, title, frontmatter } = await this.localParts(local);
		const localHash = await noteHash(targetId, {
			frontmatter,
			title,
			markdown: body,
		});

		if (idx && localHash === idx.hash) {
			await this.writeRemoteNote(
				local.path,
				p.note,
				p.ref,
				remoteHash,
				targetId,
				flagKey,
				true,
			);
			outcome.updated++;
		} else {
			const conflict = conflictPath(local.path, p.ref.rkey);
			await this.writeRemoteNote(
				conflict,
				p.note,
				p.ref,
				remoteHash,
				targetId,
				flagKey,
				false,
			);
			outcome.conflicts++;
		}
	}

	/** Write a remote note to disk (body + reconstructed index/frontmatter). */
	private async writeRemoteNote(
		path: string,
		note: NoteInput,
		ref: RemoteRef,
		hash: string,
		targetId: TargetId,
		flagKey: "pds" | "publish",
		overwrite: boolean,
	): Promise<void> {
		let norm = normalizePath(path.endsWith(".md") ? path : `${path}.md`);
		if (!overwrite && this.app.vault.getAbstractFileByPath(norm)) {
			norm = normalizePath(`${norm.replace(/\.md$/, "")} (pds ${ref.rkey}).md`);
		}
		await this.ensureParent(norm);

		const current = this.app.vault.getAbstractFileByPath(norm);
		let file: TFile;
		if (current instanceof TFile) {
			await this.app.vault.modify(current, note.markdown);
			file = current;
		} else {
			file = await this.app.vault.create(norm, note.markdown);
		}

		await this.app.fileManager.processFrontMatter(
			file,
			(fm: Record<string, unknown>) => {
				if (note.frontmatter) {
					for (const [k, v] of Object.entries(note.frontmatter))
						fm[k] = v;
				}
				if (fm["title"] === undefined) fm["title"] = note.title;
				fm[flagKey] = true;
				applyIndex(fm, {
					target: targetId,
					ref,
					hash,
					syncedAt: new Date().toISOString(),
				});
			},
		);
	}

	private async ensureParent(path: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash <= 0) return;
		const dir = path.slice(0, slash);
		if (!this.app.vault.getAbstractFileByPath(dir)) {
			await this.app.vault.createFolder(dir).catch(() => undefined);
		}
	}
}

function conflictPath(localPath: string, rkey: string): string {
	const base = localPath.replace(/\.md$/, "");
	return `${base} (remote ${rkey}).md`;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
