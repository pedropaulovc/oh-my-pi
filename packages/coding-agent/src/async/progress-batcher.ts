interface ProgressBatchState<T> {
	lastEmitAt: number;
	pending: T[];
	seq: number;
	deliveryTail?: Promise<void>;
	timer?: NodeJS.Timeout;
}

/** Lossless, ordered, per-source progress batching with a fixed maximum delivery cadence. */
export class ProgressBatcher<T> {
	readonly #states = new Map<string, ProgressBatchState<T>>();
	readonly #intervalMs: number;
	readonly #deliver: (id: string, values: readonly T[], seq: number) => void | Promise<void>;

	constructor(intervalMs: number, deliver: (id: string, values: readonly T[], seq: number) => void | Promise<void>) {
		this.#intervalMs = intervalMs;
		this.#deliver = deliver;
	}

	push(id: string, value: T): void {
		let state = this.#states.get(id);
		if (!state) {
			state = { lastEmitAt: 0, pending: [], seq: 0 };
			this.#states.set(id, state);
		}
		state.pending.push(value);
		const waitMs = state.lastEmitAt + this.#intervalMs - Date.now();
		if (waitMs <= 0) {
			void this.flush(id);
			return;
		}
		if (state.timer) return;
		state.timer = setTimeout(() => void this.flush(id), waitMs);
		state.timer.unref();
	}

	flush(id: string): Promise<void> {
		const state = this.#states.get(id);
		if (!state) return Promise.resolve();
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = undefined;
		}
		if (state.pending.length === 0) return state.deliveryTail ?? Promise.resolve();
		const values = state.pending;
		state.pending = [];
		state.lastEmitAt = Date.now();
		state.seq += 1;
		const seq = state.seq;
		const deliver = () => this.#deliver(id, values, seq);
		let tail: Promise<void>;
		if (state.deliveryTail) {
			tail = state.deliveryTail.then(deliver, deliver);
		} else {
			try {
				tail = Promise.resolve(deliver());
			} catch (error) {
				tail = Promise.reject(error);
			}
		}
		state.deliveryTail = tail;
		void tail.then(
			() => {
				if (state.deliveryTail === tail) state.deliveryTail = undefined;
			},
			() => {
				if (state.deliveryTail === tail) state.deliveryTail = undefined;
			},
		);
		return tail;
	}

	async finish(id: string): Promise<void> {
		try {
			await this.flush(id);
		} finally {
			this.clear(id);
		}
	}

	clear(id: string): void {
		const state = this.#states.get(id);
		if (!state) return;
		if (state.timer) clearTimeout(state.timer);
		this.#states.delete(id);
	}

	dispose(): void {
		for (const state of this.#states.values()) {
			if (state.timer) clearTimeout(state.timer);
		}
		this.#states.clear();
	}
}
