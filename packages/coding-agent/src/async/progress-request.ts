/**
 * Shared validation and clamping for a background job's progress trigger spec.
 *
 * Both entry points — the `bash` `progress` param and `hub` `op:"monitor"` —
 * must apply the same rules, or a spec that `bash` rejects could be installed
 * through `hub` and silently degrade inside the sampler (which can only ignore
 * an unusable pattern, not report it). Keeping the rules here is what makes the
 * two surfaces provably agree.
 */
import type { AsyncJobProgressRequest } from "./job-manager";

/**
 * Ceiling on a `match` pattern's source length. The pattern is model-authored
 * and evaluated against every new output line of a running job, so it sits on
 * the output hot path; a short bound keeps a pathological pattern from turning
 * that path into a backtracking sink.
 */
export const MAX_PROGRESS_MATCH_LENGTH = 200;

/**
 * Nested quantifiers — `(a+)+`, `(a*)*`, `(?:a+)+?` and friends — are the shape
 * that turns a short pattern into a backtracking bomb. Length is no defence:
 * `/(a+)+$/` is six characters and takes ~500ms on a 29-character line. Since
 * the pattern runs against every output line of a running job, reject the shape
 * outright rather than hope the input stays short.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*]/;

/** Lines carried per update when the caller does not say. */
export const DEFAULT_PROGRESS_LINES = 3;

export interface ProgressRequestLimits {
	/** Floor on any emission window. */
	minIntervalMs: number;
	/**
	 * Floor on the `every` cadence when `wake` is set. A waking monitor starts a
	 * follow-up turn on an idle agent, so its cadence is far more expensive than
	 * an ambient one and gets its own, much higher floor.
	 */
	wakeMinIntervalMs: number;
	/** Ceiling on `lines`. */
	maxLines: number;
}

/** Settings paths this module reads. */
export type ProgressSettingPath =
	| "async.progress.minIntervalMs"
	| "async.progress.wakeMinIntervalMs"
	| "async.progress.maxLines";

/**
 * Read the configured safety rails through `read`. Taking a reader rather than
 * `Settings` keeps this module free of a config import, so it stays usable from
 * a plain test without initializing settings.
 */
export function progressLimitsFrom(read: (path: ProgressSettingPath) => number): ProgressRequestLimits {
	return {
		minIntervalMs: Math.max(0, read("async.progress.minIntervalMs")),
		wakeMinIntervalMs: Math.max(0, read("async.progress.wakeMinIntervalMs")),
		maxLines: Math.max(1, read("async.progress.maxLines")),
	};
}

export type ProgressRequestResolution =
	| { kind: "ok"; request: AsyncJobProgressRequest; notices: string[] }
	| { kind: "invalid"; reason: string };

export interface ProgressRequestInput {
	every?: number;
	match?: string;
	wake?: boolean;
	stopOnMatch?: boolean;
	lines?: number;
}

/**
 * Validate a trigger spec and clamp it to `limits`. Clamps are reported as
 * notices rather than applied silently — from the model's side an ignored
 * cadence is indistinguishable from a monitor that never fired.
 */
export function resolveProgressRequest(
	input: ProgressRequestInput,
	limits: ProgressRequestLimits,
): ProgressRequestResolution {
	const rawMatch = input.match?.trim() ?? "";
	const hasEvery = input.every !== undefined && input.every > 0;
	if (!hasEvery && rawMatch.length === 0) {
		return { kind: "invalid", reason: "progress requires `every` (seconds) or `match` (regex); neither was set." };
	}

	if (rawMatch.length > MAX_PROGRESS_MATCH_LENGTH) {
		return {
			kind: "invalid",
			reason: `progress.match is ${rawMatch.length} characters; the maximum is ${MAX_PROGRESS_MATCH_LENGTH}.`,
		};
	}

	if (NESTED_QUANTIFIER.test(rawMatch)) {
		return {
			kind: "invalid",
			reason:
				"progress.match contains a nested quantifier (e.g. `(a+)+`), which can backtrack catastrophically on a long output line. Rewrite it without the nesting.",
		};
	}

	let match: string | undefined;
	if (rawMatch.length > 0) {
		try {
			// Compiled only to validate; the sampler compiles the live spec.
			new RegExp(input.match as string);
			match = input.match;
		} catch (error) {
			return {
				kind: "invalid",
				reason: `progress.match is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	const notices: string[] = [];
	const wake = input.wake === true;

	// `match` deliberately does not take the wake floor for its FIRST fire: a
	// match is a high-signal event and delaying it would defeat the
	// abort-on-first-failure case the channel exists for. The floor still bounds
	// how often a waking match may repeat (see wakeRepeatFloorMs below) — a
	// broad pattern matching most lines would otherwise start a model turn every
	// ambient interval, which is the same turn spam the cadence floor prevents.
	const floorMs = wake ? Math.max(limits.minIntervalMs, limits.wakeMinIntervalMs) : limits.minIntervalMs;
	const floorSec = Math.max(0, floorMs) / 1000;
	const requestedEvery = hasEvery ? (input.every as number) : undefined;
	const every = requestedEvery === undefined ? undefined : Math.max(floorSec, requestedEvery);
	if (requestedEvery !== undefined && every !== requestedEvery) {
		const because = wake ? " for a waking monitor" : "";
		notices.push(
			`progress.every raised to ${every?.toLocaleString()}s (minimum ${floorSec.toLocaleString()}s${because}).`,
		);
	}

	const maxLines = Math.max(1, limits.maxLines);
	const requestedLines = Math.max(1, Math.floor(input.lines ?? DEFAULT_PROGRESS_LINES));
	const lines = Math.min(maxLines, requestedLines);
	if (lines !== requestedLines) {
		notices.push(`progress.lines lowered to ${lines} (maximum ${maxLines}).`);
	}

	if (wake && match !== undefined && input.stopOnMatch !== true) {
		notices.push(
			`A waking match fires promptly the first time, then at most once every ${(limits.wakeMinIntervalMs / 1000).toLocaleString()}s. Set stopOnMatch to end the job on the first hit instead.`,
		);
	}

	return {
		kind: "ok",
		request: {
			every,
			match,
			wake,
			stopOnMatch: input.stopOnMatch === true,
			lines,
			// Repeat floor for a waking match; the first fire is never delayed.
			...(wake && match !== undefined ? { wakeRepeatFloorMs: limits.wakeMinIntervalMs } : {}),
		},
		notices,
	};
}
