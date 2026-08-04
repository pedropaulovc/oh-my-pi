import { logger } from "@oh-my-pi/pi-utils";

const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RUNNING_JOBS = 15;

/**
 * Adaptive ("smart") `hub` poll-wait ladder (ms). A tight poll loop climbs
 * these rungs so each immediate re-poll backs off and stops spending turns on
 * "still running" frames; the floor (first rung) is the shortest wait and the
 * top rung is the longest a smart poll will ever block. Only used when
 * `async.pollWaitDuration` is set to `smart`; fixed durations wait verbatim.
 */
const POLL_WAIT_LADDER_MS = [5_000, 10_000, 30_000, 60_000, 300_000] as const;
/**
 * Going at least this long between poll calls means the agent stepped out of
 * the poll loop to do real work — the next poll drops back to the ladder floor.
 */
const POLL_ESCALATION_RESET_MS = 60_000;

interface PollEscalationState {
	/** Index into POLL_WAIT_LADDER_MS used for the most recent poll wait. */
	level: number;
	/** Timestamp (ms) when the most recent poll wait returned. */
	lastPollEndAt: number;
}

/** Default floor between agent-facing progress emissions for one job. */
const DEFAULT_PROGRESS_MIN_INTERVAL_MS = 1_000;

/** Per-job bookkeeping for the coalesced agent-facing progress channel. */
interface ProgressEmitState {
	/** Timestamp (ms) of the last emission; 0 before the first. */
	lastEmitAt: number;
	/** Newest text awaiting emission, or undefined when nothing is pending. */
	pendingText?: string;
	/** Trailing-edge timer, armed only while `pendingText` is set. */
	timer?: NodeJS.Timeout;
	/** Monotonic counter so the consumer can keep the newest entry per job. */
	seq: number;
	/** Emissions delivered so far, for wake-monitor reminders. */
	emitted: number;
}

/**
 * Opt-in policy for the agent-facing progress channel. Absent means the channel
 * is off for that job: the job still reports progress to the TUI through
 * {@link AsyncJobRegisterOptions.onProgress}, but nothing reaches the model
 * until the job settles. Mutable at runtime via
 * {@link AsyncJobManager.setProgressPolicy} so a caller can arm, retune, or
 * stop a monitor without disturbing the work itself.
 */
/**
 * The caller's raw trigger spec, carried on the job so a retune reaches the
 * producer. The manager stores and returns it without interpreting it: what
 * counts as "progress" is the producer's business (bash samples output lines;
 * another job type might report differently), while the manager owns only the
 * rate and delivery decisions in {@link AsyncJobProgressPolicy}.
 */
export interface AsyncJobProgressRequest {
	/**
	 * Minimum seconds between periodic updates. This throttles output-driven
	 * sampling; it is not a wall-clock heartbeat. A job that produces no output
	 * produces no samples, so a silent job emits nothing however small this is.
	 */
	every?: number;
	/** Regex source matched against new output lines. */
	match?: string;
	wake?: boolean;
	stopOnMatch?: boolean;
	lines?: number;
	/**
	 * Minimum ms between repeat emissions for a waking `match`. The first fire is
	 * never delayed; this only stops a broad pattern from starting a model turn
	 * on every matching line.
	 */
	wakeRepeatFloorMs?: number;
}

export interface AsyncJobProgressPolicy {
	/**
	 * Deliver even when the owning session is idle, as a follow-up turn. When
	 * false (the default) progress rides the next step boundary of an active run
	 * as a non-interrupting aside and is skipped entirely while the session is
	 * idle — see {@link AsyncJobProgressSink.isActive}.
	 */
	wake?: boolean;
	/** Minimum ms between emissions for this job; clamped to the manager floor. */
	intervalMs?: number;
}

export interface AsyncJob {
	id: string;
	type: "bash" | "task";
	status: "running" | "completed" | "failed" | "cancelled";
	startTime: number;
	label: string;
	abortController: AbortController;
	promise: Promise<void>;
	resultText?: string;
	errorText?: string;
	/** Latest tool-render details reported by the running job. */
	latestDetails?: Record<string, unknown>;
	/**
	 * Agent-facing progress policy; undefined means the channel is off. See
	 * {@link AsyncJobProgressPolicy}.
	 */
	progressPolicy?: AsyncJobProgressPolicy;
	/** Producer-interpreted trigger spec; see {@link AsyncJobProgressRequest}. */
	progressRequest?: AsyncJobProgressRequest;
	/**
	 * Registry id of the agent that registered the job (e.g. "Main",
	 * "AuthLoader"). Used by scoped cancel/list APIs so a subagent's teardown
	 * does not cancel its parent's jobs. Undefined for callers that don't
	 * supply an id (e.g. legacy tests, SDK consumers without an agent context).
	 */
	ownerId?: string;
	/**
	 * Registry id of the subagent this job runs (task/tan/vibe jobs). Lets
	 * job-view code link a job row to its AgentRegistry ref even when the job
	 * id differs from the agent id (vibe turn jobs, tan clones).
	 */
	agentId?: string;
	/**
	 * Job is registered but parked behind a caller-managed gate (e.g. a task
	 * batch semaphore). Queued jobs do not count toward the running-job limit
	 * until the caller invokes `markRunning()` from the run context.
	 */
	queued?: boolean;
}

