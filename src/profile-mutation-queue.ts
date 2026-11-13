/** Keeps each profile's mutations, persistence and rollback in call order. */
export class ProfileMutationQueue {
	private readonly pending = new Map<string, Promise<void>>();

	async run(profileId: string, operation: () => Promise<void>): Promise<void> {
		const previous = this.pending.get(profileId);
		let release!: () => void;
		const current = new Promise<void>(resolve => { release = resolve; });
		this.pending.set(profileId, current);
		try {
			if (previous) await previous;
			await operation();
		} finally {
			release();
			if (this.pending.get(profileId) === current) this.pending.delete(profileId);
		}
	}
}
