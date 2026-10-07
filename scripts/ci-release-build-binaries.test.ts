import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";
import { version as codingAgentVersion } from "../packages/coding-agent/package.json" with { type: "json" };
import { resolveDogfoodBuildSettings } from "./ci-release-build-binaries";

const repoRoot = path.join(import.meta.dir, "..");

// Fork-only coverage: upstream dropped its repo script tests, so this file
// carries just the dogfood build identity the fork adds to the release script.
describe("dogfood release binary build", () => {
	it("uses dogfood asset names and compile-time defines for the selected x64 outputs", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets linux-x64,win32-x64`
			.cwd(repoRoot)
			.env({
				...process.env,
				DOGFOOD_REPOSITORY: "pedropaulovc/oh-my-pi",
				DOGFOOD_VERSION: `${codingAgentVersion}-dogfood.2`,
			})
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();
		expect(output).toContain("Building packages/coding-agent/binaries/omp-dogfood-linux-x64...");
		expect(output).toContain("Building packages/coding-agent/binaries/omp-dogfood-windows-x64.exe...");
		expect(output).toContain("__OMP_DOGFOOD_REPOSITORY__");
		expect(output).toContain("pedropaulovc/oh-my-pi");
		expect(output).toContain("__OMP_BUILD_VERSION__");
		expect(output).toContain(`${codingAgentVersion}-dogfood.2`);
		expect(output).not.toContain("outfile=packages/coding-agent/binaries/omp-linux-x64 ");
		expect(output).not.toContain("outfile=packages/coding-agent/binaries/omp-windows-x64.exe ");
	});

	it("rejects partial and non-dogfood build environments", () => {
		expect(() => resolveDogfoodBuildSettings({ DOGFOOD_REPOSITORY: "pedropaulovc/oh-my-pi" })).toThrow(
			"provided together",
		);
		expect(() =>
			resolveDogfoodBuildSettings({
				DOGFOOD_REPOSITORY: "pedropaulovc/oh-my-pi",
				DOGFOOD_VERSION: codingAgentVersion,
			}),
		).toThrow("must match <semver>-dogfood.<positive revision>");
		expect(() =>
			resolveDogfoodBuildSettings({
				DOGFOOD_REPOSITORY: "pedropaulovc/oh-my-pi",
				DOGFOOD_VERSION: "999.0.0-dogfood.1",
			}),
		).toThrow("does not match source package version");
	});
});