/** Delivery callback for a settled job's result text. */
export type AsyncJobDeliverySink = (jobId: string, text: string, job?: AsyncJob) => void | Promise<void>;

/**
 * Owner-routed sink for the agent-facing progress channel. Best-effort and
 * fire-and-forget: unlike {@link AsyncJobDeliverySink} there is no retry queue
 * and no dead-lettering — a throw is logged and the update is dropped, because
 * a stale progress line is worth less than the complexity of redelivering it.
 */
export interface AsyncJobProgressSink {
	/** Deliver one coalesced progress update for a still-running job. */
	deliver(jobId: string, text: string, job: AsyncJob): void | Promise<void>;
	/**
	 * True when the owning session is mid-run. Ambient (non-`wake`) updates are
	 * only emitted while this holds: they are drained at a step boundary, so
	 * emitting to an idle session would queue entries nothing will pick up,
	 * growing without bound. `wake` updates ignore this — starting a turn is the
	 * point.
	 */
	isActive(): boolean;
}

export interface AsyncJobManagerOptions {
	/**
	 * Delivery sink for UNOWNED completions (jobs registered without an
	 * `ownerId`). Owned deliveries route exclusively through
	 * {@link AsyncJobManager.registerDeliverySink}; when the owner has no live
	 * sink they are dead-lettered (dropped with a warning; the job row keeps
	 * the result text until retention eviction) — never routed here, which
	 * would leak one agent's result into another session.
	 */
	onJobComplete?: AsyncJobDeliverySink;
	maxRunningJobs?: number;
	retentionMs?: number;
	/**
	 * Floor (ms) on the agent-facing progress emit interval, from
	 * `async.progress.minIntervalMs`. A safety rail against sub-second spam, not
	 * a policy: callers pick their own cadence above it.
	 */
	progressMinIntervalMs?: number;
	/**
	 * Cap on agent-facing progress updates per job. Every update is a persisted
	 * message, so an unbounded monitor grows the transcript for the rest of the
	 * session. 0 disables the cap.
	 */
	progressMaxUpdates?: number;
}

interface AsyncJobDelivery {
	jobId: string;
	text: string;
	attempt: number;
	nextAttemptAt: number;
	lastError?: string;
	ownerId?: string;
	promise?: Promise<void>;
}

export interface AsyncJobDeliveryState {
	queued: number;
	delivering: boolean;
	nextRetryAt?: number;
	pendingJobIds: string[];
}

export interface AsyncJobRegisterOptions {
	id?: string;
	/** Registry id of the agent that owns this job; used to scope cancelAll. */
	ownerId?: string;
	/** Registry id of the subagent this job runs; see {@link AsyncJob.agentId}. */
	agentId?: string;
	onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void>;
	/** Register the job in queued state; see {@link AsyncJob.queued}. */
	queued?: boolean;
	/**
	 * Arm the agent-facing progress channel at registration. Omit to leave it
	 * off; it can be armed later with {@link AsyncJobManager.setProgressPolicy}.
	 */
	progressPolicy?: AsyncJobProgressPolicy;
	/** Producer-interpreted trigger spec; see {@link AsyncJobProgressRequest}. */
	progressRequest?: AsyncJobProgressRequest;
}

/**
 * Filter applied to job query/cancel APIs. With `ownerId`, results are
 * restricted to jobs registered by that agent (registry id from
 * `AgentRegistry`, e.g. "Main", "AuthLoader").
 */
export interface AsyncJobFilter {
	ownerId?: string;
}

export class AsyncJobManager {
	static #instance: AsyncJobManager | undefined;

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	static instance(): AsyncJobManager | undefined {
		return AsyncJobManager.#instance;
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: AsyncJobManager | undefined): void {
		AsyncJobManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		AsyncJobManager.#instance = undefined;
	}

	readonly #jobs = new Map<string, AsyncJob>();
	readonly #deliveries: AsyncJobDelivery[] = [];
	readonly #inFlightDeliveries: AsyncJobDelivery[] = [];
	readonly #suppressedDeliveries = new Set<string>();
	readonly #watchedJobs = new Set<string>();
	readonly #evictionTimers = new Map<string, NodeJS.Timeout>();
	readonly #pollEscalation = new Map<string | undefined, PollEscalationState>();
	readonly #deliverySinks = new Map<string, AsyncJobDeliverySink>();
	readonly #progressSinks = new Map<string, AsyncJobProgressSink>();
	readonly #progressState = new Map<string, ProgressEmitState>();
	readonly #onJobComplete: AsyncJobManagerOptions["onJobComplete"];
	readonly #maxRunningJobs: number;
	readonly #retentionMs: number;
	readonly #progressMinIntervalMs: number;
	readonly #progressMaxUpdates: number;
	#deliveryLoop: Promise<void> | undefined;
	#disposed = false;

