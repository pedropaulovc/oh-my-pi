/**
 * Owner-routed async job delivery: formatting and batch-message assembly for
 * `async-result` follow-ups.
 *
 * Each {@link AgentSession} registers a delivery sink for its own agent id
 * (`AsyncJobManager.registerDeliverySink`) and enqueues formatted entries on
 * its yield queue; the queue's idle flush injects them as a follow-up turn.
 * This replaces the old single hardwired `onJobComplete` closure that routed
 * every completion — regardless of owner — into the first top-level session.
 */
import { formatDuration, prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "../async";
import asyncProgressTemplate from "../prompts/tools/async-progress.md" with { type: "text" };
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import type { CustomMessage } from "./messages";

/**
 * `customType` of the injected async-result follow-up message. The task
 * executor's run monitor matches on it to invalidate a previously recorded
 * yield: a result injected after the yield supersedes that yield's payload.
 */
export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";

/** Result payloads longer than this spill to an artifact with an inline preview. */
export const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
export const ASYNC_PREVIEW_MAX_CHARS = 4_000;

export interface AsyncResultEntry {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
	/**
	 * Owning session's async-delivery generation at enqueue time. A session
	 * transition (`/new`, switch, handoff) bumps the generation, so an entry
	 * whose generation no longer matches belongs to a replaced transcript and
	 * is dropped at flush — even after its job id has been reused, which clears
	 * the manager's per-id suppression marker.
	 */
	epoch: number;
}

type AsyncResultJobDetails = {
	jobId: string;
	type?: "bash" | "task";
	label?: string;
	durationMs?: number;
};

export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};

/**
 * `customType` of an ambient progress follow-up: a still-running job's update,
 * drained only at a step boundary of an active run (its yield kind sets
 * `skipIdleFlush`), so it never starts a turn on its own.
 */
export const ASYNC_PROGRESS_MESSAGE_TYPE = "async-progress";

/**
 * `customType` of a wake progress follow-up. Same payload as
 * {@link ASYNC_PROGRESS_MESSAGE_TYPE}, but its yield kind participates in the
 * idle flush, so it starts a follow-up turn when the session is between turns.
 * Opt-in per job (`progress.wake`), because it changes when the agent runs.
 */
export const ASYNC_PROGRESS_WAKE_MESSAGE_TYPE = "async-progress-wake";

/** Lines kept per job in one progress aside, before the settings ceiling applies. */
export const ASYNC_PROGRESS_DEFAULT_MAX_LINES = 3;
/** Characters kept across a whole progress aside, before the settings ceiling applies. */
export const ASYNC_PROGRESS_DEFAULT_MAX_CHARS = 4_000;

export interface AsyncProgressEntry {
	jobId: string;
	text: string;
	job: AsyncJob | undefined;
	/** Monotonic per-job counter; only the newest entry per job survives a batch. */
	seq: number;
	elapsedMs: number;
	/** See {@link AsyncResultEntry.epoch}. */
	epoch: number;
	/** Emit the "monitor still armed" reminder for this job. */
	remind: boolean;
}

type AsyncProgressJobDetails = {
	jobId: string;
	type?: "bash" | "task";
	label?: string;
	elapsedMs: number;
	text: string;
};

export type AsyncProgressDetails = {
	jobs: AsyncProgressJobDetails[];
	wake: boolean;
};

/** Keep the last `maxLines` lines of `text`, then hard-cap its length. */
function capProgressText(text: string, maxLines: number, maxChars: number): string {
	const lines = text.split("\n");
	const kept = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
	const joined = kept.join("\n").trimEnd();
	if (joined.length <= maxChars) return joined;
	return `${joined.slice(joined.length - maxChars)}`;
}

/**
 * Assemble one progress aside from queued entries. Coalescing is the whole
 * point: only the newest `seq` per job survives, so a burst of updates costs one
 * block, and the per-job line cap plus the whole-message character budget keep a
 * many-job batch from turning into an output dump.
 */
export function buildAsyncProgressBatchMessage(
	entries: AsyncProgressEntry[],
	options?: { wake?: boolean; maxLines?: number; maxChars?: number },
): CustomMessage<AsyncProgressDetails> | null {
	if (entries.length === 0) return null;
	const maxLines = Math.max(1, options?.maxLines ?? ASYNC_PROGRESS_DEFAULT_MAX_LINES);
	const maxChars = Math.max(1, options?.maxChars ?? ASYNC_PROGRESS_DEFAULT_MAX_CHARS);

	const newestByJob = new Map<string, AsyncProgressEntry>();
	for (const entry of entries) {
		const existing = newestByJob.get(entry.jobId);
		if (!existing || entry.seq >= existing.seq) newestByJob.set(entry.jobId, entry);
	}
	const survivors = Array.from(newestByJob.values());
	// Split the character budget across jobs so one chatty job cannot crowd out
	// the others' updates entirely.
	const perJobChars = Math.max(1, Math.floor(maxChars / survivors.length));

	const jobs = survivors.map(entry => ({
		jobId: entry.jobId,
		type: entry.job?.type,
		label: entry.job?.label,
		elapsedMs: entry.elapsedMs,
		text: capProgressText(entry.text, maxLines, perJobChars),
	}));
	const reminderIds = survivors.filter(entry => entry.remind).map(entry => entry.jobId);
	const details: AsyncProgressDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			elapsedMs: job.elapsedMs,
			text: job.text,
		})),
		wake: options?.wake === true,
	};
	return {
		role: "custom",
		customType: options?.wake ? ASYNC_PROGRESS_WAKE_MESSAGE_TYPE : ASYNC_PROGRESS_MESSAGE_TYPE,
		content: prompt.render(asyncProgressTemplate, {
			multiple: jobs.length > 1,
			jobs: jobs.map(job => ({ ...job, elapsed: formatDuration(job.elapsedMs) })),
			reminder: reminderIds.length > 0,
			reminderIds: reminderIds.map(id => JSON.stringify(id)).join(","),
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => ({
		jobId: entry.jobId,
		result: entry.result,
		type: entry.job?.type,
		label: entry.job?.label,
		durationMs: entry.durationMs,
	}));
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
		})),
	};
	return {
		role: "custom",
		customType: ASYNC_RESULT_MESSAGE_TYPE,
		content: prompt.render(asyncResultTemplate, {
			multiple: jobs.length > 1,
			jobs,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}
