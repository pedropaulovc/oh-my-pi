#!/usr/bin/env bun

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import evalPrompt from "../src/prompts/evals/async-progress-wake.md" with { type: "text" };
import { AgentRegistry, createAgentSession, Settings } from "../src/sdk";
import type { AgentSessionEvent } from "../src/session/agent-session-events";
import { ASYNC_PROGRESS_MESSAGE_TYPE, ASYNC_RESULT_MESSAGE_TYPE } from "../src/session/async-job-delivery";
import { SessionManager } from "../src/session/session-manager";

const DEFAULT_RUNS = 1;
const DEFAULT_TIMEOUT_MS = 90_000;
const READY_EVENT = "MONITOR_READY";
const ACKNOWLEDGEMENT = "WAKE_ACK MONITOR_READY";

interface EvalConfig {
	model?: string;
	runs: number;
	timeoutMs: number;
	json: boolean;
}

interface BashCall {
	command?: string;
	async?: boolean;
	progress?: string;
}

interface EvalCriteria {
	selectedWake: boolean;
	singleBashCall: boolean;
	notificationDelivered: boolean;
	notificationBeforeCompletion: boolean;
	acknowledgedAfterNotification: boolean;
}

interface EvalRunResult {
	run: number;
	model: string;
	passed: boolean;
	criteria: EvalCriteria;
	bashCalls: BashCall[];
	assistantMessages: string[];
	error?: string;
}

function parsePositiveInteger(flag: string, value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
	return parsed;
}

function parseArgs(argv: string[]): EvalConfig {
	const valueFor = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index === -1 ? undefined : argv[index + 1];
	};
	return {
		model: valueFor("--model"),
		runs: parsePositiveInteger("--runs", valueFor("--runs"), DEFAULT_RUNS),
		timeoutMs: parsePositiveInteger("--timeout-ms", valueFor("--timeout-ms"), DEFAULT_TIMEOUT_MS),
		json: argv.includes("--json"),
	};
}

function parseBashCall(value: unknown): BashCall {
	if (!isRecord(value)) return {};
	return {
		command: typeof value.command === "string" ? value.command : undefined,
		async: typeof value.async === "boolean" ? value.async : undefined,
		progress: typeof value.progress === "string" ? value.progress : undefined,
	};
}

function messageText(message: unknown): string {
	if (!isRecord(message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map(block => {
			if (!isRecord(block)) return "";
			if (block.type === "text" && typeof block.text === "string") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function isProgressMessage(message: AgentMessage): boolean {
	return isRecord(message) && message.role === "custom" && message.customType === ASYNC_PROGRESS_MESSAGE_TYPE;
}

function isCompletionMessage(message: AgentMessage): boolean {
	return isRecord(message) && message.role === "custom" && message.customType === ASYNC_RESULT_MESSAGE_TYPE;
}

function scoreMessages(messages: AgentMessage[], bashCalls: BashCall[]): EvalCriteria {
	const progressIndex = messages.findIndex(
		message => isProgressMessage(message) && messageText(message).includes(READY_EVENT),
	);
	const completionIndex = messages.findIndex(isCompletionMessage);
	const acknowledgementIndex = messages.findIndex(
		(message, index) =>
			index > progressIndex && message.role === "assistant" && messageText(message).includes(ACKNOWLEDGEMENT),
	);
	return {
		selectedWake: bashCalls.some(call => call.async === true && call.progress === "wake"),
		singleBashCall: bashCalls.length === 1,
		notificationDelivered: progressIndex >= 0,
		notificationBeforeCompletion: progressIndex >= 0 && (completionIndex < 0 || progressIndex < completionIndex),
		acknowledgedAfterNotification: progressIndex >= 0 && acknowledgementIndex > progressIndex,
	};
}

function criteriaPass(criteria: EvalCriteria): boolean {
	return Object.values(criteria).every(Boolean);
}

async function runOnce(config: EvalConfig, run: number): Promise<EvalRunResult> {
	const cwd = process.cwd();
	const deadline = Date.now() + config.timeoutMs;
	const settings = await Settings.loadReadOnly({ cwd });
	settings.override("async.enabled", true);
	settings.override("bash.autoBackground.enabled", false);
	settings.override("tools.approvalMode", "yolo");

	const { session } = await createAgentSession({
		cwd,
		settings,
		modelPattern: config.model,
		agentRegistry: new AgentRegistry(),
		sessionManager: SessionManager.inMemory(cwd),
		toolNames: ["bash"],
		restrictToolNames: true,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		autoApprove: true,
		deadline,
	});
	const bashCalls: BashCall[] = [];
	const assistantMessages: string[] = [];
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "tool_execution_start" && event.toolName === "bash") {
			bashCalls.push(parseBashCall(event.args));
		}
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		const text = messageText(event.message);
		if (text) assistantMessages.push(text);
	});

	let error: string | undefined;
	try {
		await session.prompt(evalPrompt.trim(), { expandPromptTemplates: false });
		while (Date.now() < deadline) {
			if (criteriaPass(scoreMessages(session.messages, bashCalls))) break;
			await Bun.sleep(100);
		}
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
	}

	const criteria = scoreMessages(session.messages, bashCalls);
	const model = session.model ? `${session.model.provider}/${session.model.id}` : (config.model ?? "unresolved");
	unsubscribe();
	await session.dispose();
	return {
		run,
		model,
		passed: !error && criteriaPass(criteria),
		criteria,
		bashCalls,
		assistantMessages,
		...(error ? { error } : {}),
	};
}

function printRun(result: EvalRunResult): void {
	process.stdout.write(`run ${result.run} — ${result.model}: ${result.passed ? "PASS" : "FAIL"}\n`);
	for (const [criterion, passed] of Object.entries(result.criteria)) {
		process.stdout.write(`  ${passed ? "✓" : "✗"} ${criterion}\n`);
	}
	process.stdout.write(`  bash calls: ${JSON.stringify(result.bashCalls)}\n`);
	if (!result.passed) process.stdout.write(`  assistant messages: ${JSON.stringify(result.assistantMessages)}\n`);
	if (result.error) process.stdout.write(`  error: ${result.error}\n`);
}

async function main(): Promise<void> {
	const config = parseArgs(Bun.argv.slice(2));
	const results: EvalRunResult[] = [];
	for (let run = 1; run <= config.runs; run += 1) {
		results.push(await runOnce(config, run));
	}
	const passed = results.filter(result => result.passed).length;
	if (config.json) {
		process.stdout.write(`${JSON.stringify({ passed, runs: config.runs, results }, null, 2)}\n`);
	} else {
		for (const result of results) printRun(result);
		process.stdout.write(`summary: ${passed}/${config.runs} runs passed\n`);
	}
	if (passed !== config.runs) process.exitCode = 1;
}

await main();
