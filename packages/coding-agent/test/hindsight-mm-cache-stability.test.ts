/**
 * Regression guard for #11961: Hindsight mental models must not rewrite the
 * active session's cached system-prompt prefix. Two independent churn sources
 * are covered — volatile render metadata and the removed on-timer reload.
 */

import { describe, expect, it, vi } from "bun:test";
import type {
	HindsightApi,
	MentalModelListResponse,
	MentalModelSummary,
} from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderMentalModelsBlock } from "@oh-my-pi/pi-coding-agent/hindsight/mental-models";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { SessionMemory, type SessionMemoryHost } from "@oh-my-pi/pi-coding-agent/session/session-memory";

function makeConfig(overrides: Partial<HindsightConfig> = {}): HindsightConfig {
	return {
		hindsightApiUrl: "http://localhost:8888",
		hindsightApiToken: null,
		bankId: null,
		bankIdPrefix: "",
		scoping: "global",
		bankMission: "",
		retainMission: null,
		autoRecall: false,
		autoRetain: false,
		retainMode: "full-session",
		retainEveryNTurns: 3,
		retainOverlapTurns: 2,
		retainContext: "omp",
		recallBudget: "mid",
		recallMaxTokens: 1024,
		recallTypes: [],
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		recallPromptPreamble: "preamble",
		debug: false,
		requestTimeoutMs: 30_000,
		reflectTimeoutMs: 120_000,
		recallTimeoutMs: 30_000,
		retainTimeoutMs: 60_000,
		mentalModelsEnabled: true,
		mentalModelAutoSeed: false,
		mentalModelMaxRenderChars: 16_000,
		...overrides,
	};
}

describe("renderMentalModelsBlock cache stability", () => {
	it("is byte-identical when only last_refreshed_at changes", () => {
		const model: MentalModelSummary = { id: "u", bank_id: "b", name: "User Preferences", content: "prefers tabs" };
		const early = renderMentalModelsBlock([{ ...model, last_refreshed_at: "2026-09-12T20:00:00Z" }], 16_000);
		const late = renderMentalModelsBlock([{ ...model, last_refreshed_at: "2026-09-12T20:10:00Z" }], 16_000);
		expect(early).toBe(late);
		// And the volatile timestamp never leaks into the model-facing block.
		expect(early).not.toContain("refreshed");
	});
});

describe("HindsightSessionState mental-model freeze", () => {
	function makeState() {
		const listeners = new Set<AgentSessionEventListener>();
		const client = { listMentalModels: async () => ({ items: [] }) } as unknown as HindsightApi;
		const state = new HindsightSessionState({
			sessionId: "s",
			client,
			bankId: "b",
			config: makeConfig(),
			session: {
				subscribe: (fn: AgentSessionEventListener) => {
					listeners.add(fn);
					return () => listeners.delete(fn);
				},
				refreshBaseSystemPrompt: async () => {},
				sessionManager: { getEntries: () => [] },
			} as never,
			banksSet: new Set(),
			lastRetainedTurn: 0,
			hasRecalledForFirstTurn: false,
		});
		return { state, listeners };
	}

	it("does not reload the snippet on agent_end even long past the old TTL window", () => {
		const { state, listeners } = makeState();
		const reload = vi.spyOn(state, "refreshMentalModelsSnippet").mockResolvedValue();
		const flush = vi.spyOn(state, "flushRetainQueue").mockResolvedValue();
		state.mentalModelsSnippet = "<mental_models>frozen</mental_models>";
		// Loaded well beyond any previous refresh interval — the timer path is gone.
		state.mentalModelsLoadedAt = Date.now() - 60 * 60 * 1000;

		state.attachSessionListeners();
		for (const fn of listeners) fn({ type: "agent_end", messages: [] } as never);

		// Listener is live (retain queue drained) but the frozen block is untouched.
		expect(flush).toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		expect(state.mentalModelsSnippet).toBe("<mental_models>frozen</mental_models>");
	});
});

describe("SessionMemory mental-model boundary reload", () => {
	function makeBoundaryHarness(response: Promise<MentalModelListResponse>) {
		const published: Array<string | undefined> = [];
		const client = { listMentalModels: () => response } as unknown as HindsightApi;
		const stateSession = {
			refreshBaseSystemPrompt: async () => {},
			sessionManager: { getEntries: () => [] },
		};
		const state = new HindsightSessionState({
			sessionId: "next-session",
			client,
			bankId: "b",
			config: makeConfig(),
			session: stateSession as never,
			banksSet: new Set(),
			lastRetainedTurn: 0,
			hasRecalledForFirstTurn: false,
		});
		const publish = async () => {
			published.push(state.mentalModelsSnippet);
		};
		stateSession.refreshBaseSystemPrompt = publish;
		state.mentalModelsSnippet = "<mental_models>old</mental_models>";
		state.mentalModelsLoadedAt = Date.now();
		const host = {
			agent: { sessionId: "next-session" },
			settings: Settings.isolated({ "memory.backend": "hindsight" }),
			modelRegistry: {},
			isDisposed: () => false,
			memoryBackendSession: () => ({}),
			getHindsightSessionState: () => state,
			setHindsightSessionState: () => {},
			getMnemopiSessionState: () => undefined,
			takeMnemopiSessionState: () => undefined,
			setBaseSystemPrompt: () => {},
			refreshBaseSystemPrompt: publish,
			replaceMemoryTools: async () => {},
		} as unknown as SessionMemoryHost;
		return { memory: new SessionMemory(host, {}), published, state };
	}

	it("does not block the transition and publishes a refresh that meets the first-turn deadline", async () => {
		const response = Promise.withResolvers<MentalModelListResponse>();
		const { memory, published, state } = makeBoundaryHarness(response.promise);

		await memory.resetContextForNewTranscript();
		expect(published).toEqual(["<mental_models>old</mental_models>"]);

		response.resolve({
			items: [{ id: "u", bank_id: "b", name: "User Preferences", content: "updated preference" }],
		});
		await state.mentalModelsLoadPromise;

		expect(published).toHaveLength(2);
		expect(published[1]).toContain("updated preference");
	});

	it("preserves the previous snapshot when the reload misses the deadline", async () => {
		vi.useFakeTimers();
		try {
			const response = Promise.withResolvers<MentalModelListResponse>();
			const { memory, published, state } = makeBoundaryHarness(response.promise);

			await memory.resetContextForNewTranscript();
			vi.advanceTimersByTime(1_500);
			await state.mentalModelsLoadPromise;

			response.resolve({
				items: [{ id: "u", bank_id: "b", name: "User Preferences", content: "late preference" }],
			});
			await Promise.resolve();

			expect(state.mentalModelsSnippet).toBe("<mental_models>old</mental_models>");
			expect(published).toEqual(["<mental_models>old</mental_models>"]);
		} finally {
			vi.useRealTimers();
		}
	});
});
