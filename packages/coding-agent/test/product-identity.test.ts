import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatTopLevelHelp } from "../src/cli/command-registry.js";
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	ENV_AGENT_DIR,
	ENV_LEGACY_SESSION_DIR,
	ENV_SESSION_DIR,
	getAgentDir,
	getSessionDirEnvOverride,
	PRODUCT_COMMAND_NAME,
	PRODUCT_NAME,
	PRODUCT_PACKAGE_NAME,
	PRODUCT_REPOSITORY,
} from "../src/config.js";
import {
	loadPrimeCliConfig,
	PRIME_AGENT_TRACES_PROVIDER_ID,
	PRIME_AGENT_TRACES_PROVIDER_NAME,
	PRIME_INFERENCE_PROVIDER_ID,
	PRIME_INFERENCE_PROVIDER_NAME,
} from "../src/core/prime-inference-auth.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";

const expectedIdentity = {
	product: "Millwright",
	repository: "github.com/tim-osterhus/millwright",
	packageName: "millwright-agent",
	commandName: "millwright",
	userStateRootName: ".millwright",
	workspaceStateRootName: ".millwright",
	environmentPrefix: "MILLWRIGHT_",
} as const;

const STATE_ENV_NAMES = [
	"HOME",
	`${expectedIdentity.environmentPrefix}CODING_AGENT_DIR`,
	`${expectedIdentity.environmentPrefix}SESSION_DIR`,
	`${expectedIdentity.environmentPrefix}CODING_AGENT_SESSION_DIR`,
	"PI_CODING_AGENT_DIR",
	"PRIME_AGENT_CODING_AGENT_DIR",
	"PI_SESSION_DIR",
	"PRIME_AGENT_SESSION_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	"PRIME_AGENT_CODING_AGENT_SESSION_DIR",
];
const originalEnv = new Map(STATE_ENV_NAMES.map((name) => [name, process.env[name]]));
let tempRoot: string | undefined;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "millwright-product-identity-"));
	for (const name of STATE_ENV_NAMES) delete process.env[name];
});

