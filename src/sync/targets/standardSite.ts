import type { AtpClient } from "../../atproto/client";
import { markdownToPlain } from "../../util/markdown";
import { casPush, rkeyFromUri } from "../push";
import type {
	NoteInput,
	PulledNote,
	PushResult,
	RemoteRef,
	SyncTarget,
} from "../target";

/**
 * Public publishing backend: one note -> one `site.standard.document` record,
 * with the body as an `at.markpub.markdown` content block plus a plaintext
 * `textContent` fallback.
 */
export class StandardSiteTarget implements SyncTarget {
	readonly id = "standard-site" as const;
	readonly label = "standard.site (public)";

	constructor(
		readonly collection: string,
		private readonly publicationUri: string,
	) {}

	isReady(): boolean {
		return this.publicationUri.trim().length > 0;
	}

	readyError(): string {
		return "Set a publication URI (at:// or https://) in PDS Sync settings before publishing.";
	}

	private buildRecord(note: NoteInput): Record<string, unknown> {
		const record: Record<string, unknown> = {
			$type: this.collection,
			site: this.publicationUri,
			title: note.title.slice(0, 5000),
			publishedAt: note.publishedAt,
			// markpub-aware readers render this; textContent is the required plaintext fallback.
			content: {
				$type: "at.markpub.markdown",
				flavor: "gfm",
				text: { $type: "at.markpub.text", markdown: note.markdown },
			},
			textContent: markdownToPlain(note.markdown).slice(0, 30000),
		};
		if (note.slug)
			record.path = note.slug.startsWith("/")
				? note.slug
				: `/${note.slug}`;
		if (note.updatedAt) record.updatedAt = note.updatedAt;
		return record;
	}

	private decode(
		uri: string,
		cid: string,
		value: Record<string, unknown>,
	): PulledNote | null {
		const v = value as {
			site?: string;
			title?: string;
			textContent?: string;
			path?: string;
			publishedAt?: string;
			updatedAt?: string;
			content?: { $type?: string; text?: { markdown?: string } };
		};
		// Scope to our publication - site.standard.document is shared with other tools.
		if (v.site !== this.publicationUri) return null;
		const rkey = rkeyFromUri(uri);
		const slug = (v.path ?? "").replace(/^\/+/, "");
		const markdown =
			v.content?.$type === "at.markpub.markdown"
				? (v.content.text?.markdown ?? v.textContent ?? "")
				: (v.textContent ?? "");
		return {
			ref: { rkey, cid, uri },
			note: {
				path: slug || sanitizeFilename(v.title ?? rkey),
				title: v.title ?? "Untitled",
				markdown,
				publishedAt: v.publishedAt ?? new Date(0).toISOString(),
				updatedAt: v.updatedAt,
			},
		};
	}

	async push(
		client: AtpClient,
		note: NoteInput,
		existing?: RemoteRef,
	): Promise<PushResult> {
		return casPush(
			client,
			this.collection,
			this.buildRecord(note),
			existing,
			(u, c, v) => Promise.resolve(this.decode(u, c, v)),
		);
	}

	async delete(client: AtpClient, ref: RemoteRef): Promise<void> {
		await client.deleteRecord(this.collection, ref.rkey);
	}

	async list(client: AtpClient): Promise<PulledNote[]> {
		const out: PulledNote[] = [];
		let cursor: string | undefined;
		do {
			const page = await client.listRecords(this.collection, {
				limit: 100,
				cursor,
			});
			for (const rec of page.records) {
				const note = this.decode(rec.uri, rec.cid, rec.value);
				if (note) out.push(note);
			}
			cursor = page.cursor;
		} while (cursor);
		return out;
	}
}

function sanitizeFilename(name: string): string {
	return (
		name
			.replace(/[\\/:*?"<>|#^[\]]/g, "-")
			.trim()
			.slice(0, 120) || "untitled"
	);
}
