import { Client } from "@atcute/client";
// Registers the com.atproto.* lexicon types so the XRPC calls below typecheck.
import type {} from "@atcute/atproto";

/**
 * Thin facade over @atcute/client for the repo ops the sync engine needs.
 * Auth + transport live in the `handler` (PasswordSession / OAuthUserAgent, see
 * auth.ts); errors surface as XrpcError so callers can drive compare-and-swap recovery.
 */

export interface WriteResult {
	uri: string;
	cid: string;
}

export interface ListedRecord {
	uri: string;
	cid: string;
	value: Record<string, unknown>;
}

/** An XRPC call that returned a lexicon error; `code` is the atproto error name (e.g. "InvalidSwap"). */
export class XrpcError extends Error {
	constructor(
		readonly code: string | undefined,
		message: string,
	) {
		super(message);
		this.name = "XrpcError";
	}
}

interface XrpcResponse {
	ok: boolean;
	status: number;
	data: unknown;
}

export class AtpClient {
	private rpc: Client | null = null;
	private _did: string | null = null;
	private _handle: string | null = null;

	attach(rpc: Client, did: string, handle?: string): void {
		this.rpc = rpc;
		this._did = did;
		this._handle = handle ?? null;
	}

	detach(): void {
		this.rpc = null;
		this._did = null;
		this._handle = null;
	}

	get did(): string | null {
		return this._did;
	}

	get handle(): string | null {
		return this._handle;
	}

	get isLoggedIn(): boolean {
		return this.rpc !== null && this._did !== null;
	}

	async ensureHandle(): Promise<void> {
		if (this._handle || !this.rpc || !this._did) return;
		const res = (await this.rpc.get("com.atproto.repo.describeRepo", {
			params: { repo: this._did } as never,
		})) as XrpcResponse;
		if (res.ok) {
			const handle = (res.data as { handle?: unknown }).handle;
			if (typeof handle === "string") this._handle = handle;
		}
	}

	async createRecord(
		collection: string,
		record: Record<string, unknown>,
		rkey?: string,
	): Promise<WriteResult> {
		const { rpc, did } = this.ctx();
		const input: Record<string, unknown> = {
			repo: did,
			collection,
			record,
		};
		if (rkey) input.rkey = rkey;
		const res = (await rpc.post("com.atproto.repo.createRecord", {
			input: input as never,
		})) as XrpcResponse;
		return this.unwrap<WriteResult>(res, "createRecord");
	}

	async putRecord(
		collection: string,
		rkey: string,
		record: Record<string, unknown>,
		swapRecord?: string,
	): Promise<WriteResult> {
		const { rpc, did } = this.ctx();
		const input: Record<string, unknown> = {
			repo: did,
			collection,
			rkey,
			record,
		};
		if (swapRecord) input.swapRecord = swapRecord;
		const res = (await rpc.post("com.atproto.repo.putRecord", {
			input: input as never,
		})) as XrpcResponse;
		return this.unwrap<WriteResult>(res, "putRecord");
	}

	/** Returns the opaque blob ref to embed in a record (e.g. a publication icon). */
	async uploadBlob(bytes: ArrayBuffer, mime: string): Promise<unknown> {
		const { rpc } = this.ctx();
		const blob = new Blob([bytes], { type: mime });
		const res = (await rpc.post("com.atproto.repo.uploadBlob", {
			input: blob as never,
		})) as XrpcResponse;
		return this.unwrap<{ blob: unknown }>(res, "uploadBlob").blob;
	}

	async deleteRecord(collection: string, rkey: string): Promise<void> {
		const { rpc, did } = this.ctx();
		const res = (await rpc.post("com.atproto.repo.deleteRecord", {
			input: { repo: did, collection, rkey } as never,
		})) as XrpcResponse;
		this.unwrap(res, "deleteRecord");
	}

	async listRecords(
		collection: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<{ records: ListedRecord[]; cursor?: string }> {
		const { rpc, did } = this.ctx();
		const params: Record<string, unknown> = {
			repo: did,
			collection,
			limit: opts.limit ?? 50,
		};
		if (opts.cursor) params.cursor = opts.cursor;
		const res = (await rpc.get("com.atproto.repo.listRecords", {
			params: params as never,
		})) as XrpcResponse;
		const data = this.unwrap<{ records?: ListedRecord[]; cursor?: string }>(
			res,
			"listRecords",
		);
		return { records: data.records ?? [], cursor: data.cursor };
	}

	/** Fetch a single record, or null if it doesn't exist (used for CAS disambiguation). */
	async getRecordRaw(
		collection: string,
		rkey: string,
	): Promise<{
		uri: string;
		cid: string;
		value: Record<string, unknown>;
	} | null> {
		const { rpc, did } = this.ctx();
		const res = (await rpc.get("com.atproto.repo.getRecord", {
			params: { repo: did, collection, rkey } as never,
		})) as XrpcResponse;
		if (!res.ok) {
			const code = (res.data as { error?: string } | undefined)?.error;
			if (res.status === 404 || code === "RecordNotFound") return null;
			throw new XrpcError(
				code,
				`getRecord (${res.status}): ${code ?? "request failed"}`,
			);
		}
		const d = res.data as {
			uri: string;
			cid?: string;
			value: Record<string, unknown>;
		};
		return { uri: d.uri, cid: d.cid ?? "", value: d.value };
	}

	private ctx(): { rpc: Client; did: string } {
		if (!this.rpc || !this._did) {
			throw new Error("Not connected - sign in from PDS Sync settings.");
		}
		return { rpc: this.rpc, did: this._did };
	}

	private unwrap<T>(res: XrpcResponse, nsid: string): T {
		if (res.ok) return res.data as T;
		const d = res.data as { error?: string; message?: string } | undefined;
		throw new XrpcError(
			d?.error,
			`${nsid} (${res.status}): ${d?.message ?? d?.error ?? "request failed"}`,
		);
	}
}
