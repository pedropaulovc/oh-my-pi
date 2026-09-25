#!/usr/bin/env bun
/**
 * Fork maintenance automation for `pedropaulovc/oh-my-pi`.
 *
 * Runs on a schedule in the fork (never upstream) and keeps the fork's branches
 * rebased on upstream `main`, rebuilds the `dogfood` integration branch, and
 * asks `dogfood-release.yml` for a dogfood build whenever the rebuilt `dogfood`
 * head differs from the source commit of the newest published dogfood release
 * for the current upstream version — i.e. whenever upstream `main` or any
 * tracked fork branch moved. The revision in `v<version>-dogfood.<revision>`
 * is allocated one above the highest published revision for that version, so a
 * respin needs no new upstream release. An unchanged integration rebuilds to
 * the identical `dogfood` OID and therefore publishes nothing.
 *
 * Tracked branches:
 *   - `main`                       — retained if it contains upstream/main; otherwise rebased
 *   - every open upstream PR whose head repository is the fork
 *   - every open fork PR head/base branch (for fork-only stacks)
 *   - every branch listed in the `PRIVATE_REBASE_BRANCHES` repository variable
 *
 * Branches that contain each other form a *stack*; stacks that share commits
 * form one independent group. Each group is rebased on its own (a conflict in
 * one group never blocks another) and the maximal tip of every stack is rebased
 * with `git rebase --update-refs`, so the intermediate branch refs of the stack
 * stay aligned instead of being orphaned behind the rewritten tip. A conflicted
 * group is aborted and its remote refs are left untouched.
 *
 * Usage:
 *   bun scripts/fork-maintenance.ts            # full run (CI)
 *   bun scripts/fork-maintenance.ts --dry-run  # plan only, never writes a ref
 *   bun scripts/fork-maintenance.ts --dry-run --no-fetch
 */

import * as fs from "node:fs/promises";

export const UPSTREAM_REPO = "can1357/oh-my-pi";
export const FORK_REPO = "pedropaulovc/oh-my-pi";
export const MAIN_BRANCH = "main";
export const DOGFOOD_BRANCH = "dogfood";
export const DOGFOOD_RELEASE_WORKFLOW = "dogfood-release.yml";
export const ISSUE_TITLE = "[automation] Fork rebase needs attention";
export const ISSUE_MENTION = "@pedropaulovc";

/** Branches this script owns outright; they never take part in stack planning. */
const RESERVED_BRANCHES: Record<string, true> = { [MAIN_BRANCH]: true, [DOGFOOD_BRANCH]: true };

// ---------------------------------------------------------------------------
// Pure planning helpers (unit-tested in fork-maintenance.test.ts)
// ---------------------------------------------------------------------------

/**
 * Parse the `PRIVATE_REBASE_BRANCHES` repository variable. Entries may be
 * separated by commas, newlines, or spaces; `refs/heads/` prefixes are
 * tolerated; reserved branches and duplicates are dropped.
 */