	#filterJobs(jobs: Iterable<AsyncJob>, filter?: AsyncJobFilter): AsyncJob[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return Array.from(jobs);
		const out: AsyncJob[] = [];
		for (const job of jobs) {
			if (job.ownerId === ownerId) out.push(job);
		}
		return out;
	}

	constructor(options: AsyncJobManagerOptions) {
		this.#onJobComplete = options.onJobComplete;
		this.#maxRunningJobs = Math.max(1, Math.floor(options.maxRunningJobs ?? DEFAULT_MAX_RUNNING_JOBS));
		this.#retentionMs = Math.max(0, Math.floor(options.retentionMs ?? DEFAULT_RETENTION_MS));
		this.#progressMinIntervalMs = Math.max(
			0,
			Math.floor(options.progressMinIntervalMs ?? DEFAULT_PROGRESS_MIN_INTERVAL_MS),
		);
		this.#progressMaxUpdates = Math.max(0, Math.floor(options.progressMaxUpdates ?? 0));
	}

	/** True when the running-job count has reached the configured cap. */
	get atCapacity(): boolean {
		if (this.#disposed) return true;
		// Mirror register(): queued jobs hold no execution slot.
		let activeCount = 0;
		for (const job of this.#jobs.values()) {
			if (job.status === "running" && !job.queued) activeCount++;
		}
		return activeCount >= this.#maxRunningJobs;
	}

	register(
		type: "bash" | "task",
		label: string,
		run: (ctx: {
			jobId: string;
			signal: AbortSignal;
			reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
			/**
			 * Surface one progress update to the *model*, subject to the job's
			 * {@link AsyncJobProgressPolicy}. Distinct from `reportProgress`,
			 * which is the unconditional TUI stream: callers pass intent here
			 * (a matched line, a sampled tail), never their raw output buffer.
			 * A no-op when the channel is not armed.
			 */
			reportAgentProgress: (text: string) => void;
			/** Clear the queued flag once the job actually starts executing. */
			markRunning: () => void;
		}) => Promise<string>,
		options?: AsyncJobRegisterOptions,
	): string {
		if (this.#disposed) {
			throw new Error("Async job manager is disposed");
		}
		// Queued jobs hold no execution slot yet — only count jobs that are
		// actually running so a large parked batch cannot starve registration.
		let activeCount = 0;
		for (const existing of this.#jobs.values()) {
			if (existing.status === "running" && !existing.queued) activeCount++;
		}
		if (activeCount >= this.#maxRunningJobs) {
			throw new Error(
				`Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`,
			);
		}

		const id = this.#resolveJobId(options?.id);
		this.#suppressedDeliveries.delete(id);
		const abortController = new AbortController();
		const startTime = Date.now();

		const job: AsyncJob = {
			id,
			type,
			status: "running",
			startTime,
			label,
			abortController,
			promise: Promise.resolve(),
			ownerId: options?.ownerId,
			agentId: options?.agentId,
			queued: options?.queued === true,
			progressPolicy: options?.progressPolicy,
			progressRequest: options?.progressRequest,
		};

		const reportProgress = async (text: string, details?: Record<string, unknown>): Promise<void> => {
			if (details) job.latestDetails = details;
			if (!options?.onProgress) return;
			try {
				await options.onProgress(text, details);
			} catch (error) {
				logger.warn("Async job progress callback failed", {
					jobId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		job.promise = (async () => {
			try {
				const text = await run({
					jobId: id,
					signal: abortController.signal,
					reportProgress,
					reportAgentProgress: (text: string) => this.#recordAgentProgress(job, text),
					markRunning: () => {
						job.queued = false;
					},
				});
				if (job.status === "cancelled") {
					job.resultText = text;
					this.#scheduleEviction(id);
					return;
				}
				job.status = "completed";
				job.resultText = text;
				this.#enqueueDelivery(id, text);
				this.#scheduleEviction(id);
			} catch (error) {
				if (job.status === "cancelled") {
					job.errorText = error instanceof Error ? error.message : String(error);
					this.#scheduleEviction(id);
					return;
				}
				const errorText = error instanceof Error ? error.message : String(error);
				job.status = "failed";
				job.errorText = errorText;
				this.#enqueueDelivery(id, errorText);
				this.#scheduleEviction(id);
			}
		})();

		this.#jobs.set(id, job);
		return id;
	}

	/**
	 * Cancel a single job by id. When `filter.ownerId` is set and does not
	 * match the job's owner, the call is treated as not-found (returns false)
	 * so cross-agent cancellation is rejected at the manager level.
	 */
	cancel(id: string, filter?: AsyncJobFilter): boolean {
		const job = this.#jobs.get(id);
		if (!job) return false;
		if (filter?.ownerId && job.ownerId !== filter.ownerId) return false;
		if (job.status !== "running") return false;
		job.status = "cancelled";
		job.abortController.abort();
		this.#scheduleEviction(id);
		return true;
	}

	getJob(id: string): AsyncJob | undefined {
		return this.#jobs.get(id);
	}

	/**
	 * Arm, retune, or stop the agent-facing progress channel for a running job.
	 * Pass `undefined` to stop updates while leaving the job running. Scoped by
	 * `filter.ownerId` exactly like {@link cancel}: a mismatch reads as
	 * not-found so one agent cannot retune another's monitor. Returns false when
	 * the job is unknown, not visible to the caller, or already settled.
	 */
	setProgressPolicy(id: string, policy: AsyncJobProgressPolicy | undefined, filter?: AsyncJobFilter): boolean {
		const job = this.#jobs.get(id);
		if (!job) return false;
		if (filter?.ownerId && job.ownerId !== filter.ownerId) return false;
		if (job.status !== "running") return false;
		job.progressPolicy = policy;
		// Drop anything the old policy had buffered: after a retune the pending
		// text was sampled under different rules, and after a stop it must not
		// leak out on the trailing edge.
		if (!policy) this.#clearProgressState(id);
		return true;
	}

	/** Current progress policy for a job, or undefined when the channel is off. */
	getProgressPolicy(id: string, filter?: AsyncJobFilter): AsyncJobProgressPolicy | undefined {
		const job = this.#jobs.get(id);
		if (!job) return undefined;
		if (filter?.ownerId && job.ownerId !== filter.ownerId) return undefined;
		return job.progressPolicy;
	}

	/**
	 * Route agent-facing progress for jobs owned by `ownerId` to `sink`.
	 * Mirrors {@link registerDeliverySink}, including last-registration-wins and
	 * the guard that keeps a revived session's registration alive through its
	 * predecessor's late cleanup.
	 */
	registerProgressSink(ownerId: string, sink: AsyncJobProgressSink): () => void {
		this.#progressSinks.set(ownerId, sink);
		return () => {
			if (this.#progressSinks.get(ownerId) === sink) this.#progressSinks.delete(ownerId);
		};
	}

	/**
	 * Ingest one agent-facing progress report and emit it if the job's policy,
	 * the suppression state, and the rate floor all allow. Newest-wins: a report
	 * arriving inside the window replaces the pending text rather than queueing,
	 * and a trailing-edge timer flushes it so the last update before a quiet
	 * stretch is not lost.
	 */
	#recordAgentProgress(job: AsyncJob, text: string): void {
		if (this.#disposed) return;
		if (!job.progressPolicy) return;
		if (job.status !== "running") return;
		// A `hub` wait watching this job already returns snapshots, and an
		// acknowledged job's result was consumed by a poll — neither should also
		// produce asides.
		if (this.isDeliverySuppressed(job.id)) return;

		let state = this.#progressState.get(job.id);
		// Stop emitting once the per-job cap is reached. The job keeps running and
		// its completion is delivered as usual; only the running commentary stops,
		// so a long monitor cannot grow the transcript without bound.
		if (this.#progressMaxUpdates > 0 && (state?.emitted ?? 0) >= this.#progressMaxUpdates) return;
		if (!state) {
			state = { lastEmitAt: 0, seq: 0, emitted: 0 };
			this.#progressState.set(job.id, state);
		}
		state.pendingText = text;

		// A waking match is prompt on its first fire, then rate-limited, so a
		// pattern matching most lines cannot start a turn per line.
		const repeatFloorMs = (state.emitted > 0 ? job.progressRequest?.wakeRepeatFloorMs : undefined) ?? 0;
		const intervalMs = Math.max(this.#progressMinIntervalMs, job.progressPolicy.intervalMs ?? 0, repeatFloorMs);
		const waitMs = state.lastEmitAt + intervalMs - Date.now();
		if (waitMs <= 0) {
			this.#flushAgentProgress(job.id);
			return;
		}
		if (state.timer) return;
		const timer = setTimeout(() => this.#flushAgentProgress(job.id), waitMs);
		timer.unref();
		state.timer = timer;
	}

	/** Emit the pending progress text for one job, if it is still deliverable. */
	#flushAgentProgress(jobId: string): void {
		const state = this.#progressState.get(jobId);
		if (!state) return;
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = undefined;
		}
		const text = state.pendingText;
		if (text === undefined) return;

		const job = this.#jobs.get(jobId);
		// Re-check every gate: the window means arbitrary time passed since the
		// report was recorded, so the job may have settled, been watched, or had
		// its monitor stopped in between.
		if (job?.status !== "running" || !job.progressPolicy || this.isDeliverySuppressed(jobId)) {
			this.#clearProgressState(jobId);
			return;
		}
		const sink = job.ownerId === undefined ? undefined : this.#progressSinks.get(job.ownerId);
		if (!sink) return;
		// Ambient updates are drained at a step boundary; emitting to an idle
		// session would queue entries nothing picks up. Hold the pending text so
		// the next report re-arms the window rather than dropping the signal.
		if (!job.progressPolicy.wake && !sink.isActive()) return;

		state.pendingText = undefined;
		state.lastEmitAt = Date.now();
		state.seq += 1;
		state.emitted += 1;
		try {
			const result = sink.deliver(jobId, text, job);
			if (result) {
				result.catch(error => {
					logger.warn("Async job progress delivery failed", {
						jobId,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		} catch (error) {
			logger.warn("Async job progress delivery failed", {
				jobId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Number of agent-facing progress updates emitted so far for a job. */
	progressEmitCount(jobId: string): number {
		return this.#progressState.get(jobId)?.emitted ?? 0;
	}

	/** Monotonic sequence of the newest emitted progress update for a job. */
	progressSeq(jobId: string): number {
		return this.#progressState.get(jobId)?.seq ?? 0;
	}

	#clearProgressState(jobId: string): void {
		const state = this.#progressState.get(jobId);
		if (!state) return;
		if (state.timer) clearTimeout(state.timer);
		this.#progressState.delete(jobId);
	}

	#clearAllProgressState(): void {
		for (const state of this.#progressState.values()) {
			if (state.timer) clearTimeout(state.timer);
		}
		this.#progressState.clear();
	}

	getRunningJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter).filter(job => job.status === "running");
	}

	getRecentJobs(limit = 10, filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter)
			.filter(job => job.status !== "running")
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, limit);
	}

	getAllJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter);
	}

	getDeliveryState(filter?: AsyncJobFilter): AsyncJobDeliveryState {
		const deliveries = this.#filterDeliveries(filter);
		const inFlightDeliveries = this.#filterInFlightDeliveries(filter);
		const nextRetryAt = deliveries.reduce<number | undefined>((next, delivery) => {
			if (next === undefined) return delivery.nextAttemptAt;
			return Math.min(next, delivery.nextAttemptAt);
		}, undefined);

		return {
			queued: deliveries.length + inFlightDeliveries.length,
			delivering: inFlightDeliveries.length > 0 || (this.#deliveryLoop !== undefined && deliveries.length > 0),
			nextRetryAt,
			pendingJobIds: deliveries.concat(inFlightDeliveries).map(delivery => delivery.jobId),
		};
	}

	hasPendingDeliveries(filter?: AsyncJobFilter): boolean {
		return this.getDeliveryState(filter).queued > 0;
	}

	watchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		for (const jobId of uniqueJobIds) {
			this.#watchedJobs.add(jobId);
		}
		return uniqueJobIds.length;
	}

	unwatchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		let removed = 0;
		for (const jobId of uniqueJobIds) {
			if (this.#watchedJobs.delete(jobId)) {
				removed += 1;
			}
		}
		return removed;
	}

	/**
	 * Compute the next adaptive ("smart") wait (ms) for a blocking `hub` wait by
	 * the given owner. Consecutive polls — those starting within
	 * POLL_ESCALATION_RESET_MS of the previous poll returning — climb
	 * POLL_WAIT_LADDER_MS so a tight wait loop backs off; a longer gap means the
	 * agent left to do real work, so the wait resets to the floor. Pair each call
	 * with `recordPollWaitEnd()` once the wait returns.
	 */
	nextPollWaitMs(ownerId: string | undefined, now: number = Date.now()): number {
		const prev = this.#pollEscalation.get(ownerId);
		const reset = !prev || now - prev.lastPollEndAt >= POLL_ESCALATION_RESET_MS;
		const level = reset ? 0 : Math.min(prev.level + 1, POLL_WAIT_LADDER_MS.length - 1);
		this.#pollEscalation.set(ownerId, { level, lastPollEndAt: prev?.lastPollEndAt ?? now });
		return POLL_WAIT_LADDER_MS[level];
	}

	/**
	 * Mark a blocking poll wait as finished so the idle-reset window is measured
	 * from now. Polling again before POLL_ESCALATION_RESET_MS elapses keeps
	 * climbing the ladder; waiting longer resets it to the floor.
	 */
	recordPollWaitEnd(ownerId: string | undefined, now: number = Date.now()): void {
		const prev = this.#pollEscalation.get(ownerId);
		this.#pollEscalation.set(ownerId, { level: prev?.level ?? 0, lastPollEndAt: now });
	}

	acknowledgeDeliveries(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		if (uniqueJobIds.length === 0) return 0;

		for (const jobId of uniqueJobIds) {
			this.#suppressedDeliveries.add(jobId);
		}

		const before = this.#deliveries.length;
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId)),
		);
		return before - this.#deliveries.length;
	}

	/**
	 * Lift a foreground-wait suppression set via `acknowledgeDeliveries`. If the
	 * job already finished while suppressed (its delivery enqueue was skipped),
	 * re-enqueue the completion so the result is still delivered exactly once.
	 */
	resumeDeliveries(jobIds: string[]): void {
		for (const rawId of jobIds) {
			const jobId = rawId.trim();
			if (!jobId) continue;
			if (!this.#suppressedDeliveries.delete(jobId)) continue;
			const job = this.#jobs.get(jobId);
			if (!job || (job.status !== "completed" && job.status !== "failed")) continue;
			const queued =
				this.#deliveries.some(delivery => delivery.jobId === jobId) ||
				this.#inFlightDeliveries.some(delivery => delivery.jobId === jobId);
			if (queued) continue;
			this.#enqueueDelivery(jobId, job.status === "completed" ? (job.resultText ?? "") : (job.errorText ?? ""));
		}
	}

	/**
	 * Cancel running jobs. With `filter.ownerId` set, cancels only jobs the
	 * matching agent registered; with no filter, cancels every running job
	 * (used by `dispose()` to nuke the manager's state).
	 */
	cancelAll(filter?: AsyncJobFilter): void {
		for (const job of this.getRunningJobs(filter)) {
			job.status = "cancelled";
			job.abortController.abort();
			this.#scheduleEviction(job.id);
		}
	}

	/**
	 * Immediately evict completed and failed jobs matching the filter instead of
	 * waiting for retention expiry, dropping every queued delivery so a prior
	 * session's result can never be injected into a later transcript. Returns the
	 * number of jobs evicted.
	 *
	 * A delivery whose sink call is already in flight (or drained onto a caller's
	 * yield queue) is guarded by the owner's delivery generation, not the per-id
	 * suppression marker — that marker is cleared when the id is reused.
	 */
	evictCompletedJobs(filter?: AsyncJobFilter): number {
		let evicted = 0;
		for (const job of this.#filterJobs(this.#jobs.values(), filter)) {
			if (job.status !== "completed" && job.status !== "failed") continue;
			this.acknowledgeDeliveries([job.id]);
			if (this.#evictJob(job.id)) evicted += 1;
		}
		return evicted;
	}

	async waitForAll(): Promise<void> {
		await Promise.all(Array.from(this.#jobs.values()).map(job => job.promise));
	}

	/**
	 * Route completions for jobs owned by `ownerId` to `sink`. Sessions register
	 * their own sink at construction and unregister on dispose. Owned deliveries
	 * with no live sink are dead-lettered — `onJobComplete` serves only unowned
	 * deliveries.
	 *
	 * Last registration wins for an owner id; the returned unregister clears the
	 * mapping only while it still points at `sink`, so a revived session's fresh
	 * registration survives its parked predecessor's late cleanup.
	 */
	registerDeliverySink(ownerId: string, sink: AsyncJobDeliverySink): () => void {
		this.#deliverySinks.set(ownerId, sink);
		return () => {
			if (this.#deliverySinks.get(ownerId) === sink) this.#deliverySinks.delete(ownerId);
		};
	}

	/**
	 * Wait until every job owned by `ownerId` has settled — its run promise
	 * resolved, which for cancelled jobs means the underlying process actually
	 * exited. Jobs registered while waiting (e.g. by a follow-up turn) are
	 * awaited too. Returns false when `timeoutMs` elapses first.
	 *
	 * `excludeSuppressed` skips jobs whose delivery is suppressed (acknowledged
	 * or `hub`-watched): those can never re-wake a run, so quiescence barriers
	 * pass it to share one contract with the pending-async-wake predicate.
	 * Teardown reaps omit it — worktree safety concerns every owner process.
	 */
	async waitForOwnerJobs(
		ownerId: string,
		options?: { timeoutMs?: number; excludeSuppressed?: boolean },
	): Promise<boolean> {
		const deadline =
			options?.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + Math.max(0, options.timeoutMs);
		const awaited = new Set<string>();
		for (;;) {
			const pending = this.#filterJobs(this.#jobs.values(), { ownerId }).filter(
				job => !awaited.has(job.id) && (options?.excludeSuppressed !== true || !this.isDeliverySuppressed(job.id)),
			);
			if (pending.length === 0) return true;
			for (const job of pending) awaited.add(job.id);
			const settled = await this.#waitForDeliveryPromise(
				Promise.all(pending.map(job => job.promise)).then(() => {}),
				deadline,
			);
			if (!settled) return false;
		}
	}

	async #waitForAllUntil(deadline: number): Promise<boolean> {
		const promises = Array.from(this.#jobs.values()).map(job => job.promise);
		if (promises.length === 0) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await Promise.all(promises);
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;

		const timeout = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => timeout.resolve("timeout"), remainingMs);
		timer.unref();
		try {
			const result = await Promise.race([Promise.all(promises).then(() => "settled" as const), timeout.promise]);
			return result === "settled";
		} finally {
			clearTimeout(timer);
		}
	}

	async drainDeliveries(options?: { timeoutMs?: number; filter?: AsyncJobFilter }): Promise<boolean> {
		const timeoutMs = options?.timeoutMs;
		const filter = options?.filter;
		const hasDeadline = timeoutMs !== undefined;
		const deadline = hasDeadline ? Date.now() + Math.max(timeoutMs, 0) : Number.POSITIVE_INFINITY;

		while (this.hasPendingDeliveries(filter)) {
			if (filter?.ownerId) {
				const delivered = await this.#deliverNextFiltered(filter, deadline);
				if (delivered) continue;
				return false;
			}
			const inFlightDeliveries = this.#filterInFlightDeliveries();
			if (inFlightDeliveries.length > 0 && this.#filterDeliveries().length === 0) {
				const delivered = await this.#waitForDeliveryPromise(inFlightDeliveries[0]?.promise, deadline);
				if (delivered) continue;
				return false;
			}

			this.#ensureDeliveryLoop();
			const loop = this.#deliveryLoop;
			if (!loop) {
				continue;
			}

			if (!hasDeadline) {
				await loop;
				continue;
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}

			await Promise.race([loop, Bun.sleep(remainingMs)]);
			if (Date.now() >= deadline && this.hasPendingDeliveries(filter)) {
				return false;
			}
		}

		return true;
	}

	async dispose(options?: { timeoutMs?: number }): Promise<boolean> {
		this.#disposed = true;
		this.#clearEvictionTimers();
		this.cancelAll();
		const timeoutMs = Math.max(options?.timeoutMs ?? 3_000, 0);
		const deadline = Date.now() + timeoutMs;
		const jobsSettled = await this.#waitForAllUntil(deadline);
		const drained = await this.drainDeliveries({ timeoutMs: Math.max(deadline - Date.now(), 0) });
		this.#clearEvictionTimers();
		this.#jobs.clear();
		this.#deliveries.length = 0;
		this.#inFlightDeliveries.length = 0;
		this.#suppressedDeliveries.clear();
		this.#watchedJobs.clear();
		this.#pollEscalation.clear();
		this.#deliverySinks.clear();
		this.#progressSinks.clear();
		this.#clearAllProgressState();
		return jobsSettled && drained;
	}

	#resolveJobId(preferredId?: string): string {
		preferredId = preferredId?.trim();
		if (!preferredId) {
			let candidate = 1;
			while (true) {
				const id = `bg_${candidate}`;
				if (!this.#jobs.has(id)) {
					return id;
				}
				candidate += 1;
			}
		}

		const base = preferredId.trim();
		if (!this.#jobs.has(base)) return base;

		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (this.#jobs.has(candidate)) {
			suffix += 1;
			candidate = `${base}-${suffix}`;
		}
		return candidate;
	}

	#evictJob(jobId: string): boolean {
		clearTimeout(this.#evictionTimers.get(jobId));
		this.#evictionTimers.delete(jobId);
		this.#suppressedDeliveries.delete(jobId);
		this.#watchedJobs.delete(jobId);
		this.#clearProgressState(jobId);
		return this.#jobs.delete(jobId);
	}

	#scheduleEviction(jobId: string): void {
		// Every settle path funnels through here, so this is where a monitor's
		// trailing-edge timer stops: the job is no longer running, so a pending
		// update would be dropped at flush anyway — releasing the timer now just
		// avoids holding it for up to one window.
		this.#clearProgressState(jobId);
		if (this.#disposed) return;
		if (this.#retentionMs <= 0) {
			this.#evictJob(jobId);
			return;
		}
		const existing = this.#evictionTimers.get(jobId);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.#evictJob(jobId);
		}, this.#retentionMs);
		timer.unref();
		this.#evictionTimers.set(jobId, timer);
	}

	#clearEvictionTimers(): void {
		for (const timer of this.#evictionTimers.values()) {
			clearTimeout(timer);
		}
		this.#evictionTimers.clear();
	}

	#filterDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId));
		return this.#deliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId),
		);
	}

	#filterInFlightDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return this.#inFlightDeliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId));
		return this.#inFlightDeliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId),
		);
	}

	async #deliverNextFiltered(filter: AsyncJobFilter, deadline: number): Promise<boolean> {
		while (true) {
			let selected: AsyncJobDelivery | undefined;
			for (const delivery of this.#deliveries) {
				if (delivery.ownerId !== filter.ownerId) continue;
				if (this.isDeliverySuppressed(delivery.jobId)) continue;
				if (!selected || delivery.nextAttemptAt < selected.nextAttemptAt) {
					selected = delivery;
				}
			}

			if (!selected) {
				const inFlight = this.#filterInFlightDeliveries(filter);
				if (inFlight.length === 0) return true;
				return this.#waitForDeliveryPromise(inFlight[0]?.promise, deadline);
			}

			const now = Date.now();
			if (selected.nextAttemptAt > now) {
				if (selected.nextAttemptAt > deadline) return false;
				await Bun.sleep(selected.nextAttemptAt - now);
				continue;
			}

			const index = this.#deliveries.indexOf(selected);
			if (index === -1) continue;
			this.#deliveries.splice(index, 1);
			if (this.isDeliverySuppressed(selected.jobId)) continue;

			return this.#waitForDeliveryPromise(this.#deliverDelivery(selected), deadline);
		}
	}

	isDeliverySuppressed(jobId: string): boolean {
		return this.#suppressedDeliveries.has(jobId) || this.#watchedJobs.has(jobId);
	}

	#enqueueDelivery(jobId: string, text: string): void {
		// Skip delivery if already acknowledged
		if (this.isDeliverySuppressed(jobId)) {
			return;
		}
		this.#deliveries.push({
			jobId,
			text,
			attempt: 0,
			nextAttemptAt: Date.now(),
			ownerId: this.#jobs.get(jobId)?.ownerId,
		});
		this.#ensureDeliveryLoop();
	}

	#ensureDeliveryLoop(): void {
		if (this.#deliveryLoop) {
			return;
		}

		this.#deliveryLoop = this.#runDeliveryLoop()
			.catch(error => {
				logger.error("Async job delivery loop crashed", { error: String(error) });
			})
			.finally(() => {
				this.#deliveryLoop = undefined;
				if (this.#deliveries.length > 0) {
					this.#ensureDeliveryLoop();
				}
			});
	}

	async #runDeliveryLoop(): Promise<void> {
		while (this.#deliveries.length > 0) {
			const delivery = this.#deliveries[0];
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}
			const waitMs = delivery.nextAttemptAt - Date.now();
			if (waitMs > 0) {
				await Bun.sleep(waitMs);
			}
			if (this.#deliveries[0] !== delivery) {
				continue;
			}
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}

			this.#deliveries.shift();
			await this.#deliverDelivery(delivery);
		}
	}

	/**
	 * Resolve the sink for one delivery attempt: owned deliveries route ONLY to
	 * their owner's registered sink (a missing sink dead-letters — never the
	 * default, which would misroute a dead owner's result into another
	 * session); unowned deliveries use the constructor default. Resolved per
	 * attempt so a sink registered between retries (e.g. a revived session)
	 * picks up the retry.
	 */
	#resolveDeliverySink(ownerId: string | undefined): AsyncJobDeliverySink | undefined {
		if (ownerId !== undefined) return this.#deliverySinks.get(ownerId);
		return this.#onJobComplete;
	}

	#deliverDelivery(delivery: AsyncJobDelivery): Promise<void> {
		const sink = this.#resolveDeliverySink(delivery.ownerId);
		if (!sink) {
			// Dead-letter: owned delivery with no live sink (session disposed or
			// parked), or unowned delivery with no default sink. Drop it — the
			// job row keeps its result/error text until retention eviction, so
			// the outcome stays inspectable via job queries and agent:// reads.
			logger.warn("Async job delivery dead-lettered: no delivery sink", {
				jobId: delivery.jobId,
				ownerId: delivery.ownerId,
			});
			delivery.promise = Promise.resolve();
			return delivery.promise;
		}
		const promise = (async () => {
			this.#inFlightDeliveries.push(delivery);
			try {
				await sink(delivery.jobId, delivery.text, this.#jobs.get(delivery.jobId));
			} catch (error) {
				delivery.attempt += 1;
				delivery.lastError = error instanceof Error ? error.message : String(error);
				delivery.nextAttemptAt = Date.now() + this.#getRetryDelay(delivery.attempt);
				if (!this.isDeliverySuppressed(delivery.jobId)) {
					this.#deliveries.push(delivery);
				}
				logger.warn("Async job completion delivery failed", {
					jobId: delivery.jobId,
					attempt: delivery.attempt,
					nextRetryAt: delivery.nextAttemptAt,
					error: delivery.lastError,
				});
			} finally {
				const index = this.#inFlightDeliveries.indexOf(delivery);
				if (index !== -1) this.#inFlightDeliveries.splice(index, 1);
				if (this.#deliveries.length > 0) this.#ensureDeliveryLoop();
			}
		})();
		delivery.promise = promise;
		return promise;
	}

	async #waitForDeliveryPromise(promise: Promise<void> | undefined, deadline: number): Promise<boolean> {
		if (!promise) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await promise;
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		let timedOut = false;
		await Promise.race([
			promise,
			Bun.sleep(remainingMs).then(() => {
				timedOut = true;
			}),
		]);
		return !timedOut;
	}

	#getRetryDelay(attempt: number): number {
		const exp = Math.min(Math.max(attempt - 1, 0), 8);
		const backoffMs = DELIVERY_RETRY_BASE_MS * 2 ** exp;
		const jitterMs = Math.floor(Math.random() * DELIVERY_RETRY_JITTER_MS);
		return Math.min(DELIVERY_RETRY_MAX_MS, backoffMs + jitterMs);
	}
}