afterEach(() => {
	for (const [name, value] of originalEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
	tempRoot = undefined;
});

describe("Millwright product identity", () => {
	it("matches the canonical product, repository, npm, command, state, and environment identity", () => {
		const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			repository?: { url?: string };
			piConfig?: {
				name?: string;
				displayName?: string;
				packageName?: string;
				configDir?: string;
			};
		};

		expect(APP_NAME).toBe(expectedIdentity.commandName);
		expect(PRODUCT_NAME).toBe(expectedIdentity.product);
		expect(PRODUCT_REPOSITORY).toBe(expectedIdentity.repository);
		expect(PRODUCT_PACKAGE_NAME).toBe(expectedIdentity.packageName);
		expect(PRODUCT_COMMAND_NAME).toBe(expectedIdentity.commandName);
		expect(CONFIG_DIR_NAME).toBe(expectedIdentity.userStateRootName);
		expect(ENV_AGENT_DIR).toBe("MILLWRIGHT_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("MILLWRIGHT_SESSION_DIR");
		expect(ENV_LEGACY_SESSION_DIR).toBe("MILLWRIGHT_CODING_AGENT_SESSION_DIR");
		expect(packageJson.repository?.url).toBe(`git+https://${expectedIdentity.repository}.git`);
		expect(packageJson.piConfig).toMatchObject({
			name: expectedIdentity.commandName,
			displayName: expectedIdentity.product,
			packageName: expectedIdentity.packageName,
			configDir: expectedIdentity.workspaceStateRootName,
		});
	});

	it("uses Millwright naming in help and retains explicit /refine", () => {
		const help = formatTopLevelHelp();

		expect(help).toContain("millwright - AI coding assistant");
		expect(help).toContain("Update Millwright");
		expect(help).not.toContain("prime-agent");
		expect(help).not.toContain("Prime Agent");
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "refine")).toBeDefined();
	});

	it("uses isolated user and workspace roots without touching legacy home state", () => {
		const home = join(tempRoot!, "home");
		const legacy = join(home, ".prime");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "sentinel.txt"), "legacy");
		process.env.HOME = home;

		expect(getAgentDir()).toBe(join(home, ".millwright"));
		expect(existsSync(join(home, ".millwright"))).toBe(false);

		const workspace = join(tempRoot!, "workspace");
		const workspaceState = join(workspace, ".millwright");
		mkdirSync(workspaceState, { recursive: true });
		writeFileSync(join(workspaceState, "settings.json"), JSON.stringify({ packages: ["npm:workspace"] }));
		const manager = SettingsManager.create(workspace, join(home, ".millwright"));
		expect(manager.getPackages()).toEqual(["npm:workspace"]);
		expect(readFileSync(join(legacy, "sentinel.txt"), "utf8")).toBe("legacy");
	});

	it("rejects a default user root symlinked into legacy state", () => {
		const home = join(tempRoot!, "home");
		const legacy = join(home, ".prime");
		mkdirSync(legacy, { recursive: true });
		symlinkSync(legacy, join(home, ".millwright"), "dir");
		process.env.HOME = home;

		expect(() => getAgentDir()).toThrow(/legacy|unsafe/i);
	});

	it("rejects a workspace root symlinked into legacy state", () => {
		const home = join(tempRoot!, "home");
		const workspace = join(tempRoot!, "workspace");
		const legacy = join(tempRoot!, ".prime");
		mkdirSync(home, { recursive: true });
		mkdirSync(workspace, { recursive: true });
		mkdirSync(legacy, { recursive: true });
		symlinkSync(legacy, join(workspace, ".millwright"), "dir");

		expect(() => SettingsManager.create(workspace, join(home, ".millwright"))).toThrow(/legacy|unsafe/i);
	});

	it("keeps the build-time Prime provider config below Millwright state", () => {
		const generator = readFileSync(new URL("../../ai/scripts/generate-models.ts", import.meta.url), "utf8");

		expect(generator).toContain('join(homedir(), ".millwright", "providers", "prime", "config.json")');
		expect(generator).not.toContain('join(homedir(), ".prime", "config.json")');
	});

	it("routes TUI diagnostics through the validated Millwright state root", () => {
		const tuiSource = readFileSync(new URL("../../tui/src/tui.ts", import.meta.url), "utf8");

		expect(tuiSource).toContain('path.join(getMillwrightStateDir(), "millwright-debug.log")');
		expect(tuiSource).toContain('path.join(getMillwrightStateDir(), "millwright-crash.log")');
		expect(tuiSource).toContain('path.join(getMillwrightStateDir(), "tui-debug")');
		expect(tuiSource).not.toContain('path.join(os.homedir(), ".millwright", "millwright-');
	});

	it("ignores legacy PI/PRIME overrides while honoring absolute Millwright overrides", () => {
		const home = join(tempRoot!, "home");
		const legacyOverride = join(tempRoot!, "legacy-override");
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = legacyOverride;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = legacyOverride;
		process.env.PI_SESSION_DIR = legacyOverride;
		process.env.PRIME_AGENT_SESSION_DIR = legacyOverride;
		process.env.PRIME_AGENT_CODING_AGENT_SESSION_DIR = legacyOverride;

		expect(getAgentDir()).toBe(join(home, ".millwright"));
		expect(getSessionDirEnvOverride()).toBeUndefined();

		const agentOverride = join(tempRoot!, "alternate-agent", "nested");
		const sessionOverride = join(tempRoot!, "alternate-session", "nested");
		process.env.MILLWRIGHT_CODING_AGENT_DIR = agentOverride;
		process.env.MILLWRIGHT_SESSION_DIR = sessionOverride;
		expect(getAgentDir()).toBe(agentOverride);
		expect(getSessionDirEnvOverride()).toBe(sessionOverride);
	});

	it("rejects relative, legacy-root, descendant, and ancestor-symlink state overrides", () => {
		const home = join(tempRoot!, "home");
		const primeRoot = join(home, ".prime");
		const millraceCliRoot = join(home, ".millrace-cli");
		const safeRoot = join(home, "safe");
		mkdirSync(primeRoot, { recursive: true });
		mkdirSync(millraceCliRoot, { recursive: true });
		mkdirSync(safeRoot, { recursive: true });
		symlinkSync(primeRoot, join(safeRoot, "legacy-link"), "dir");
		symlinkSync(join(primeRoot, "missing"), join(safeRoot, "dangling-link"), "dir");
		const unsafeValues = [
			"relative",
			primeRoot,
			join(primeRoot, "descendant"),
			millraceCliRoot,
			join(millraceCliRoot, "descendant"),
			join(safeRoot, "legacy-link", "descendant"),
			join(safeRoot, "dangling-link", "descendant"),
		];

		for (const value of unsafeValues) {
			process.env.MILLWRIGHT_CODING_AGENT_DIR = value;
			expect(() => getAgentDir()).toThrow(/absolute|legacy|unsafe|resolve/i);
		}

		for (const value of unsafeValues) {
			process.env.MILLWRIGHT_SESSION_DIR = value;
			expect(() => getSessionDirEnvOverride()).toThrow(/absolute|legacy|unsafe|resolve/i);
		}
	});

	it("retains Prime provider identities and service URLs", () => {
		expect(PRIME_INFERENCE_PROVIDER_ID).toBe("prime-inference");
		expect(PRIME_INFERENCE_PROVIDER_NAME).toBe("Prime Inference");
		expect(PRIME_AGENT_TRACES_PROVIDER_ID).toBe("prime-agent-traces");
		expect(PRIME_AGENT_TRACES_PROVIDER_NAME).toBe("Prime Agent Traces");

		const configPath = join(tempRoot!, "prime-provider-config.json");
		writeFileSync(configPath, "{}");
		const config = loadPrimeCliConfig(configPath);
		expect(config.baseUrl).toBe("https://api.primeintellect.ai");
		expect(config.frontendUrl).toBe("https://app.primeintellect.ai");
		expect(config.inferenceUrl).toBe("https://api.pinference.ai/api/v1");
	});
});