export function parsePrivateBranches(raw: string | undefined | null): string[] {
	const seen = new Set<string>();
	const branches: string[] = [];
	for (const token of (raw ?? "").split(/[\s,]+/)) {
		const name = token.replace(/^refs\/heads\//, "");
		if (!name || RESERVED_BRANCHES[name] || seen.has(name)) continue;
		seen.add(name);
		branches.push(name);
	}
	return branches;
}

/** A fork branch to rebase, with the tracked branches contained in its history. */
export interface TrackedBranch {
	name: string;
	/** Current remote head OID. */
	head: string;
	/** Names of other tracked branches whose heads are ancestors of `head`. */
	ancestors: readonly string[];
}

/** One `git rebase` invocation. */
export interface RebaseStep {
	/** Maximal stack tip to rebase. */
	branch: string;
	/** Tracked ancestors this rebase rewrites too, ordered base → tip (`--update-refs`). */
	carried: string[];
	/** New base: upstream main, or an already-rewritten tracked ancestor branch. */
	onto: string;
	/** Old boundary excluded from replay (`git rebase --onto <onto> <fromOid> <branch>`). */
	fromOid?: string;
}

/** Branches that share history and therefore must be rebased together. */
export interface RebaseGroup {
	/** Every tracked branch in the group, sorted. */
	members: string[];
	/** Rebase steps in execution order. */
	steps: RebaseStep[];
}

/**
 * Partition tracked branches into independent groups and plan the rebases.
 *
 * Within a group only *maximal* tips are rebased — a branch that no other
 * tracked branch builds on. Deeper stacks go first, so when a later tip shares
 * an already-rewritten ancestor it is replayed from that ancestor's old head
 * onto its new head instead of duplicating the shared commits.
 *
 * `boundaryByBranch` excludes the old fork-main prefix from replay, keeping
 * fork-private main commits out of branches proposed to upstream.
 */
export function planRebaseGroups(
	branches: readonly TrackedBranch[],
	baseRef: string,
	boundaryByBranch: Readonly<Record<string, string>> = {},
): RebaseGroup[] {
	const byName = new Map(branches.map(branch => [branch.name, branch]));
	const ancestorsOf = new Map<string, string[]>();
	for (const branch of branches) {
		const ancestors = [...new Set(branch.ancestors)].filter(name => name !== branch.name && byName.has(name));
		ancestorsOf.set(branch.name, ancestors.sort());
	}
	const depthOf = (name: string): number => ancestorsOf.get(name)?.length ?? 0;

	// Union-find over the "shares tracked history" relation.
	const parent = new Map<string, string>(branches.map(branch => [branch.name, branch.name]));
	const find = (name: string): string => {
		let root = name;
		while (parent.get(root) !== root) root = parent.get(root) ?? root;
		let cursor = name;
		while (parent.get(cursor) !== root) {
			const next = parent.get(cursor) ?? root;
			parent.set(cursor, root);
			cursor = next;
		}
		return root;
	};
	for (const branch of branches) {
		for (const ancestor of ancestorsOf.get(branch.name) ?? []) {
			const [a, b] = [find(branch.name), find(ancestor)];
			if (a !== b) parent.set(a, b);
		}
	}

	const componentMembers = new Map<string, string[]>();
	for (const branch of branches) {
		const root = find(branch.name);
		const members = componentMembers.get(root);
		if (members) members.push(branch.name);
		else componentMembers.set(root, [branch.name]);
	}

	const groups: RebaseGroup[] = [];
	for (const rawMembers of componentMembers.values()) {
		const members = rawMembers.sort();
		const consumed = new Set<string>();
		for (const member of members) {
			for (const ancestor of ancestorsOf.get(member) ?? []) consumed.add(ancestor);
		}
		// Deepest stack first, so shared bases are rewritten exactly once.
		const tips = members
			.filter(member => !consumed.has(member))
			.sort((a, b) => depthOf(b) - depthOf(a) || a.localeCompare(b));

		const steps: RebaseStep[] = [];
		const rewritten = new Set<string>();
		const planTip = (tip: string): void => {
			const ancestors = ancestorsOf.get(tip) ?? [];
			const done = ancestors.filter(name => rewritten.has(name));
			const carried = ancestors
				.filter(name => !rewritten.has(name))
				.sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
			let onto = baseRef;
			let fromOid: string | undefined = boundaryByBranch[tip];
			if (done.length > 0) {
				const deepest = done.reduce((best, name) =>
					depthOf(name) > depthOf(best) || (depthOf(name) === depthOf(best) && name < best) ? name : best,
				);
				onto = deepest;
				fromOid = byName.get(deepest)?.head;
			}
			steps.push({ branch: tip, carried, onto, fromOid });
			rewritten.add(tip);
			for (const name of carried) rewritten.add(name);
		};
		for (const tip of tips) planTip(tip);
		// Defensive: a caller that reports only direct-parent ancestry can leave
		// a member unreachable from any tip. Rebase it on the shared base rather
		// than silently dropping it.
		for (const member of members) {
			if (!rewritten.has(member)) planTip(member);
		}
		groups.push({ members, steps });
	}
	return groups.sort((a, b) => (a.members[0] ?? "").localeCompare(b.members[0] ?? ""));
}

/** A maximal tip that gets merged into `dogfood`. */
export interface IntegrationTip {
	branch: string;
	/** Upstream PR number when the branch is an open PR head. */
	prNumber?: number;
}

/**
 * Deterministic integration order: PR heads by ascending PR number (oldest PR
 * integrates first, so its conflicts are not attributed to a newer branch),
 * then private branches by name.
 */
export function orderIntegrationTips(tips: readonly IntegrationTip[]): IntegrationTip[] {
	return [...tips].sort((a, b) => {
		if (a.prNumber !== undefined && b.prNumber !== undefined) return a.prNumber - b.prNumber;
		if (a.prNumber !== undefined) return -1;
		if (b.prNumber !== undefined) return 1;
		return a.branch.localeCompare(b.branch);
	});
}

/** A branch whose remote ref should be moved to `target`. */
export interface RefUpdate {
	branch: string;
	/** Remote OID observed before the rewrite; `null` when the remote ref does not exist. */
	expected: string | null;
	target: string;
}

export interface PushPlan {
	/** Full `git` argv, or an empty array when nothing needs pushing. */
	args: string[];
	pushed: string[];
	skipped: string[];
}

/**
 * Plan one atomic push. Unchanged refs are skipped, and every updated ref
 * carries an explicit `--force-with-lease=<ref>:<expected>` so a ref that moved
 * since the run started is rejected instead of clobbered. A brand-new branch
 * leases the empty OID, which git rejects if the ref exists after all.
 */
export function planPush(updates: readonly RefUpdate[]): PushPlan {
	const ordered = [...updates].sort((a, b) => a.branch.localeCompare(b.branch));
	const leases: string[] = [];
	const refspecs: string[] = [];
	const pushed: string[] = [];
	const skipped: string[] = [];
	for (const update of ordered) {
		if (update.expected === update.target) {
			skipped.push(update.branch);
			continue;
		}
		leases.push(`--force-with-lease=refs/heads/${update.branch}:${update.expected ?? ""}`);
		refspecs.push(`${update.target}:refs/heads/${update.branch}`);
		pushed.push(update.branch);
	}
	if (pushed.length === 0) return { args: [], pushed, skipped };
	return { args: ["push", "--atomic", ...leases, "origin", ...refspecs], pushed, skipped };
}

/**
 * Last commit in the contiguous branch prefix patch-equivalent to current fork
 * main. This recovers the old-main boundary after main itself was rebased and
 * its commit OIDs changed; later equivalent commits are not safe to skip once
 * branch-unique work has started.
 */
export function findEquivalentMainBoundary(cherryOutput: string): string | undefined {
	let boundary: string | undefined;
	for (const rawLine of cherryOutput.split("\n")) {
		const match = /^([+-]) ([0-9a-f]{40})$/.exec(rawLine.trim());
		if (!match || match[1] !== "-") break;
		boundary = match[2];
	}
	return boundary;
}

const NORMAL_RELEASE_TAG = /^v?(\d+\.\d+\.\d+)$/;

/** Upstream version of a stable release tag; prereleases (canary, rc, …) have
 * no dogfood counterpart and return `undefined`. */
export function upstreamVersionOf(upstreamTag: string): string | undefined {
	return NORMAL_RELEASE_TAG.exec(upstreamTag.trim())?.[1];
}

/**
 * Fork dogfood tag for an upstream release tag and build revision. Prereleases
 * return `undefined`.
 */
export function dogfoodTagFor(upstreamTag: string, revision = 1): string | undefined {
	const version = upstreamVersionOf(upstreamTag);
	return version ? `v${version}-dogfood.${revision}` : undefined;
}

/** `run-name` that `dogfood-release.yml` reports for a given upstream tag. */
export function dogfoodRunTitle(upstreamTag: string): string {
	return `Dogfood ${upstreamTag}`;
}

/** A fork release, as reported by `repos/<fork>/releases` (drafts included). */
export interface ForkReleaseSummary {
	tag_name: string;
	/**
	 * Commit the release was built from — the `dogfood` head at dispatch. Only
	 * a full OID proves a source: the API also accepts a branch name here, and
	 * ignores the field entirely for a release created against an existing tag.
	 */
	target_commitish: string;
	/** A draft reserves its tag but carries no published build. */
	draft: boolean;
}

/** Newest published dogfood release for one upstream version. */
export interface PublishedDogfood {
	revision: number;
	/** `undefined` when the release does not name an OID it was built from. */
	sourceSha: string | undefined;
}

const RELEASE_OID = /^[0-9a-f]{40}$/;

function dogfoodRevisionPattern(version: string): RegExp {
	return new RegExp(`^v${version.replaceAll(".", "\\.")}-dogfood\\.([1-9]\\d*)$`);
}

/**
 * Highest-revision published dogfood release for `upstreamTag`, or `undefined`
 * when the fork has never published that upstream version. Drafts are skipped:
 * asset upload starts as a draft, so an interrupted publish leaves one behind,
 * and treating it as built would suppress the release it failed to produce.
 */
export function latestDogfoodRelease(
	releases: readonly ForkReleaseSummary[],
	upstreamTag: string,
): PublishedDogfood | undefined {
	const version = upstreamVersionOf(upstreamTag);
	if (!version) return undefined;
	const tagPattern = dogfoodRevisionPattern(version);
	let latest: PublishedDogfood | undefined;
	for (const release of releases) {
		if (release.draft) continue;
		const revision = Number(tagPattern.exec(release.tag_name.trim())?.[1]);
		if (!revision || (latest && revision <= latest.revision)) continue;
		const source = release.target_commitish.trim().toLowerCase();
		latest = { revision, sourceSha: RELEASE_OID.test(source) ? source : undefined };
	}
	return latest;
}

/** Whether the rebuilt `dogfood` head still needs a release, and under which tag. */
export type DogfoodReleasePlan =
	| { publish: false; dogfoodTag?: string; reason: string }
	| { publish: true; dogfoodTag: string; revision: number };

/**
 * Decide whether the current `dogfood` head deserves a release. Content, not
 * upstream version, is the trigger: any movement of upstream `main` or a
 * tracked fork branch rebuilds `dogfood` to a new OID, which earns the next
 * revision. Republishing the same OID is the only suppressed case.
 *
 * `occupiedTags` are the `v<version>-dogfood.N` tags that already exist in the
 * fork. A tag outlives its release, and `dogfood-release.yml` refuses to reuse
 * one, so revisions are allocated above every tag and draft — not just above
 * the newest published release.
 */
export function planDogfoodRelease(
	upstreamTag: string,
	dogfoodSha: string,
	releases: readonly ForkReleaseSummary[],
	occupiedTags: readonly string[] = [],
): DogfoodReleasePlan {
	const version = upstreamVersionOf(upstreamTag);
	if (!version) return { publish: false, reason: `upstream ${upstreamTag} is not a normal release` };
	const published = latestDogfoodRelease(releases, upstreamTag);
	const builtTag = published ? dogfoodTagFor(upstreamTag, published.revision) : undefined;
	if (published?.sourceSha === dogfoodSha.trim().toLowerCase()) {
		return { publish: false, dogfoodTag: builtTag, reason: `${builtTag} already built ${dogfoodSha}` };
	}
	const tagPattern = dogfoodRevisionPattern(version);
	const taken = [...releases.map(release => release.tag_name), ...occupiedTags]
		.map(name => Number(tagPattern.exec(name.trim())?.[1]))
		.filter(revision => revision > 0);
	const revision = Math.max(0, ...taken) + 1;
	return { publish: true, dogfoodTag: `v${version}-dogfood.${revision}`, revision };
}

/** Statuses that mean a dispatched dogfood release is still going to produce a release. */
const ACTIVE_RUN_STATUSES: Record<string, true> = {
	queued: true,
	in_progress: true,
	waiting: true,
	requested: true,
	pending: true,
};

export interface WorkflowRunSummary {
	display_title: string;
	status: string;
}

/**
 * True when a dogfood release for `upstreamTag` is already queued or running.
 * The maintenance job polls far more often than a release build takes, so
 * "fork release is absent" alone would dispatch a duplicate every poll.
 */
export function hasActiveDogfoodRun(runs: readonly WorkflowRunSummary[], upstreamTag: string): boolean {
	const title = dogfoodRunTitle(upstreamTag);
	return runs.some(run => run.display_title === title && ACTIVE_RUN_STATUSES[run.status] === true);
}

export type FailureStage = "rebase" | "push" | "merge" | "dispatch";

export interface MaintenanceFailure {
	stage: FailureStage;
	branches: string[];
	detail: string;
}

/** Body of the single maintained alert issue in the fork. */
export function formatIssueBody(failures: readonly MaintenanceFailure[], runUrl: string | undefined): string {
	const lines = [
		`${ISSUE_MENTION} automated fork maintenance could not finish cleanly.`,
		"",
		"| stage | branches | detail |",
		"| --- | --- | --- |",
	];
	for (const failure of failures) {
		const detail = failure.detail.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
		lines.push(`| ${failure.stage} | \`${failure.branches.join("`, `")}\` | ${detail} |`);
	}
	lines.push(
		"",
		"Independent branch groups that rebased cleanly were pushed; conflicted groups and the remote dogfood branch were preserved.",
		"",
		runUrl ? `Run: ${runUrl}` : "Run: (local invocation)",
		`Updated: ${new Date().toISOString()}`,
		"",
		"This issue is maintained by `scripts/fork-maintenance.ts` and closes automatically once a run is clean.",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

interface RunResult {
	ok: boolean;
	code: number;
	stdout: string;
	stderr: string;
}

interface RunOptions {
	/** Written to the child's stdin. */
	input?: string;
	/** Extra environment on top of the current process environment. */
	env?: Record<string, string>;
}

async function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
	const proc = Bun.spawn([...argv], {
		stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
		env: options.env ? { ...process.env, ...options.env } : undefined,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		proc.exited,
	]);
	return { ok: code === 0, code, stdout, stderr };
}
async function gitTry(...args: string[]): Promise<RunResult> {
	return await run(["git", "-c", "core.hooksPath=/dev/null", ...args]);
}

async function git(...args: string[]): Promise<string> {
	const result = await gitTry(...args);
	if (!result.ok) throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
	return result.stdout.trim();
}

async function ghJson<T>(args: readonly string[]): Promise<T> {
	const result = await run(["gh", ...args]);
	if (!result.ok) throw new Error(`gh ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
	return JSON.parse(result.stdout) as T;
}

/** Git's own diagnosis, preferred over the trailing "hint:" boilerplate, for the alert issue. */
function failureDetail(result: RunResult): string {
	const lines = `${result.stderr}\n${result.stdout}`
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
	const salient = lines.filter(line => /^(CONFLICT|error|fatal|Could not apply|!)/.test(line));
	const chosen = salient.length > 0 ? salient : lines.slice(-4);

	return chosen.slice(0, 4).join(" / ") || `exit code ${result.code}`;
}
async function requireRun(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
	const result = await run(argv, options);
	if (!result.ok) throw new Error(`${argv.join(" ")} failed (${result.code}): ${failureDetail(result)}`);
	return result;
}

// ---------------------------------------------------------------------------
// GitHub payloads
// ---------------------------------------------------------------------------

interface PullRequestBranch {
	ref: string;
	repo: { full_name: string } | null;
}

interface UpstreamPullRequest {
	number: number;
	head: PullRequestBranch;
	base: PullRequestBranch;
}

interface ReleaseSummary {
	tag_name: string;
}

interface IssueSummary {
	number: number;
	title: string;
	state: string;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

interface Options {
	dryRun: boolean;
	fetch: boolean;
	fork: string;
	upstream: string;
}

function parseArgs(argv: readonly string[]): Options {
	const options: Options = { dryRun: false, fetch: true, fork: FORK_REPO, upstream: UPSTREAM_REPO };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run" || arg === "-n") options.dryRun = true;
		else if (arg === "--no-fetch") options.fetch = false;
		else if (arg === "--fork") options.fork = argv[++i] ?? options.fork;
		else if (arg === "--upstream") options.upstream = argv[++i] ?? options.upstream;
		else if (arg === "--help" || arg === "-h") {
			console.log("usage: fork-maintenance.ts [--dry-run] [--no-fetch] [--fork <repo>] [--upstream <repo>]");
			process.exit(0);
		} else {
			console.error(`error: unknown argument: ${arg}`);
			process.exit(2);
		}
	}
	return options;
}

interface BranchCandidate {
	branch: string;
	prNumber?: number;
}

interface TrackedBranchInfo extends TrackedBranch {
	prNumber?: number;
}

async function revParse(ref: string): Promise<string | null> {
	const result = await gitTry("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
	return result.ok ? result.stdout.trim() : null;
}

/**
 * Automation identity for the dogfood merge commits. Fixed so that rebuilding
 * the same base + tips reproduces the same commit OIDs.
 */
const AUTOMATION_NAME = "github-actions[bot]";
const AUTOMATION_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

/** Add the upstream remote when the checkout lacks one; an existing remote is left alone. */
async function ensureRemotes(upstream: string): Promise<void> {
	const remotes = (await git("remote")).split("\n").map(line => line.trim());
	if (!remotes.includes("upstream")) {
		await git("remote", "add", "upstream", `https://github.com/${upstream}.git`);
	}
}

/** Give the checkout a committer identity when the environment lacks one (local runs). */
async function ensureIdentity(): Promise<void> {
	if (!(await gitTry("config", "--get", "user.email")).ok) {
		await git("config", "user.email", AUTOMATION_EMAIL);
	}
	if (!(await gitTry("config", "--get", "user.name")).ok) {
		await git("config", "user.name", AUTOMATION_NAME);
	}
}

async function discoverCandidates(options: Options): Promise<BranchCandidate[]> {
	const pullRequestPages = async (repository: string): Promise<UpstreamPullRequest[]> => {
		const pages = await ghJson<UpstreamPullRequest[][]>([
			"api",
			"--paginate",
			"--slurp",
			`repos/${repository}/pulls?state=open&per_page=100`,
		]);
		return pages.flat();
	};
	const [upstreamPulls, forkPulls] = await Promise.all([
		pullRequestPages(options.upstream),
		pullRequestPages(options.fork),
	]);
	const candidates: BranchCandidate[] = [];
	const seen = new Set<string>();
	const addCandidate = (branch: string, prNumber?: number): void => {
		if (RESERVED_BRANCHES[branch] || seen.has(branch)) return;
		seen.add(branch);
		candidates.push({ branch, prNumber });
	};
	for (const pull of upstreamPulls) {
		if (pull.head.repo?.full_name === options.fork) addCandidate(pull.head.ref, pull.number);
	}
	for (const pull of forkPulls) {
		if (pull.head.repo?.full_name === options.fork) addCandidate(pull.head.ref);
		if (pull.base.repo?.full_name === options.fork) addCandidate(pull.base.ref);
	}
	for (const branch of parsePrivateBranches(process.env.PRIVATE_REBASE_BRANCHES)) addCandidate(branch);
	return candidates;
}

/** Resolve remote heads, drop branches already contained in upstream main, and compute tracked ancestry. */
async function resolveTrackedBranches(
	candidates: readonly BranchCandidate[],
	upstreamMain: string,
): Promise<{ tracked: TrackedBranchInfo[]; missing: string[]; merged: string[] }> {
	const missing: string[] = [];
	const merged: string[] = [];
	const resolved: { candidate: BranchCandidate; head: string }[] = [];
	for (const candidate of candidates) {
		const head = await revParse(`refs/remotes/origin/${candidate.branch}`);
		if (!head) {
			missing.push(candidate.branch);
			continue;
		}
		if ((await gitTry("merge-base", "--is-ancestor", head, upstreamMain)).ok) {
			merged.push(candidate.branch);
			continue;
		}
		resolved.push({ candidate, head });
	}

	// One branch at a time (each fans out to at most `resolved.length` probes),
	// so a large branch set cannot spawn a quadratic number of git processes.
	const tracked: TrackedBranchInfo[] = [];
	for (const { candidate, head } of resolved) {
		const ancestors: string[] = [];
		await Promise.all(
			resolved.map(async other => {
				if (other.candidate.branch === candidate.branch) return;
				// Identical heads are mutual ancestors; keep a single direction so
				// the pair forms a stack (lower name carried) instead of a cycle.
				if (other.head === head) {
					if (other.candidate.branch < candidate.branch) ancestors.push(other.candidate.branch);
					return;
				}
				if ((await gitTry("merge-base", "--is-ancestor", other.head, head)).ok) {
					ancestors.push(other.candidate.branch);
				}
			}),
		);
		tracked.push({ name: candidate.branch, head, ancestors: ancestors.sort(), prNumber: candidate.prNumber });
	}
	return { tracked, missing, merged };
}

interface GroupOutcome {
	group: RebaseGroup;
	ok: boolean;
	/** Rewritten tips, only when the whole group succeeded. */
	tips: IntegrationTip[];
}

async function executeGroup(
	group: RebaseGroup,
	byName: ReadonlyMap<string, TrackedBranchInfo>,
	baseRef: string,
	failures: MaintenanceFailure[],
	notes: string[],
): Promise<GroupOutcome> {
	for (const step of group.steps) {
		const args = ["rebase", "--update-refs"];
		if (step.fromOid) args.push("--onto", step.onto, step.fromOid, step.branch);
		else args.push(step.onto, step.branch);
		const result = await gitTry(...args);
		if (result.ok) continue;

		await gitTry("rebase", "--abort");
		await gitTry("checkout", "--detach", baseRef);
		// `git rebase --abort` restores the refs it moved; restore explicitly too so
		// a partially-applied group never leaves a rewritten local ref behind.
		for (const member of group.members) {
			const original = byName.get(member)?.head;
			if (original) await gitTry("branch", "-f", member, original);
		}
		failures.push({ stage: "rebase", branches: group.members, detail: failureDetail(result) });
		notes.push(`rebase failed for group ${group.members.join(", ")} at ${step.branch}; remote refs unchanged`);
		return { group, ok: false, tips: [] };
	}

	const updates: RefUpdate[] = [];
	for (const member of group.members) {
		const target = await revParse(`refs/heads/${member}`);
		if (!target) continue;
		updates.push({ branch: member, expected: byName.get(member)?.head ?? null, target });
	}
	const plan = planPush(updates);
	if (plan.args.length > 0) {
		const result = await gitTry(...plan.args);
		if (!result.ok) {
			failures.push({ stage: "push", branches: plan.pushed, detail: failureDetail(result) });
			notes.push(`push rejected for ${plan.pushed.join(", ")}`);
			return { group, ok: false, tips: [] };
		}
		notes.push(`pushed ${plan.pushed.join(", ")}`);
	}
	if (plan.skipped.length > 0) notes.push(`already up to date: ${plan.skipped.join(", ")}`);

	const tips = group.steps.map(step => ({ branch: step.branch, prNumber: byName.get(step.branch)?.prNumber }));
	return { group, ok: true, tips };
}

async function rebuildDogfood(
	baseSha: string,
	tips: readonly IntegrationTip[],
	failures: MaintenanceFailure[],
	notes: string[],
): Promise<string | null> {
	await git("checkout", "-B", DOGFOOD_BRANCH, baseSha);
	const merged: string[] = [];
	const failureCountBefore = failures.length;
	for (const tip of orderIntegrationTips(tips)) {
		// Derive the merge commit's dates from the branch being merged, so an
		// unchanged integration rebuilds to the identical OID. That OID is the
		// release trigger: a scheduled run must not force-push a fresh dogfood
		// head (invalidating the `source_sha` an in-flight release is building)
		// or publish a respin when nothing actually moved.
		const date = await git("log", "-1", "--format=%cI", tip.branch);
		const result = await run(
			[
				"git",
				"-c",
				"core.hooksPath=/dev/null",
				"merge",
				"--no-ff",
				"-m",
				`Merge ${tip.branch} into ${DOGFOOD_BRANCH}`,
				tip.branch,
			],
			{
				env: {
					GIT_AUTHOR_NAME: AUTOMATION_NAME,
					GIT_AUTHOR_EMAIL: AUTOMATION_EMAIL,
					GIT_AUTHOR_DATE: date,
					GIT_COMMITTER_NAME: AUTOMATION_NAME,
					GIT_COMMITTER_EMAIL: AUTOMATION_EMAIL,
					GIT_COMMITTER_DATE: date,
				},
			},
		);
		if (result.ok) {
			merged.push(tip.branch);
			continue;
		}
		await gitTry("merge", "--abort");
		failures.push({ stage: "merge", branches: [tip.branch], detail: failureDetail(result) });
	}
	notes.push(merged.length > 0 ? `dogfood integrates ${merged.join(", ")}` : "dogfood has no integrated branches");
	if (failures.length > failureCountBefore) {
		notes.push(`preserved remote ${DOGFOOD_BRANCH}: one or more integration merges failed`);
		return null;
	}

	const target = await revParse(`refs/heads/${DOGFOOD_BRANCH}`);
	if (!target) return null;
	const expected = await revParse(`refs/remotes/origin/${DOGFOOD_BRANCH}`);
	const plan = planPush([{ branch: DOGFOOD_BRANCH, expected, target }]);
	if (plan.args.length === 0) {
		notes.push(`${DOGFOOD_BRANCH} already up to date at ${target}`);
		return target;
	}
	const result = await gitTry(...plan.args);
	if (!result.ok) {
		failures.push({ stage: "push", branches: [DOGFOOD_BRANCH], detail: failureDetail(result) });
		return null;
	}
	notes.push(`pushed ${DOGFOOD_BRANCH} at ${target}`);
	return target;
}

async function findAutomationIssue(fork: string): Promise<IssueSummary | undefined> {
	const issues = await ghJson<IssueSummary[]>([
		"issue",
		"list",
		"--repo",
		fork,
		"--state",
		"all",
		"--limit",
		"100",
		"--json",
		"number,title,state",
	]);
	return issues.find(issue => issue.title === ISSUE_TITLE);
}

async function syncAlertIssue(
	fork: string,
	failures: readonly MaintenanceFailure[],
	runUrl: string | undefined,
	notes: string[],
): Promise<void> {
	const issue = await findAutomationIssue(fork);
	if (failures.length === 0) {
		if (issue && issue.state.toUpperCase() === "OPEN") {
			await requireRun([
				"gh",
				"issue",
				"close",
				String(issue.number),
				"--repo",
				fork,
				"--comment",
				`All tracked branches rebased and integrated cleanly${runUrl ? ` (${runUrl})` : ""}.`,
			]);
			notes.push(`closed alert issue #${issue.number}`);
		}
		return;
	}
	const body = formatIssueBody(failures, runUrl);
	if (!issue) {
		const created = await requireRun(
			["gh", "issue", "create", "--repo", fork, "--title", ISSUE_TITLE, "--body-file", "-"],
			{ input: body },
		);
		notes.push(`opened alert issue: ${created.stdout.trim()}`);
		return;
	}
	await requireRun(["gh", "issue", "edit", String(issue.number), "--repo", fork, "--body-file", "-"], { input: body });
	if (issue.state.toUpperCase() !== "OPEN") {
		await requireRun(["gh", "issue", "reopen", String(issue.number), "--repo", fork]);
	}
	notes.push(`updated alert issue #${issue.number}`);
}

interface ReleaseDecision {
	upstreamTag?: string;
	dogfoodTag?: string;
	dispatched: boolean;
	reason: string;
}

async function maybeDispatchRelease(
	options: Options,
	dogfoodSha: string | null,
	healthy: boolean,
	failures: MaintenanceFailure[],
): Promise<ReleaseDecision> {
	if (!healthy || !dogfoodSha) {
		return { dispatched: false, reason: "integration incomplete; release dispatch skipped" };
	}
	const release = await ghJson<ReleaseSummary>(["api", `repos/${options.upstream}/releases/latest`]);
	const upstreamTag = release.tag_name;
	// Every fork release including drafts, so a revision is never reused, plus
	// the bare `v<version>-dogfood.*` tags: a tag outlives its release, and the
	// release workflow refuses to build over one.
	const releasePages = await ghJson<ForkReleaseSummary[][]>([
		"api",
		"--paginate",
		"--slurp",
		`repos/${options.fork}/releases?per_page=100`,
	]);
	const version = upstreamVersionOf(upstreamTag);
	const tagPages = version
		? await ghJson<{ ref: string }[][]>([
				"api",
				"--paginate",
				"--slurp",
				`repos/${options.fork}/git/matching-refs/tags/v${version}-dogfood.`,
			])
		: [];
	const occupiedTags = tagPages.flat().map(tag => tag.ref.replace("refs/tags/", ""));
	const plan = planDogfoodRelease(upstreamTag, dogfoodSha, releasePages.flat(), occupiedTags);
	if (!plan.publish) return { upstreamTag, dogfoodTag: plan.dogfoodTag, dispatched: false, reason: plan.reason };
	const dogfoodTag = plan.dogfoodTag;
	// A build outlasts a manual re-dispatch, and the run name is tag-scoped, so
	// any in-flight revision of this upstream tag suppresses a second dispatch;
	// the next run picks the respin up once that release lands.
	const runsResponse = await run([
		"gh",
		"api",
		`repos/${options.fork}/actions/workflows/${DOGFOOD_RELEASE_WORKFLOW}/runs?per_page=50`,
	]);
	if (runsResponse.ok) {
		const payload = JSON.parse(runsResponse.stdout) as { workflow_runs?: WorkflowRunSummary[] };
		if (hasActiveDogfoodRun(payload.workflow_runs ?? [], upstreamTag)) {
			return { upstreamTag, dogfoodTag, dispatched: false, reason: `${dogfoodTag} build already in flight` };
		}
	}
	if (options.dryRun) {
		return { upstreamTag, dogfoodTag, dispatched: false, reason: `would dispatch ${dogfoodTag} for ${dogfoodSha}` };
	}
	// `repository_dispatch` always loads the workflow from the trusted default
	// branch; unlike workflow_dispatch, a caller cannot select a feature ref.
	const dispatch = await run([
		"gh",
		"api",
		"--method",
		"POST",
		`repos/${options.fork}/dispatches`,
		"-f",
		"event_type=dogfood-release",
		"-f",
		`client_payload[upstream_tag]=${upstreamTag}`,
		"-f",
		`client_payload[source_sha]=${dogfoodSha}`,
		"-f",
		`client_payload[dogfood_revision]=${plan.revision}`,
	]);
	if (!dispatch.ok) {
		failures.push({ stage: "dispatch", branches: [DOGFOOD_BRANCH], detail: failureDetail(dispatch) });
		return { upstreamTag, dogfoodTag, dispatched: false, reason: "dispatch failed" };
	}
	return { upstreamTag, dogfoodTag, dispatched: true, reason: `dispatched ${dogfoodTag} for ${dogfoodSha}` };
}

function renderSummary(
	groups: readonly RebaseGroup[],
	notes: readonly string[],
	failures: readonly MaintenanceFailure[],
	decision: ReleaseDecision | undefined,
): string {
	const lines = ["## Fork maintenance", "", `Groups planned: ${groups.length}`];
	for (const group of groups) {
		const steps = group.steps
			.map(step => `${step.branch} → ${step.onto}${step.carried.length ? ` (+${step.carried.join(", ")})` : ""}`)
			.join("; ");
		lines.push(`- \`${group.members.join("`, `")}\`: ${steps}`);
	}
	lines.push("", "### Actions");
	for (const note of notes) lines.push(`- ${note}`);
	if (decision) lines.push("", "### Release", `- ${decision.reason}`);
	if (failures.length > 0) {
		lines.push("", "### Failures");
		for (const failure of failures)
			lines.push(`- **${failure.stage}** \`${failure.branches.join("`, `")}\`: ${failure.detail}`);
	}
	return `${lines.join("\n")}\n`;
}

async function emitOutputs(entries: Record<string, string>): Promise<void> {
	const outputFile = process.env.GITHUB_OUTPUT;
	if (!outputFile) return;
	const body = Object.entries(entries)
		.map(([key, value]) => `${key}=${value}\n`)
		.join("");
	await fs.appendFile(outputFile, body);
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const failures: MaintenanceFailure[] = [];
	const notes: string[] = [];
	const runUrl =
		process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
			? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
			: undefined;

	await ensureRemotes(options.upstream);
	if (options.fetch) {
		await git("fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*");
		await git("fetch", "--no-tags", "upstream", `+refs/heads/${MAIN_BRANCH}:refs/remotes/upstream/${MAIN_BRANCH}`);
	}
	const upstreamMain = await git("rev-parse", `refs/remotes/upstream/${MAIN_BRANCH}`);
	const originMain = await revParse(`refs/remotes/origin/${MAIN_BRANCH}`);
	if (!originMain) throw new Error(`fork has no ${MAIN_BRANCH} branch`);

	const candidates = await discoverCandidates(options);
	const { tracked, missing, merged } = await resolveTrackedBranches(candidates, upstreamMain);
	if (missing.length > 0) notes.push(`skipped (no branch on the fork): ${missing.join(", ")}`);
	if (merged.length > 0) notes.push(`skipped (already in upstream main): ${merged.join(", ")}`);
	const boundaryByBranch: Record<string, string> = {};
	await Promise.all(
		tracked.map(async branch => {
			if ((await gitTry("merge-base", "--is-ancestor", originMain, branch.head)).ok) {
				boundaryByBranch[branch.name] = originMain;
				return;
			}
			const cherry = await gitTry("cherry", originMain, branch.head);
			if (!cherry.ok) throw new Error(`could not compare ${branch.name} with fork main: ${failureDetail(cherry)}`);
			const equivalentBoundary = findEquivalentMainBoundary(cherry.stdout);
			if (equivalentBoundary) boundaryByBranch[branch.name] = equivalentBoundary;
		}),
	);
	const byName = new Map(tracked.map(branch => [branch.name, branch]));
	const groups = planRebaseGroups(tracked, `refs/remotes/upstream/${MAIN_BRANCH}`, boundaryByBranch);

	if (options.dryRun) {
		notes.push(`dry run: ${tracked.length} tracked branch(es), ${groups.length} independent group(s)`);
		// No rebuild happens in a dry run, so judge the release against the
		// dogfood head as published — the decision a no-op integration reaches.
		const dogfoodHead = await revParse(`refs/remotes/origin/${DOGFOOD_BRANCH}`);
		const decision = await maybeDispatchRelease(options, dogfoodHead, true, failures);
		const summary = renderSummary(groups, notes, failures, decision);
		console.log(summary);
		return;
	}

	await ensureIdentity();
	await git("checkout", "--detach", upstreamMain);
	await git("branch", "-f", MAIN_BRANCH, originMain);
	for (const branch of tracked) await git("branch", "-f", branch.name, branch.head);

	// Fork main first: it is the dogfood base. Candidate branch deltas stay
	// rooted on upstream main so fork-private maintenance commits never leak
	// into upstream pull requests.
	const upstreamIsAncestor = (await gitTry("merge-base", "--is-ancestor", upstreamMain, originMain)).ok;
	let mainSha: string | null = upstreamIsAncestor ? originMain : null;
	if (upstreamIsAncestor) {
		notes.push(`${MAIN_BRANCH} already integrates upstream at ${mainSha}`);
	} else {
		const mainRebase = await gitTry("rebase", `refs/remotes/upstream/${MAIN_BRANCH}`, MAIN_BRANCH);
		if (mainRebase.ok) {
			mainSha = await revParse(`refs/heads/${MAIN_BRANCH}`);
			const plan = planPush([{ branch: MAIN_BRANCH, expected: originMain, target: mainSha ?? originMain }]);
			if (plan.args.length > 0) {
				const pushed = await gitTry(...plan.args);
				if (pushed.ok) notes.push(`pushed ${MAIN_BRANCH} at ${mainSha}`);
				else {
					failures.push({ stage: "push", branches: [MAIN_BRANCH], detail: failureDetail(pushed) });
					mainSha = null;
				}
			} else {
				notes.push(`${MAIN_BRANCH} already up to date`);
			}
		} else {
			await gitTry("rebase", "--abort");
			await gitTry("checkout", "--detach", upstreamMain);
			await gitTry("branch", "-f", MAIN_BRANCH, originMain);
			failures.push({ stage: "rebase", branches: [MAIN_BRANCH], detail: failureDetail(mainRebase) });
		}
	}

	const tips: IntegrationTip[] = [];
	for (const group of groups) {
		const outcome = await executeGroup(group, byName, upstreamMain, failures, notes);
		if (outcome.ok) tips.push(...outcome.tips);
	}

	let dogfoodSha: string | null = null;
	if (!mainSha) {
		notes.push(`skipped ${DOGFOOD_BRANCH} rebuild: ${MAIN_BRANCH} is not in a known-good state`);
	} else if (failures.length > 0) {
		notes.push(`preserved remote ${DOGFOOD_BRANCH}: one or more branch groups failed`);
	} else {
		dogfoodSha = await rebuildDogfood(mainSha, tips, failures, notes);
	}

	const healthy = failures.length === 0;
	const decision = await maybeDispatchRelease(options, dogfoodSha, healthy, failures);
	notes.push(decision.reason);
	await syncAlertIssue(options.fork, failures, runUrl, notes);

	const summary = renderSummary(groups, notes, failures, decision);
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
	await emitOutputs({
		"dogfood-sha": dogfoodSha ?? "",
		"dogfood-tag": decision.dogfoodTag ?? "",
		dispatched: String(decision.dispatched),
		failures: String(failures.length),
	});

	if (failures.length > 0) {
		console.error(`fork maintenance finished with ${failures.length} failure(s)`);
		process.exit(1);
	}
}

if (import.meta.main) {
	await main();
}
