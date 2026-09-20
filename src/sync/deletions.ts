import type { SyncIndex } from "./frontmatter";

/**
 * A missing file is not proof of a deletion: cloud placeholders, other sync
 * tools and partial vault copies look the same. Deletions wait here until a
 * later sync finds the file still gone and unclaimed by any other note.
 */

export interface PendingDeletion {
	path: string;
	index: SyncIndex;
}

export interface DeletionQueueHost {
	exists(path: string): boolean;
	/** True if any note still carries this rkey in its index. */
	claimed(rkey: string): boolean;
	remove(index: SyncIndex): Promise<void>;
	save(pending: PendingDeletion[]): Promise<void>;
}

export interface FlushOutcome {
	deleted: number;
	cancelled: number;
	errors: string[];
}

export class DeletionQueue {
	constructor(
		private readonly host: DeletionQueueHost,
		private pending: PendingDeletion[] = [],
	) {}

	get size(): number {
		return this.pending.length;
	}

	async enqueue(path: string, index: SyncIndex | null): Promise<void> {
		if (!index) return;
		if (this.pending.some((p) => p.index.ref.rkey === index.ref.rkey)) return;
		this.pending.push({ path, index });
		await this.host.save(this.pending);
	}

	async flush(): Promise<FlushOutcome> {
		const outcome: FlushOutcome = { deleted: 0, cancelled: 0, errors: [] };
		if (this.pending.length === 0) return outcome;

		const keep: PendingDeletion[] = [];
		for (const p of this.pending) {
			if (this.host.exists(p.path) || this.host.claimed(p.index.ref.rkey)) {
				outcome.cancelled++;
				continue;
			}
			try {
				await this.host.remove(p.index);
				outcome.deleted++;
			} catch (err) {
				outcome.errors.push(
					`${p.path}: ${err instanceof Error ? err.message : String(err)}`,
				);
				keep.push(p);
			}
		}
		this.pending = keep;
		await this.host.save(this.pending);
		return outcome;
	}
}
