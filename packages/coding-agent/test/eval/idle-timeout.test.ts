import { describe, expect, it } from "bun:test";
import { IdleTimeout } from "../../src/eval/idle-timeout";

/** Resolve true if `signal` aborts within `ms`, false if the window elapses first. */
function abortedWithin(signal: AbortSignal, ms: number): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(true);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), ms);
	signal.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			resolve(true);
		},
		{ once: true },
	);
	return promise;
}

describe("IdleTimeout", () => {
	it("aborts with a TimeoutError reason once the idle window elapses with no activity", async () => {
		using idle = new IdleTimeout(40);
		expect(idle.signal.aborted).toBe(false);

		const fired = await abortedWithin(idle.signal, 500);
		expect(fired).toBe(true);
		expect(idle.signal.aborted).toBe(true);
		// The reason must be a TimeoutError so downstream timeout detection
		// (kernel `isTimeoutReason`, executor `isTimedOutCancellation`) classifies
		// the cancellation as a timeout rather than a plain abort.
		expect(idle.signal.reason).toBeInstanceOf(DOMException);
		expect((idle.signal.reason as DOMException).name).toBe("TimeoutError");
	});

	it("ignores elapsed time while paused and resumes with a fresh window", async () => {
		const idleMs = 80;
		using idle = new IdleTimeout(idleMs);
		idle.pause();
		await Bun.sleep(idleMs * 2);
		// Safe under any scheduling delay: while paused the watchdog cannot fire,
		// so a slow event loop only strengthens this.
		expect(idle.signal.aborted).toBe(false);

		idle.resume();
		const resumedAt = Date.now();
		const fired = await abortedWithin(idle.signal, 5_000);
		expect(fired).toBe(true);

		// The fresh-window contract, asserted in the one direction a stalled event
		// loop cannot break. Measuring "it did NOT fire within a short slice after
		// resume" is the opposite: a >80ms stall there legitimately exhausts the
		// new window and the timer fires, so that phrasing failed under full-suite
		// load. Elapsed time can only grow when the loop is busy, so a lower bound
		// holds regardless — and it still distinguishes a fresh window from a
		// resumed stale one, which would abort ~immediately with the deadline
		// already 160ms in the past.
		expect(Date.now() - resumedAt).toBeGreaterThanOrEqual(idleMs - 10);
	});

	it("reference-counts overlapping pauses", async () => {
		using idle = new IdleTimeout(60);
		idle.pause();
		idle.pause();
		await Bun.sleep(120);
		expect(idle.signal.aborted).toBe(false);

		idle.resume();
		await Bun.sleep(90);
		expect(idle.signal.aborted).toBe(false);

		idle.resume();
		const fired = await abortedWithin(idle.signal, 500);
		expect(fired).toBe(true);
	});
	it("never fires after dispose()", async () => {
		const idle = new IdleTimeout(30);
		idle.dispose();
		const fired = await abortedWithin(idle.signal, 150);
		expect(fired).toBe(false);
		expect(idle.signal.aborted).toBe(false);
	});

	it("ignores pause/resume after the watchdog has already fired", async () => {
		using idle = new IdleTimeout(30);
		await abortedWithin(idle.signal, 500);
		expect(idle.signal.aborted).toBe(true);
		// Late activity must not un-abort or rearm a settled watchdog.
		idle.pause();
		idle.resume();
		expect(idle.signal.aborted).toBe(true);
	});
});
