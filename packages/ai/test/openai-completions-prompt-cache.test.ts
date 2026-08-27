import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Model } from "../src/types.js";

interface FakeOpenAIClientOptions {
	apiKey: string;
	baseURL: string;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders?: Record<string, string>;
}

interface CapturedCompletionsPayload {
	prompt_cache_key?: string;
	prompt_cache_retention?: "24h" | "in-memory" | null;
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedCompletionsPayload | undefined,
	lastClientOptions: undefined as FakeOpenAIClientOptions | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedCompletionsPayload) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};

		constructor(options: FakeOpenAIClientOptions) {
			mockState.lastClientOptions = options;
		}
	}

	return { default: FakeOpenAI };
});

describe("openai-completions prompt caching", () => {
	const originalEnv = new Map(
		["HOME", "MILLWRIGHT_CACHE_RETENTION", "MILLWRIGHT_CODING_AGENT_DIR", "PI_CACHE_RETENTION", "PRIME_TEAM_ID"].map(
			(name) => [name, process.env[name]],
		),
	);
	const temporaryRoots: string[] = [];

	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.lastClientOptions = undefined;
		delete process.env.PI_CACHE_RETENTION;
		delete process.env.MILLWRIGHT_CACHE_RETENTION;
		delete process.env.MILLWRIGHT_CODING_AGENT_DIR;
		delete process.env.PRIME_TEAM_ID;
	});

	afterEach(() => {
		for (const [name, value] of originalEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function createModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		return {
			...(baseModel as Omit<Model<"openai-completions">, "api">),
			api: "openai-completions",
			...overrides,
		};
	}

	async function captureRequest(
		options?: {
			cacheRetention?: "none" | "short" | "long";
			sessionId?: string;
			headers?: Record<string, string>;
		},
		model: Model<"openai-completions"> = createModel(),
	) {
		await streamOpenAICompletions(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key", ...options },
		).result();

		return {
			payload: mockState.lastParams,
			headers: mockState.lastClientOptions?.defaultHeaders ?? {},
		};
	}

	it("sets prompt_cache_key for direct OpenAI requests when caching is enabled", async () => {
		const { payload } = await captureRequest({ sessionId: "session-123" });

		expect(payload?.prompt_cache_key).toBe("session-123");
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("sets prompt_cache_retention to 24h for direct OpenAI requests when cacheRetention is long", async () => {
		const { payload } = await captureRequest({ cacheRetention: "long", sessionId: "session-456" });

		expect(payload?.prompt_cache_key).toBe("session-456");
		expect(payload?.prompt_cache_retention).toBe("24h");
	});

	it("omits prompt cache fields when cacheRetention is none", async () => {
		const { payload } = await captureRequest({ cacheRetention: "none", sessionId: "session-789" });

		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("omits prompt cache fields for non-OpenAI base URLs without compatible long retention", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { supportsLongCacheRetention: false },
		});
		const { payload } = await captureRequest({ cacheRetention: "long", sessionId: "session-proxy" }, model);

		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("ignores the inherited PI_CACHE_RETENTION alias", async () => {
		process.env.PI_CACHE_RETENTION = "long";
		const { payload } = await captureRequest({ sessionId: "session-env" });

		expect(payload?.prompt_cache_key).toBe("session-env");
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("uses MILLWRIGHT_CACHE_RETENTION for direct OpenAI requests", async () => {
		process.env.MILLWRIGHT_CACHE_RETENTION = "long";
		const { payload } = await captureRequest({ sessionId: "session-env" });

		expect(payload?.prompt_cache_key).toBe("session-env");
		expect(payload?.prompt_cache_retention).toBe("24h");
	});

	it("sources Prime team fallback only from the Millwright state root", async () => {
		const root = mkdtempSync(join(tmpdir(), "millwright-prime-team-"));
		temporaryRoots.push(root);
		const agentDir = join(root, "explicit-agent");
		const legacyHome = join(root, "legacy-home");
		mkdirSync(join(agentDir, "providers", "prime"), { recursive: true });
		mkdirSync(join(legacyHome, ".prime"), { recursive: true });
		writeFileSync(join(agentDir, "providers", "prime", "config.json"), '{"team_id":"millwright-team"}\n');
		writeFileSync(join(legacyHome, ".prime", "config.json"), '{"team_id":"legacy-team"}\n');
		process.env.HOME = legacyHome;
		process.env.MILLWRIGHT_CODING_AGENT_DIR = agentDir;

		const model = createModel({ provider: "prime-inference", baseUrl: "https://api.pinference.test/v1" });
		const { headers } = await captureRequest(undefined, model);

		expect(headers["X-Prime-Team-ID"]).toBe("millwright-team");
	});

	it("rejects unsafe Millwright state overrides before reading Prime team fallback", async () => {
		const root = mkdtempSync(join(tmpdir(), "millwright-prime-team-unsafe-"));
		temporaryRoots.push(root);
		const legacyDir = join(root, ".prime");
		mkdirSync(join(legacyDir, "providers", "prime"), { recursive: true });
		writeFileSync(join(legacyDir, "providers", "prime", "config.json"), '{"team_id":"legacy-team"}\n');
		process.env.MILLWRIGHT_CODING_AGENT_DIR = legacyDir;

		const model = createModel({ provider: "prime-inference", baseUrl: "https://api.pinference.test/v1" });
		const { headers } = await captureRequest(undefined, model);

		expect(headers["X-Prime-Team-ID"]).toBeUndefined();
	});

	it("sends known session-affinity headers when compat.sendSessionAffinityHeaders is enabled", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionAffinityHeaders: true },
		});
		const { headers } = await captureRequest({ sessionId: "session-affinity" }, model);

		expect(headers.session_id).toBe("session-affinity");
		expect(headers["x-client-request-id"]).toBe("session-affinity");
		expect(headers["x-session-affinity"]).toBe("session-affinity");
	});

	it("omits session-affinity headers when cacheRetention is none", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionAffinityHeaders: true },
		});
		const { headers } = await captureRequest({ cacheRetention: "none", sessionId: "session-affinity" }, model);

		expect(headers.session_id).toBeUndefined();
		expect(headers["x-client-request-id"]).toBeUndefined();
		expect(headers["x-session-affinity"]).toBeUndefined();
	});

	it("lets explicit headers override generated session-affinity headers", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionAffinityHeaders: true },
		});
		const { headers } = await captureRequest(
			{
				sessionId: "session-affinity",
				headers: {
					session_id: "override-session",
					"x-client-request-id": "override-request",
					"x-session-affinity": "override-affinity",
				},
			},
			model,
		);

		expect(headers.session_id).toBe("override-session");
		expect(headers["x-client-request-id"]).toBe("override-request");
		expect(headers["x-session-affinity"]).toBe("override-affinity");
	});
});
