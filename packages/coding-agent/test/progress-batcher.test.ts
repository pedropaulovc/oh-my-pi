import { afterEach, describe, expect, test, vi } from "bun:test";
import { ProgressBatcher } from "../src/async/progress-batcher";

describe("ProgressBatcher", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("delivers a queued batch after the preceding delivery rejects", async () => {
		vi.useFakeTimers();
		const firstDelivery = Promise.withResolvers<void>();
		const seen: string[] = [];
		const batcher = new ProgressBatcher(1_000, (_id, text) => {
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
});
