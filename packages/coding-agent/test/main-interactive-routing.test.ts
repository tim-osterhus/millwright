import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { mergeAgentSessionRuntimeConfig } from "../src/core/agent-session-config.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk.js";
import {
	type AppMode,
	createSessionManager,
	type DaemonInteractiveSessionManagerDecision,
	daemonServerDefaultSessionConfig,
	findActiveDaemonSessionSummaryForInteractiveStartup,
	findActiveDaemonSessionSummaryForSessionFile,
	type InteractiveDaemonStartupDecision,
	main,
	parseAgentsViewCommand,
	resolveRuntimeSessionOptions,
	shouldEnsureDaemonBeforeActiveSessionLookup,
	shouldEnsureInteractiveDaemonForStartup,
	shouldOpenAgentsViewForDaemonInteractive,
	shouldRejectNonInteractiveAttach,
	shouldRejectNonInteractiveBareResume,
	shouldUseDaemonClient,
	shouldUseDaemonClientRuntime,
	shouldUseDaemonInteractive,
	shouldUseEphemeralSessionManagerForDaemonInteractive,
} from "../src/main.js";
import type { SessionSummary } from "../src/modes/index.js";

type UnsafeStatePathCase = { name: string; value: string };

function createUnsafeStatePathMatrix(root: string): UnsafeStatePathCase[] {
	const primeRoot = join(root, ".prime");
	const millraceCliRoot = join(root, ".millrace-cli");
	const safeRoot = join(root, "safe");
	mkdirSync(primeRoot, { recursive: true });
	mkdirSync(millraceCliRoot, { recursive: true });
	mkdirSync(safeRoot, { recursive: true });
	writeFileSync(join(primeRoot, "sentinel.txt"), "prime-sentinel");
	writeFileSync(join(millraceCliRoot, "sentinel.txt"), "millrace-cli-sentinel");
	symlinkSync(primeRoot, join(safeRoot, "prime-link"), "dir");
	symlinkSync(millraceCliRoot, join(safeRoot, "millrace-cli-link"), "dir");
	symlinkSync(join(primeRoot, "missing-target"), join(safeRoot, "dangling-prime-link"), "dir");
	symlinkSync(join(millraceCliRoot, "missing-target"), join(safeRoot, "dangling-millrace-cli-link"), "dir");
	return [
		{ name: "relative", value: join("relative", "session.jsonl") },
		{ name: "exact .prime", value: primeRoot },
		{ name: ".prime descendant", value: join(primeRoot, "descendant", "session.jsonl") },
		{ name: "exact .millrace-cli", value: millraceCliRoot },
		{ name: ".millrace-cli descendant", value: join(millraceCliRoot, "descendant", "session.jsonl") },
		{ name: "existing symlink to .prime", value: join(safeRoot, "prime-link", "descendant", "session.jsonl") },
		{
			name: "existing symlink to .millrace-cli",
			value: join(safeRoot, "millrace-cli-link", "descendant", "session.jsonl"),
		},
		{
			name: "dangling symlink to .prime",
			value: join(safeRoot, "dangling-prime-link", "descendant", "session.jsonl"),
		},
		{
			name: "dangling symlink to .millrace-cli",
			value: join(safeRoot, "dangling-millrace-cli-link", "descendant", "session.jsonl"),
		},
	];
}

