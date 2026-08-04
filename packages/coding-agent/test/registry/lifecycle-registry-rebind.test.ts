/**
 * The global lifecycle manager must always manage the current global registry.
 *
 * `AgentLifecycleManager` captures its registry at construction, while
 * `AgentRegistry.resetGlobalForTests()` replaces the registry global. A manager
 * left bound to the discarded registry fails silently rather than loudly: every
 * lookup misses, so `release()` returns false without tombstoning the ref, and
 * anything awaiting `status === "aborted"` waits forever. That surfaced as
 * `collab read-only links > keeps a remotely killed subagent tombstoned` timing
 * out in full-suite runs while passing in isolation — the reset lived in an
 * entirely different test file.
 */
import { afterEach, expect, test } from "bun:test";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/**
 * These tests deliberately swap the registry global, which is exactly the
 * cross-file pollution the fix exists to survive. Put both globals back so the
 * pollution does not outlive the file.
 */
afterEach(() => {
	AgentRegistry.global().unregister("Rebind-Sub");
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

function fakeSession(counter: { aborts: number }): AgentSession {
	return {
		abort: async () => {
			counter.aborts++;
		},
		dispose: async () => {},
	} as unknown as AgentSession;
}

test("the global manager rebinds when the registry global is replaced under it", () => {
	// Construct the manager against the current registry, then swap the registry
	// the way another test file's cleanup would.
	AgentLifecycleManager.global();
	AgentRegistry.resetGlobalForTests();

	expect(AgentLifecycleManager.global().manages(AgentRegistry.global())).toBe(true);
});

test("release() still tombstones an agent registered after a registry swap", async () => {
	AgentLifecycleManager.global();
	AgentRegistry.resetGlobalForTests();
	const registry = AgentRegistry.global();

	const counter = { aborts: 0 };
	const id = "Rebind-Sub";
	const ref = registry.register({
		id,
		displayName: "rebind",
		kind: "sub",
		session: fakeSession(counter),
		sessionFile: `/tmp/${id}.jsonl`,
		status: "running",
	});

	const released = await AgentLifecycleManager.global().release(id, ref, { tombstone: true });

	// Before the rebind this returned false and left the ref `running`, so a
	// waiter on the aborted transition never woke.
	expect(released).toBe(true);
	expect(registry.get(id)).toMatchObject({ status: "aborted", session: null });
});
