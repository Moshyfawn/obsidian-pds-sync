import type { AtpClient } from "../../atproto/client";
import { decryptJson, encryptJson } from "../../crypto/e2ee";
import { casPush, rkeyFromUri } from "../push";
import type {
	NoteInput,
	PulledNote,
	PushResult,
	RemoteRef,
	SyncTarget,
} from "../target";

interface EncryptedPayload {
	title: string;
	markdown: string;
	path: string;
	publishedAt?: string;
	updatedAt?: string;
	frontmatter?: Record<string, unknown>;
}

/**
 * Private backend: client-side E2EE -> a collection you control on your PDS.
 *
 * The record body is opaque ciphertext, so the PDS and firehose only ever see
 * metadata (existence, timing, size, DID). Content - including title and user
 * frontmatter - stays encrypted. Shaped so the same engine can later target a
 * native private namespace / `ats://` space by swapping this class out.
 */
export class E2eePdsTarget implements SyncTarget {
	readonly id = "e2ee-pds" as const;
	readonly label = "PDS (private, E2E-encrypted)";

	constructor(
		readonly collection: string,
		private readonly key: CryptoKey | null,
	) {}

	isReady(): boolean {
		return this.key !== null;
	}

	readyError(): string {
		return "Set an E2EE passphrase in PDS Sync settings to enable private sync.";
	}

	private async buildRecord(
		note: NoteInput,
	): Promise<Record<string, unknown>> {
		if (!this.key) throw new Error(this.readyError());
		const payload: EncryptedPayload = {
			title: note.title,
			markdown: note.markdown,
			path: note.path,
			publishedAt: note.publishedAt,
			updatedAt: note.updatedAt,
			frontmatter: note.frontmatter,
		};
		return {
			$type: this.collection,
			enc: "AES-256-GCM",
			kdf: "Argon2id",
			// `bytes` field in atproto JSON form - the PDS stores it as compact
			// CBOR bytes rather than base64 text. No envelope timestamp: the repo
			// commit already records write time.
			data: { $bytes: await encryptJson(payload, this.key) },
		};
	}

	private async decode(
		uri: string,
		cid: string,
		value: Record<string, unknown>,
	): Promise<PulledNote | null> {
		if (!this.key) return null;
		const data = (value as { data?: { $bytes?: unknown } }).data?.$bytes;
		if (typeof data !== "string") return null;
		try {
			const p = await decryptJson<EncryptedPayload>(data, this.key);
			return {
				ref: { rkey: rkeyFromUri(uri), cid, uri },
				note: {
					path: p.path,
					title: p.title,
					markdown: p.markdown,
					publishedAt: p.publishedAt ?? new Date(0).toISOString(),
					updatedAt: p.updatedAt,
					frontmatter: p.frontmatter,
				},
			};
		} catch (err) {
			console.warn(
				`[pds-sync] could not decrypt ${uri} (wrong passphrase?):`,
				err,
			);
			return null;
		}
	}

	async push(
		client: AtpClient,
		note: NoteInput,
		existing?: RemoteRef,
	): Promise<PushResult> {
		const record = await this.buildRecord(note);
		return casPush(client, this.collection, record, existing, (u, c, v) =>
			this.decode(u, c, v),
		);
	}

	async delete(client: AtpClient, ref: RemoteRef): Promise<void> {
		await client.deleteRecord(this.collection, ref.rkey);
	}

	async list(client: AtpClient): Promise<PulledNote[]> {
		if (!this.key) throw new Error(this.readyError());
		const out: PulledNote[] = [];
		let cursor: string | undefined;
		do {
			const page = await client.listRecords(this.collection, {
				limit: 100,
				cursor,
			});
			for (const rec of page.records) {
				const note = await this.decode(rec.uri, rec.cid, rec.value);
				if (note) out.push(note);
			}
			cursor = page.cursor;
		} while (cursor);
		return out;
	}
}
