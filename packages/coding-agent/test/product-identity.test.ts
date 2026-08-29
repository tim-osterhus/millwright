import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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

type IdentityClassification =
	| "provider"
	| "provenance"
	| "attribution"
	| "generated/vendor"
	| "private-internal"
	| "unclassified";

type IdentityHit = {
	path: string;
	line: number;
	token: string;
	classification: IdentityClassification;
	reason: string;
};

const PUBLIC_IDENTITY_PATHS = ["README.md", "package.json", "docs", "examples", "skills"] as const;

function publicTextFiles(relativeRoot: string): string[] {
	const absoluteRoot = new URL(`../${relativeRoot}`, import.meta.url);
	const rootPath = absoluteRoot.pathname;
	const files: string[] = [];
	const visit = (path: string, relativePath: string) => {
		const info = statSync(path);
		if (relativePath.split("/").includes("__pycache__") || relativePath.endsWith(".pyc")) return;
		if (info.isDirectory()) {
			for (const entry of readdirSync(path)) visit(join(path, entry), join(relativePath, entry));
		} else if (info.isFile()) {
			files.push(relativePath);
		}
	};
	visit(rootPath, relativeRoot);
	return files.sort();
}

function isCurrentProductPi(line: string): boolean {
	return /\bcommand\s*:\s*["']pi["']|\bpi\s+-[A-Za-z]\b|\bpi\s+--[A-Za-z][A-Za-z0-9-]*\b|\b(?:start|use|invoke|inside|exit)\s+(?:the\s+)?pi\b|\bpi(?:['’]s|s')\s+(?:default|current|active|primary|main)\b|\b(?:notify|setTitle|setLabel)\s*\(\s*["']Pi["']/iu.test(
		line,
	);
}

