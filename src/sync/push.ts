import { type AtpClient, XrpcError } from "../atproto/client";
import type { PulledNote, PushResult, RemoteRef } from "./target";

export function rkeyFromUri(uri: string): string {
	return uri.split("/").pop() ?? "";
}

function refOf(r: { uri: string; cid: string }): RemoteRef {
	return { rkey: rkeyFromUri(r.uri), cid: r.cid, uri: r.uri };
}

/**
 * Compare-and-swap write shared by every backend - atproto's native concurrency
 * model (`swapRecord` by CID). Behaviour on a stale write (InvalidSwap):
 *  - remote record gone-> recreate it (self-healing push)
 *  - remote changed elsewhere -> return a conflict for the caller to resolve
 *    (we never blindly overwrite a record that drifted under us)
 *
 * `decode` turns the current remote record back into a note so the caller can
 * write a conflict copy. If it can't decode (e.g. wrong key), we adopt the
 * remote as written rather than loop forever.
 */
export async function casPush(
	client: AtpClient,
	collection: string,
	record: Record<string, unknown>,
	existing: RemoteRef | undefined,
	decode: (
		uri: string,
		cid: string,
		value: Record<string, unknown>,
	) => Promise<PulledNote | null>,
): Promise<PushResult> {
	if (!existing) {
		return {
			status: "written",
			ref: refOf(await client.createRecord(collection, record)),
		};
	}
	try {
		return {
			status: "written",
			ref: refOf(
				await client.putRecord(collection, existing.rkey, record, existing.cid),
			),
		};
	} catch (err) {
		if (!(err instanceof XrpcError) || err.code !== "InvalidSwap") throw err;
		const current = await client.getRecordRaw(collection, existing.rkey);
		if (!current) {
			// Deleted remotely -> recreate at the same rkey (unguarded upsert).
			return {
				status: "written",
				ref: refOf(await client.putRecord(collection, existing.rkey, record)),
			};
		}
		const currentRef: RemoteRef = refOf(current);
		const remote = await decode(current.uri, current.cid, current.value);
		if (!remote) return { status: "written", ref: currentRef };
		return { status: "conflict", remote, current: currentRef };
	}
}
