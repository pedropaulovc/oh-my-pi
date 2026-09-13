/**
 * Regression guard for #11961: Hindsight mental models must not rewrite the
 * active session's cached system-prompt prefix. Two independent churn sources
 * are covered — volatile render metadata and the removed on-timer reload.
 */

import { describe, expect, it, vi } from "bun:test";
import type { HindsightApi, MentalModelSummary } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { renderMentalModelsBlock } from "@oh-my-pi/pi-coding-agent/hindsight/mental-models";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";

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