function hasBrandedPi(line: string): boolean {
	return (
		isCurrentProductPi(line) ||
		/@earendil-works\/pi-|\bpi-(?:mono|skills|package|agent|coding-agent|ai|tui)\b|(?:^|[\s`'"(])(?:~\/)?\.pi(?:[\s`'"/.)]|$)|["']pi["']\s*[:=]|\bpi\s+(?:CLI|command|package|manifest|API|product|agent|is\b)|\bpi\.(?:on|ui|register|send|get|set|exec|append|events|prompts|skills|themes)[A-Za-z0-9_]*\b|\b(?:use|run|invoke)\s+(?:the\s+)?pi\b/iu.test(
			line,
		)
	);
}

function identityTokens(line: string): string[] {
	const tokens = new Set<string>();
	for (const match of line.matchAll(
		/Prime Agent|prime-agent(?:-[A-Za-z0-9._-]+)?|\bPrime\b|\bprime\b|\bPI_[A-Z][A-Z0-9_]*\b/gu,
	))
		tokens.add(match[0]);
	if (hasBrandedPi(line)) {
		for (const match of line.matchAll(
			/@earendil-works\/pi-[A-Za-z0-9._-]+|\b(?:Pi|pi)\b|(?:^|\s)(?:~\/)?\.pi(?:[/A-Za-z0-9._-]*)/gu,
		)) {
			const token = match[0].trim();
			if (token) tokens.add(token);
		}
	}
	return [...tokens];
}

function isGeneratedVendorContext(path: string, line: string): boolean {
	return (
		path.startsWith("dist/bundle/") ||
		path.startsWith("dist/core/export-html/vendor/") ||
		/sourceMappingURL=/.test(line)
	);
}

function classifyIdentity(
	path: string,
	line: string,
	token: string,
): { classification: IdentityClassification; reason: string } {
	const lower = `${path}\n${line}`.toLowerCase();
	const generatedVendor = isGeneratedVendorContext(path, line);
	if (
		path.startsWith("skills/prime-intellect/") ||
		(generatedVendor && path.startsWith("dist/skills/prime-intellect/"))
	) {
		return { classification: "provider", reason: "Prime Intellect public skill identity" };
	}
	if (
		/prime agent traces|prime agent trace|prime-agent-traces|agent-traces|x-prime-team-id/.test(lower) ||
		(token === "prime" && path.includes("telemetry"))
	) {
		return { classification: "provider", reason: "Prime Agent Traces provider identity" };
	}
	if (/\.prime|\.millrace-cli/.test(lower)) {
		return { classification: "private-internal", reason: "retained legacy-root rejection marker" };
	}
	if (
		/prime-agent-runtime|prime-agent-skill-|application\/vnd\.prime-agent|ai\.primeintellect\.prime-agent|prime-agent\.sh|prime-agent\.(?:refinement|daemon|worker_|update_)|daemon worker|daemon supervisor|currenttheme/.test(
			lower,
		)
	) {
		return {
			classification: "private-internal",
			reason: "retained runtime, skill, protocol, or source-launcher identifier",
		};
	}
	if (token === "Prime Agent" || token === "prime-agent") {
		if (
			/upstream|provenance|attribution|fork|imported|lineage|license|notice|snapshot|derived|github.com\/primeintellect-ai\/prime-agent/.test(
				lower,
			)
		) {
			return { classification: "provenance", reason: "retained upstream Prime Agent provenance" };
		}
		return { classification: "unclassified", reason: "current product identity must use Millwright" };
	}
	if (
		(token === "Prime" || token === "prime") &&
		/\b(?:current|default)\s+(?:application|command|product|agent|name)\b|\b(?:Pi|pi|Prime|prime)\s+is\s+(?:the\s+)?(?:current|default)\b/.test(
			lower,
		)
	) {
		return { classification: "unclassified", reason: "current product identity must use Millwright" };
	}
	if (/^prime_agent_traces_|\bprime_agent_traces_/.test(token.toLowerCase())) {
		return { classification: "provider", reason: "Prime Agent Traces provider configuration" };
	}
	if (/^pi_(?:tui_write_log|timing)$/i.test(token)) {
		return { classification: "private-internal", reason: "retained upstream TUI debugging variable" };
	}
	if (
		/^PI_[A-Z][A-Z0-9_]*$/.test(token) &&
		(!generatedVendor || /\b(?:env(?:ironment)?|config(?:uration)?|state|setting|current|millwright)\b/.test(lower))
	) {
		return { classification: "unclassified", reason: "current product identity must use Millwright" };
	}
	if (/prime-butterfly|assets\/brand|prime-logo|prime brand/.test(lower)) {
		return { classification: "attribution", reason: "Prime Intellect brand asset attribution" };
	}
	if (/(?:^|\/)prime-(?:team-selector|onboarding-splash)|(?:^|\/)theme(?:\/|\.|$)/.test(lower)) {
		return {
			classification: "private-internal",
			reason: "retained private package, manifest, callback, or API identifier",
		};
	}
	if (
		/@earendil-works\/pi-|\bpi-(?:mono|skills|package|agent|coding-agent|ai|tui)\b|\bpi\.(?:on|ui|register|send|get|set|exec|append|events|prompts|skills|themes)\b|\b(?:Pi|pi)\b/.test(
			token,
		)
	) {
		if (
			/upstream|provenance|attribution|fork|imported|lineage|license|notice|pi-mono|pi skills|snapshot/.test(lower)
		) {
			return { classification: "provenance", reason: "retained upstream Pi lineage or attribution" };
		}
		if (
			(token === "Pi" || token === "pi") &&
			(isCurrentProductPi(line) ||
				/\b(?:current|default)\s+(?:application|command|product|agent|name)\b|\b(?:Pi|pi|Prime|prime)\s+is\s+(?:the\s+)?(?:current|default)\b/.test(
					lower,
				))
		) {
			return { classification: "unclassified", reason: "current product identity must use Millwright" };
		}

		if (
			/@earendil-works\/pi-|\bpi-(?:mono|skills|package|agent|coding-agent|ai|tui)\b|\bpi\s+packages?\b|\bpi\s+manifest\b|\bpi\.(?:on|ui|register|send|get|set|exec|append|events|prompts|skills|themes)[A-Za-z0-9_]*\b|(?:^|[\s`'"(])(?:~\/)?\.pi(?:[\s`'"/.)]|$)|["']pi["']\s*[:=]/.test(
				lower,
			)
		) {
			return {
				classification: "private-internal",
				reason: "retained private package, manifest, callback, or API identifier",
			};
		}
		if (generatedVendor) {
			return { classification: "generated/vendor", reason: "generated bundled or vendored application output" };
		}
		return { classification: "unclassified", reason: "current product identity must use Millwright" };
	}
	if (
		/prime inference|prime-inference|prime api|primeintellect\.ai|prime intellect|prime-intellect|prime cli|prime-rl|prime team|prime provider/.test(
			lower,
		)
	) {
		return { classification: "provider", reason: "Prime Inference or Prime Intellect provider/skill identity" };
	}
	if (
		/upstream|provenance|attribution|fork|imported|lineage|license|notice|snapshot|derived|github.com\/primeintellect-ai\/prime-agent/.test(
			lower,
		)
	) {
		return { classification: "provenance", reason: "retained upstream provenance or attribution" };
	}
	if (generatedVendor) {
		return { classification: "generated/vendor", reason: "generated bundled or vendored application output" };
	}
	return {
		classification: "unclassified",
		reason: "not an allowed provider, provenance, attribution, generated/vendor, or private-internal identity",
	};
}

function scanPublicIdentity(): IdentityHit[] {
	const hits: IdentityHit[] = [];
	for (const relativeRoot of PUBLIC_IDENTITY_PATHS) {
		for (const relativePath of publicTextFiles(relativeRoot)) {
			const text = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
			for (const [index, line] of text.split(/\r?\n/u).entries()) {
				for (const token of identityTokens(line)) {
					const result = classifyIdentity(relativePath, line, token);
					hits.push({ path: relativePath, line: index + 1, token, ...result });
				}
			}
		}
	}
	return hits;
}

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
	it("rejects unclassified identity residue from public source surfaces and installer plumbing", () => {
		const rootPackage = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
			scripts?: Record<string, string>;
		};
		const hits = scanPublicIdentity();
		const unclassified = hits.filter((hit) => hit.classification === "unclassified");
		expect(unclassified, JSON.stringify(unclassified, null, 2)).toEqual([]);
		expect(rootPackage.scripts?.["check:installer"]).toBeUndefined();
		expect(rootPackage.scripts?.check).not.toContain("check:installer");
		expect(rootPackage.scripts?.["check:ci"]).not.toContain("check:installer");
		expect(existsSync(new URL("../../../install.sh", import.meta.url))).toBe(false);
		expect(existsSync(new URL("../../../scripts/check-installer-render.mjs", import.meta.url))).toBe(false);
		expect(existsSync(new URL("../../../scripts/preview-installer-splash.sh", import.meta.url))).toBe(false);
	});

	it("keeps identity tokens boundary-aware", () => {
		expect(identityTokens("PrimeAgent primePath unrelated PI_BY_TWO")).toEqual(["PI_BY_TWO"]);
		expect(identityTokens("Prime Agent is the current command")).toContain("Prime Agent");
		expect(classifyIdentity("README.md", "Pi is the current command", "Pi").classification).toBe("unclassified");
		expect(classifyIdentity("README.md", "use pi CLI", "pi").classification).toBe("unclassified");
		expect(classifyIdentity("README.md", "run the pi command", "pi").classification).toBe("unclassified");
		for (const line of [
			'command: "pi"',
			"command: 'pi'",
			"pi -e ./extension",
			'pi -p "prompt"',
			"pi --flag",
			"start pi",
			"use pi",
			"invoke pi",
			"inside pi",
			"exit pi",
			"Pi's default spinner",
			"Pi’s default spinner",
			'notify("Pi", "Ready")',
		]) {
			expect(
				identityTokens(line).some((token) => token.toLowerCase() === "pi"),
				line,
			).toBe(true);
			expect(classifyIdentity("README.md", line, "pi").classification, line).toBe("unclassified");
		}
		expect(
			classifyIdentity("README.md", "import @earendil-works/pi-ai", "@earendil-works/pi-ai").classification,
		).toBe("private-internal");
		expect(identityTokens('pi.registerTool("example")')).toContain("pi");
		expect(classifyIdentity("README.md", 'pi.registerTool("example")', "pi").classification).toBe("private-internal");
		expect(classifyIdentity("README.md", '"pi": { "extensions": [] }', "pi").classification).toBe("private-internal");
		expect(classifyIdentity("README.md", "Prime Inference provider", "Prime").classification).toBe("provider");
		expect(classifyIdentity("UPSTREAM.md", "Prime Agent provenance", "Prime Agent").classification).toBe(
			"provenance",
		);
	});

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
		symlinkSync(primeRoot, join(safeRoot, "prime-link"), "dir");
		symlinkSync(millraceCliRoot, join(safeRoot, "millrace-cli-link"), "dir");
		symlinkSync(join(primeRoot, "missing"), join(safeRoot, "dangling-prime-link"), "dir");
		symlinkSync(join(millraceCliRoot, "missing"), join(safeRoot, "dangling-millrace-cli-link"), "dir");
		const unsafeValues = [
			"relative",
			primeRoot,
			join(primeRoot, "descendant"),
			millraceCliRoot,
			join(millraceCliRoot, "descendant"),
			join(safeRoot, "prime-link", "descendant"),
			join(safeRoot, "millrace-cli-link", "descendant"),
			join(safeRoot, "dangling-prime-link", "descendant"),
			join(safeRoot, "dangling-millrace-cli-link", "descendant"),
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