describe("interactive startup routing", () => {
	test.each(["interactive", "print", "json", "rpc"] as const)(
		"uses the daemon runtime for the %s client",
		(appMode) => {
			expect(
				shouldUseDaemonClient({
					appMode,
					startupBenchmark: false,
				}),
			).toBe(true);
		},
	);

	test("uses a client-owned daemon session for --no-session", () => {
		expect(
			shouldUseDaemonClient({
				appMode: "interactive",
				startupBenchmark: false,
				noSession: true,
			}),
		).toBe(true);
	});

	test("keeps process-local extension factories and rollback workers in process", () => {
		expect(
			shouldUseDaemonClientRuntime({
				appMode: "print",
				startupBenchmark: false,
				hasProcessLocalExtensionFactories: true,
			}),
		).toBe(false);
		expect(
			shouldUseDaemonClientRuntime({
				appMode: "rpc",
				startupBenchmark: false,
				ownedSessionWorker: true,
			}),
		).toBe(false);
	});

	test.each([
		["daemon process", { appMode: "daemon", startupBenchmark: false }],
		["startup benchmark", { appMode: "interactive", startupBenchmark: true }],
		["help", { appMode: "interactive", startupBenchmark: false, help: true }],
		["model listing", { appMode: "interactive", startupBenchmark: false, listModels: true }],
	] satisfies Array<[string, InteractiveDaemonStartupDecision]>)(
		"keeps %s out of daemon client routing",
		(_label, decision) => {
			expect(shouldUseDaemonClient(decision)).toBe(false);
		},
	);

	test("uses daemon-backed interactive mode for normal interactive startup", () => {
		expect(
			shouldUseDaemonInteractive({
				appMode: "interactive",
				startupBenchmark: false,
			}),
		).toBe(true);
	});

	const nonInteractiveModes: Array<[AppMode, string]> = [
		["print", "print mode"],
		["json", "json mode"],
		["rpc", "rpc mode"],
		["daemon", "daemon mode"],
	];

	test.each(nonInteractiveModes)("does not use daemon-backed interactive mode for %s", (appMode) => {
		expect(
			shouldUseDaemonInteractive({
				appMode,
				startupBenchmark: false,
			}),
		).toBe(false);
	});

	type InteractiveFallbackOverrides = Partial<
		Pick<InteractiveDaemonStartupDecision, "startupBenchmark" | "noSession" | "listModels">
	>;

	const fallbackCases: Array<[string, InteractiveFallbackOverrides]> = [
		["startup benchmark", { startupBenchmark: true }],
		["--no-session", { noSession: true }],
		["--list-models", { listModels: true }],
		["--list-models search", { listModels: "claude" }],
	];

	test.each(fallbackCases)("keeps %s on the non-daemon interactive path", (_label, overrides) => {
		expect(
			shouldUseDaemonInteractive({
				appMode: "interactive",
				startupBenchmark: false,
				...overrides,
			}),
		).toBe(false);
	});

	test("rejects interactive-only selectors before non-interactive startup", () => {
		expect(shouldRejectNonInteractiveAttach("worker", "print")).toBe(true);
		expect(shouldRejectNonInteractiveAttach("worker", "interactive")).toBe(false);
		expect(shouldRejectNonInteractiveAttach(undefined, "print")).toBe(false);
		expect(shouldRejectNonInteractiveBareResume(true, "print")).toBe(true);
		expect(shouldRejectNonInteractiveBareResume(true, "rpc")).toBe(true);
		expect(shouldRejectNonInteractiveBareResume("session-id", "print")).toBe(false);
		expect(shouldRejectNonInteractiveBareResume(true, "interactive")).toBe(false);
	});

	test("does not start the daemon for attach", () => {
		expect(shouldEnsureInteractiveDaemonForStartup(true, undefined)).toBe(true);
		expect(shouldEnsureInteractiveDaemonForStartup(true, "worker")).toBe(false);
		expect(shouldEnsureInteractiveDaemonForStartup(false, undefined)).toBe(false);
	});
});

