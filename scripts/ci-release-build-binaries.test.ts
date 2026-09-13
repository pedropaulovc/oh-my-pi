import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { $ } from "bun";
import { version as codingAgentVersion } from "../packages/coding-agent/package.json" with { type: "json" };
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";
import { compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";
import { resolveDogfoodBuildSettings } from "./ci-release-build-binaries";

const repoRoot = path.join(import.meta.dir, "..");

describe("Windows release binary target", () => {
	it("builds both Windows architecture release assets with their native runtimes", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64,win32-arm64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();

		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-x64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-x64-baseline outfile=packages/coding-agent/binaries/omp-windows-x64.exe",
		);
		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-arm64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-arm64 outfile=packages/coding-agent/binaries/omp-windows-arm64.exe",
		);
		expect(output).toContain("external=fastembed,onnxruntime-node");
		expect(output).not.toContain("bun-windows-x64-modern");
	});

	it("uses dogfood asset names and compile-time defines for the selected x64 outputs", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets linux-x64,win32-x64`
			.cwd(repoRoot)
			.env({
				...process.env,
				DOGFOOD_REPOSITORY: "pedropaulovc/oh-my-pi",
				DOGFOOD_VERSION: `${codingAgentVersion}-dogfood.1`,
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
		expect(output).toContain(`${codingAgentVersion}-dogfood.1`);
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
		).toThrow("must match <semver>-dogfood.1");
		expect(() =>
			resolveDogfoodBuildSettings({
				DOGFOOD_REPOSITORY: "pedropaulovc/oh-my-pi",
				DOGFOOD_VERSION: "999.0.0-dogfood.1",
			}),
		).toThrow("does not match source package version");
	});

	it("resolves local Windows cross-build aliases for both architectures", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("win32-arm64")).toEqual({
			id: "win32-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
		expect(resolveCrossBuild("windows-arm64")).toEqual({
			id: "windows-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
	});
});

it("runs compiled bytecode containing dependency import.meta.resolve calls", async () => {
	using temp = TempDir.createSync("@omp-bytecode-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	await Bun.write(entrypoint, 'console.log(import.meta.resolve("node:fs"));\n');
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		transformersVersion: "unused",
	});
	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text().trim()).toBe("node:fs");
}, 30_000);
describe("macOS release binary entitlements", () => {
	it("allows Xcode MCP automation through Apple Events", async () => {
		const entitlements = await Bun.file(path.join(repoRoot, "scripts/macos-entitlements.plist")).text();

		expect(entitlements).toContain("<key>com.apple.security.automation.apple-events</key>\n\t<true/>");
	});
});
