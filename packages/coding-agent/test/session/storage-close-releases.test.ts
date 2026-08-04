import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

/**
 * Closing a `bun:sqlite` Database runs `sqlite3_close_v2`, which *defers* the
 * close while any prepared statement is still outstanding. A one-shot
 * `db.prepare(...)` that is never finalized therefore leaves the file handle
 * open forever even though `close()` returned without error — the storage
 * classes' `close()`/`resetInstance()` silently did nothing.
 *
 * The portable tell is the WAL sidecars: SQLite deletes `<db>-wal` and
 * `<db>-shm` when the *last* connection closes, and leaves them when the close
 * was deferred. On Windows the same leak is louder — the temp directory cannot
 * be removed at all (`EBUSY`), which is how this was found.
 */
describe("storage handles are released on close", () => {
	const roots: string[] = [];

	function makeRoot(prefix: string): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		roots.push(root);
		return root;
	}

	afterEach(() => {
		AgentStorage.resetInstance();
		HistoryStorage.resetInstance();
		while (roots.length > 0) removeSyncWithRetries(roots.pop()!);
	});

	it("releases agent.db once the AgentStorage singleton is reset", async () => {
		const dbPath = path.join(makeRoot("omp-agent-close-"), "agent.db");
		const storage = await AgentStorage.open(dbPath);
		// Exercise the read/write paths that build one-shot statements.
		storage.getSettings();
		storage.recordModelUsage("anthropic/claude-opus-5");
		storage.getModelUsageOrder();
		storage.listAuthCredentials();

		AgentStorage.resetInstance();

		expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
		expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
	});

	it("releases history.db once the HistoryStorage singleton is reset", async () => {
		const dbPath = path.join(makeRoot("omp-history-close-"), "history.db");
		const storage = HistoryStorage.open(dbPath);
		await storage.add("first prompt", "/tmp/project", "session-1");
		storage.getRecent(5);
		storage.search("first", 5);

		HistoryStorage.resetInstance();

		expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
		expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
	});
});
