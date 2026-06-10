import type { AtpClient } from "../atproto/client";

/**
 * A SyncTarget is one backend a note can be pushed to. The engine is backend-
 * agnostic: it diffs notes and calls push/delete. This is the seam that lets us
 * ship public + private today and slot in native atproto private-namespaces or
 * `ats://` spaces later without touching the engine.
 */

/** Stable id for a target. Persisted in note frontmatter as `pds_target`. */
export type TargetId = "standard-site" | "e2ee-pds" | "ats-space";

/** Normalised note ready to push (frontmatter already stripped from body). */
export interface NoteInput {
	/** Vault-relative path, e.g. "notes/idea.md". */
	path: string;
	title: string;
	/** Note body, no frontmatter. */
	markdown: string;
	/** Optional URL slug for public publishing. */
	slug?: string;
	/** ISO timestamp. */
	publishedAt: string;
	/** ISO timestamp, if known. */
	updatedAt?: string;
	/** The note's user frontmatter (minus our index keys) - preserved for private notes. */
	frontmatter?: Record<string, unknown>;
}

/** Pointer to a pushed record. Persisted back into the note's frontmatter. */
export interface RemoteRef {
	rkey: string;
	cid: string;
	uri: string;
}

/** A record fetched from the PDS, decoded back into a note (decrypted if private). */
export interface PulledNote {
	ref: RemoteRef;
	note: NoteInput;
}

/**
 * Outcome of a push. "written" = the record was created/updated/recreated.
 * "conflict" = the remote record changed under us; the caller resolves it
 * (write `remote` as a conflict copy) rather than clobbering.
 */
export type PushResult =
	| { status: "written"; ref: RemoteRef }
	| { status: "conflict"; remote: PulledNote; current: RemoteRef };

export interface SyncTarget {
	readonly id: TargetId;
	/** Collection NSID this target writes to. */
	readonly collection: string;
	/** Human label for notices/logs. */
	readonly label: string;

	/** True if this target is configured well enough to run. */
	isReady(): boolean;
	/** Reason it is not ready, for surfacing to the user. */
	readyError(): string;

	/** Create or update the record for a note (compare-and-swap). `existing` is its prior ref. */
	push(
		client: AtpClient,
		note: NoteInput,
		existing?: RemoteRef,
	): Promise<PushResult>;
	/** Delete the record for an orphaned note. */
	delete(client: AtpClient, ref: RemoteRef): Promise<void>;
	/** Fetch every record in this collection, decoded into notes (for pull/restore). */
	list(client: AtpClient): Promise<PulledNote[]>;
}