describe("interactive session path safety", () => {
	test("resolves a safe relative resume and fork selector before opening it", async () => {
		const root = mkdtempSync(join(tmpdir(), "millwright-interactive-relative-path-"));
		try {
			const matrix = createUnsafeStatePathMatrix(root);
			const relativeSelector = matrix.find(({ name }) => name === "relative")!.value;
			const source = join(root, relativeSelector);
			mkdirSync(join(root, "relative"), { recursive: true });
			const sentinel = JSON.stringify({
				type: "session",
				id: "relative",
				timestamp: new Date(0).toISOString(),
				cwd: root,
			});
			writeFileSync(source, `${sentinel}\n`);

			const resumed = await createSessionManager(
				parseArgs(["--resume", relativeSelector]),
				root,
				join(root, "resume-sessions"),
			);
			expect(resumed.getSessionFile()).toBe(source);

			const forked = await createSessionManager(
				parseArgs(["--fork", relativeSelector]),
				root,
				join(root, "fork-sessions"),
			);
			expect(dirname(forked.getSessionFile()!)).toBe(join(root, "fork-sessions"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects every unsafe resolved resume and fork target before session access", async () => {
		const root = mkdtempSync(join(tmpdir(), "millwright-interactive-unsafe-path-"));
		try {
			const matrix = createUnsafeStatePathMatrix(root).filter(({ name }) => name !== "relative");
			for (const flag of ["--resume", "--fork"] as const) {
				for (const { name, value } of matrix) {
					await expect(
						createSessionManager(parseArgs([flag, value]), root, join(root, "safe-sessions")),
						`${flag} ${name}`,
					).rejects.toThrow(/legacy|unsafe|resolve/i);
					expect(readFileSync(join(root, ".prime", "sentinel.txt"), "utf8")).toBe("prime-sentinel");
					expect(readFileSync(join(root, ".millrace-cli", "sentinel.txt"), "utf8")).toBe("millrace-cli-sentinel");
				}
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("validates ordinary CLI --session-dir before session discovery or access", async () => {
		const root = mkdtempSync(join(tmpdir(), "millwright-main-session-dir-"));
		const envNames = [
			"HOME",
			"MILLWRIGHT_CODING_AGENT_DIR",
			"MILLWRIGHT_SESSION_DIR",
			"MILLWRIGHT_CODING_AGENT_SESSION_DIR",
			"MILLWRIGHT_OFFLINE",
			"MILLWRIGHT_SKIP_VERSION_CHECK",
		] as const;
		const previous = new Map(envNames.map((name) => [name, process.env[name]]));
		const runMainUntilListExit = async (sessionDir: string): Promise<void> => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
				throw new Error(`main test exit ${code ?? ""}`);
			}) as never);
			try {
				await expect(
					main([
						"--mode",
						"text",
						"--offline",
						"--no-session",
						"--no-tools",
						"--no-extensions",
						"--no-skills",
						"--list-models",
						"--session-dir",
						sessionDir,
					]),
				).rejects.toThrow("main test exit");
			} finally {
				exitSpy.mockRestore();
			}
		};
		try {
			for (const name of envNames) delete process.env[name];
			process.env.HOME = root;
			process.env.MILLWRIGHT_CODING_AGENT_DIR = join(root, "agent");
			const matrix = createUnsafeStatePathMatrix(root);
			await runMainUntilListExit(join(root, "safe-session-dir", "nested"));
			await runMainUntilListExit("~/tilde-session-dir");
			for (const { name, value } of matrix) {
				await expect(
					main([
						"--mode",
						"text",
						"--offline",
						"--no-session",
						"--no-tools",
						"--no-extensions",
						"--no-skills",
						"--session-dir",
						value,
					]),
					`${name} --session-dir`,
				).rejects.toThrow(/absolute|legacy|unsafe|resolve/i);
				expect(readFileSync(join(root, ".prime", "sentinel.txt"), "utf8")).toBe("prime-sentinel");
				expect(readFileSync(join(root, ".millrace-cli", "sentinel.txt"), "utf8")).toBe("millrace-cli-sentinel");
			}
		} finally {
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("daemon-backed interactive session manager routing", () => {
	test("opens a new chat (not the agents view) for default daemon-backed interactive startup", () => {
		expect(
			shouldOpenAgentsViewForDaemonInteractive({
				useDaemonInteractive: true,
				needsOnboarding: false,
			}),
		).toBe(false);
	});

	test("opens the agents view when explicitly requested", () => {
		expect(
			shouldOpenAgentsViewForDaemonInteractive({
				useDaemonInteractive: true,
				needsOnboarding: false,
				explicitAgentsView: true,
			}),
		).toBe(true);
	});

	const directAttachCases: Array<[string, Parameters<typeof shouldOpenAgentsViewForDaemonInteractive>[0]]> = [
		[
			"non-daemon interactive path",
			{ useDaemonInteractive: false, needsOnboarding: false, explicitAgentsView: true },
		],
		["pending onboarding", { useDaemonInteractive: true, needsOnboarding: true, explicitAgentsView: true }],
		[
			"resume selector",
			{ useDaemonInteractive: true, needsOnboarding: false, explicitAgentsView: true, resume: "active-1" },
		],
		[
			"continue recent",
			{ useDaemonInteractive: true, needsOnboarding: false, explicitAgentsView: true, continue: true },
		],
		[
			"fork",
			{ useDaemonInteractive: true, needsOnboarding: false, explicitAgentsView: true, fork: "source-session-id" },
		],
	];

	test.each(directAttachCases)("does not open agents view for %s", (_label, decision) => {
		expect(shouldOpenAgentsViewForDaemonInteractive(decision)).toBe(false);
	});

	test.each([false, true])("opens the agents view for bare --resume (onboarding=%s)", (needsOnboarding) => {
		expect(
			shouldOpenAgentsViewForDaemonInteractive({
				useDaemonInteractive: true,
				needsOnboarding,
				resume: true,
			}),
		).toBe(true);
	});

	test("ensures daemon is available before probing non-path session selectors", () => {
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: true,
				resumeSelector: "active-1",
			}),
		).toBe(true);
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: true,
				resumeSelector: "/tmp/session.jsonl",
			}),
		).toBe(false);
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: true,
				resumeSelector: "/tmp/session.jsonl",
				explicitAttach: true,
			}),
		).toBe(true);
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: false,
				resumeSelector: "active-1",
			}),
		).toBe(false);
	});

	test("falls back to local session lookup when daemon active-session probing fails", async () => {
		await expect(
			findActiveDaemonSessionSummaryForInteractiveStartup("/tmp/prime.sock", "saved-session-id", {
				lookup: async () => {
					throw new Error("Daemon returned an invalid active session summary");
				},
			}),
		).resolves.toBeUndefined();
	});

	test("propagates active-session lookup failures for explicit attach", async () => {
		await expect(
			findActiveDaemonSessionSummaryForInteractiveStartup("/tmp/prime.sock", "active-1", {
				fallbackOnError: false,
				lookup: async () => {
					throw new Error("protocol mismatch");
				},
			}),
		).rejects.toThrow("protocol mismatch");
	});

	test("uses daemon active-session summary when probing succeeds", async () => {
		await expect(
			findActiveDaemonSessionSummaryForInteractiveStartup("/tmp/prime.sock", "active-1", {
				lookup: async () => ({
					id: "active-1",
					activeSessionId: "active-1",
					lifecycle: "draft",
					activity: "idle",
					isSessionActive: false,
					sessionId: "session-1",
					cwd: "/tmp/project",
					isStreaming: false,
					isCompacting: false,
					attachedClients: 0,
					messageCount: 0,
					sessionActions: { queuedCount: 0, steering: [], followUps: [] },
				}),
			}),
		).resolves.toMatchObject({ activeSessionId: "active-1" });
	});

	test("uses an ephemeral local session manager for fresh daemon-owned sessions", () => {
		expect(shouldUseEphemeralSessionManagerForDaemonInteractive({})).toBe(true);
	});

	const persistentSelectionCases: Array<[string, DaemonInteractiveSessionManagerDecision]> = [
		["active daemon attach", { hasActiveDaemonSession: true }],
		["explicit saved session", { resume: "saved-session-id" }],
		["continue recent", { continue: true }],
		["fork", { fork: "source-session-id" }],
	];

	test.each(persistentSelectionCases)("keeps %s on a concrete local session manager", (_label, decision) => {
		expect(shouldUseEphemeralSessionManagerForDaemonInteractive(decision)).toBe(false);
	});

	test("uses an ephemeral local session manager for bare --resume", () => {
		expect(shouldUseEphemeralSessionManagerForDaemonInteractive({ resume: true })).toBe(true);
	});

	test("finds an active daemon session by resolved session file", () => {
		const inactiveSummary = makeSessionSummary({
			id: "saved-1",
			activeSessionId: undefined,
			sessionFile: "/tmp/project/session.jsonl",
		});
		const activeSummary = makeSessionSummary({
			id: "active-1",
			activeSessionId: "active-1",
			sessionFile: "/tmp/project/session.jsonl",
		});

		expect(
			findActiveDaemonSessionSummaryForSessionFile(
				[inactiveSummary, activeSummary],
				"/tmp/project/../project/session.jsonl",
			),
		).toBe(activeSummary);
	});

	test("finds an active daemon session through a symlinked resume path", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-agent-resume-"));
		try {
			const sessionFile = join(directory, "session.jsonl");
			const symlink = join(directory, "session-link.jsonl");
			writeFileSync(sessionFile, "");
			symlinkSync(sessionFile, symlink);
			const activeSummary = makeSessionSummary({
				id: "active-1",
				activeSessionId: "active-1",
				sessionFile,
			});

			expect(findActiveDaemonSessionSummaryForSessionFile([activeSummary], symlink)).toBe(activeSummary);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("agents view command parsing", () => {
	test("routes the agents verb to the agents view and strips it", () => {
		expect(parseAgentsViewCommand(["agents"])).toEqual({ explicitAgentsView: true, args: [] });
	});

	test("does not treat manage as an alias", () => {
		expect(parseAgentsViewCommand(["manage", "--verbose"])).toEqual({
			explicitAgentsView: false,
			args: ["manage", "--verbose"],
		});
	});

	test("leaves a normal message untouched", () => {
		expect(parseAgentsViewCommand(["fix the agents view"])).toEqual({
			explicitAgentsView: false,
			args: ["fix the agents view"],
		});
	});

	test("only matches the verb as the first token", () => {
		expect(parseAgentsViewCommand(["--verbose", "agents"])).toEqual({
			explicitAgentsView: false,
			args: ["--verbose", "agents"],
		});
	});
});

describe("runtime session option resolution", () => {
	test("keeps verifier goals per session instead of in the daemon fallback", () => {
		const headlessCreateConfig = {
			cwd: "/repo",
			serializedRefine: true,
			initialGoal: { objective: "solve the verifier task", tokenBudget: 100_000 },
		};

		expect(headlessCreateConfig.initialGoal).toEqual({
			objective: "solve the verifier task",
			tokenBudget: 100_000,
		});
		const daemonFallback = daemonServerDefaultSessionConfig(headlessCreateConfig);
		expect(daemonFallback).toEqual({
			cwd: "/repo",
			serializedRefine: true,
			initialGoal: undefined,
		});
		expect(
			mergeAgentSessionRuntimeConfig(daemonFallback, {
				initialGoal: headlessCreateConfig.initialGoal,
			}),
		).toMatchObject({ initialGoal: headlessCreateConfig.initialGoal });
	});

	test("preserves daemon-provided RLM heartbeat controller when creating sessions", () => {
		const preparedModel = { id: "prepared-model" } as unknown as CreateAgentSessionOptions["model"];
		const runtimeModel = { id: "runtime-model" } as unknown as CreateAgentSessionOptions["model"];
		const rlmHeartbeatController: NonNullable<CreateAgentSessionOptions["rlmHeartbeatController"]> = {
			listRlmHeartbeats: () => [],
			createRlmHeartbeat: () => {
				throw new Error("not used");
			},
			updateRlmHeartbeat: () => undefined,
			deleteRlmHeartbeat: () => undefined,
		};

		const resolved = resolveRuntimeSessionOptions(
			{
				model: preparedModel,
				tools: ["ipython"],
				customTools: [],
			},
			{
				model: runtimeModel,
				rlmHeartbeatController,
				rlmDepth: 1,
				rlmSessionDir: "/tmp/rlm-session",
			},
		);

		expect(resolved).toMatchObject({
			model: runtimeModel,
			tools: ["ipython"],
			customTools: [],
			rlmHeartbeatController,
			rlmDepth: 1,
			rlmSessionDir: "/tmp/rlm-session",
		});
	});

	test("preserves the runtime child parent-agent identity", () => {
		const resolved = resolveRuntimeSessionOptions({}, { rlmDepth: 1, rlmParentAgent: "parent-worker" });

		expect(resolved.rlmParentAgent).toBe("parent-worker");
	});

	test("deep-merges autonomous runtime session overrides", () => {
		const resolved = resolveRuntimeSessionOptions(
			{
				autonomous: {
					enabled: true,
					maxTurns: 20,
					gates: { commands: ["npm test"], maxRetries: 3 },
				},
			},
			{
				autonomous: {
					maxContinuations: 5,
					gates: { timeoutMs: 1000 },
				},
			},
		);

		expect(resolved.autonomous).toEqual({
			enabled: true,
			maxTurns: 20,
			maxContinuations: 5,
			gates: { commands: ["npm test"], maxRetries: 3, timeoutMs: 1000 },
		});
	});

	test("disables autonomous mode for subagent runtime sessions", () => {
		const resolved = resolveRuntimeSessionOptions(
			{
				autonomous: {
					enabled: true,
					maxTurns: 20,
					gates: { commands: ["npm test"], maxRetries: 3 },
				},
			},
			{
				rlmDepth: 1,
				autonomous: {
					maxContinuations: 5,
					gates: { timeoutMs: 1000 },
				},
			},
		);

		expect(resolved.autonomous).toEqual({
			enabled: false,
			maxTurns: 20,
			maxContinuations: 5,
			gates: { commands: ["npm test"], maxRetries: 3, timeoutMs: 1000 },
		});
	});
});

function makeSessionSummary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "session-1",
		lifecycle: "draft",
		activity: "idle",
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
		isSessionActive: overrides.isSessionActive ?? false,
	};
}
