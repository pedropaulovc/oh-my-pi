import { afterEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { ProgressBatcher } from "../src/async/progress-batcher";

describe("ProgressBatcher", () => {
	afterEach(() => {
		vi.useRealTimers();
		setSystemTime();
	});

	test("delivers a queued batch after the preceding delivery rejects", async () => {
		vi.useFakeTimers();
		const firstDelivery = Promise.withResolvers<void>();
		const seen: string[] = [];
		const batcher = new ProgressBatcher<string>(1_000, (_id, values) => {
			const text = values.join("\n");
			seen.push(text);
			if (text === "first") return firstDelivery.promise;
		});

		batcher.push("source", "first");
		batcher.push("source", "second");
		vi.advanceTimersByTime(1_000);
		firstDelivery.reject(new Error("transient sink failure"));
		await batcher.flush("source");

		expect(seen).toEqual(["first", "second"]);
	});

	test("starts a fresh sequence after terminal delivery rejects", async () => {
		vi.useFakeTimers();
		setSystemTime(100);
		const sequences: number[] = [];
		let rejectDelivery = true;
		const batcher = new ProgressBatcher<string>(1_000, (_id, _values, seq) => {
			sequences.push(seq);
			if (!rejectDelivery) return;
			rejectDelivery = false;
			throw new Error("terminal sink failure");
		});

		batcher.push("source", "first generation");
		await expect(batcher.finish("source")).rejects.toThrow("terminal sink failure");
		batcher.push("source", "second generation");
		await batcher.flush("source");

		expect(sequences).toEqual([1, 1]);
	});
});
