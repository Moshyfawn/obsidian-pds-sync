import type { AtpClient } from "../../atproto/client";
import type {
	NoteInput,
	PulledNote,
	PushResult,
	RemoteRef,
	SyncTarget,
} from "../target";

/**
 * Placeholder for the native permissioned-data backend.
 *
 * When atproto ships either the single-user private namespace (Private Data WG)
 * or `ats://` permission spaces (dholms' "spaces"), a personal vault is the
 * simplest possible case: a single space owned by your own DID, member list of
 * one. Can swap the backend once either are shipped - the
 * engine already routes through SyncTarget. Intentionally not wired up; nothing
 * resolves `ats://` today.
 */
export class AtsSpaceTarget implements SyncTarget {
	readonly id = "ats-space" as const;
	readonly label = "atproto space (ats://) - not yet available";
	readonly collection = "ats.placeholder.note";

	isReady(): boolean {
		return false;
	}

	readyError(): string {
		return "Native atproto private spaces (ats://) are not shipped yet; use the E2EE backend for now.";
	}

	async push(
		_client: AtpClient,
		_note: NoteInput,
		_existing?: RemoteRef,
	): Promise<PushResult> {
		throw new Error(this.readyError());
	}

	async delete(_client: AtpClient, _ref: RemoteRef): Promise<void> {
		throw new Error(this.readyError());
	}

	async list(_client: AtpClient): Promise<PulledNote[]> {
		return [];
	}
}
