#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	closeSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, platform, release } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPORT_IDS = [
	"help",
	"version",
	"tui",
	"configState",
	"sessionState",
	"skillDiscovery",
	"kernelDiscovery",
	"daemonLifecycle",
	"legacyState",
	"refinementSafety",
	"identity",
	"cleanup",
];

export const DAEMON_CASE_IDS = [
	"clean-stop",
	"sigterm",
	"launcher-parent-exit",
	"startup-validation-failure",
];

const PUBLIC_NAME = "millwright-agent";
const PUBLIC_VERSION = "0.0.3";
const MAX_OUTPUT_BYTES = 64 * 1024;
const TUI_TIMEOUT_MS = 30_000;
const LAUNCHER_PRINT_COMMAND = "/goal status";
const SHORT_ALIAS_PARENT = process.platform === "darwin" ? "/private/tmp" : "/tmp";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const PROCESS_REGISTRY_ENV = "MILLWRIGHT_QUALIFICATION_PROCESS_REGISTRY";
const PROCESS_REGISTRY_TOKEN_ENV = "MILLWRIGHT_QUALIFICATION_PROCESS_TOKEN";
const PROCESS_SCOPE_ENV = "MILLWRIGHT_QUALIFICATION_PROCESS_SCOPE";
const PROCESS_REGISTRY_LIMIT = 4 * 1024 * 1024;
const scriptPath = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(scriptPath), "..");
const processRegistries = new Map();
let processScopeSequence = 0;

function fail(message) {
	throw new Error(message);
}

export function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function sha512Integrity(value) {
	return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

function isWithin(parent, child) {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function assertRegularFile(path, label) {
	let info;
	try {
		info = lstatSync(path);
	} catch {
		fail(`${label} does not exist`);
	}
	if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular file`);
}

function assertNoSymlinkComponents(path, label) {
	let current = resolve(path);
	while (true) {
		if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
			const trustedMacVarAlias = process.platform === "darwin" && current === "/var" && realpathSync(current) === "/private/var";
			if (!trustedMacVarAlias) fail(`${label} cannot contain a symlink component`);
		}
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

function validateOwnedRoot(path, label, context) {
	if (!isAbsolute(path)) fail(`${label} must be absolute`);
	const normalized = resolve(path);
	assertNoSymlinkComponents(normalized, label);
	if (normalized === resolve(sep)) fail(`${label} cannot be the filesystem root`);
	for (const forbidden of [context.sourceRoot, context.home].filter(Boolean)) {
		const normalizedForbidden = resolve(forbidden);
		if (isWithin(normalizedForbidden, normalized) || isWithin(normalized, normalizedForbidden)) {
			fail(`${label} cannot reuse the ${normalizedForbidden === resolve(context.sourceRoot) ? "source root" : "home root"}`);
		}
	}
	if (existsSync(normalized)) fail(`${label} must not already exist`);
	const parent = dirname(normalized);
	let parentInfo;
	try {
		parentInfo = lstatSync(parent);
	} catch {
		fail(`${label} parent must already exist`);
	}
	if (!parentInfo.isDirectory()) fail(`${label} parent must be a directory`);
	const canonicalParent = realpathSync(parent);
	const canonicalCandidate = resolve(canonicalParent, basename(normalized));
	for (const forbidden of [context.sourceRoot, context.home].filter(Boolean)) {
		const canonicalForbidden = realpathSync(resolve(forbidden));
		if (isWithin(canonicalForbidden, canonicalCandidate) || isWithin(canonicalCandidate, canonicalForbidden)) {
			fail(`${label} cannot reuse the ${canonicalForbidden === realpathSync(context.sourceRoot) ? "source root" : "home root"}`);
		}
	}
	return normalized;
}

function removeOwnedRoot(path, context) {
	if (!existsSync(path)) return;
	assertNoSymlinkComponents(path, "owned cleanup root");
	const info = lstatSync(path);
	if (!info.isDirectory() || info.isSymbolicLink()) fail("owned cleanup root changed type");
	const canonical = realpathSync(path);
	const canonicalParent = realpathSync(dirname(path));
	if (canonical !== resolve(canonicalParent, basename(path))) fail("owned cleanup root escaped its validated parent");
	for (const forbidden of [context.sourceRoot, context.home]) {
		const canonicalForbidden = realpathSync(forbidden);
		if (isWithin(canonicalForbidden, canonical) || isWithin(canonical, canonicalForbidden)) fail("owned cleanup root overlaps protected state");
	}
	rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

function createTaskOwnedShortTmpAlias(temporaryRoot) {
	const target = join(temporaryRoot, "daemon-tmp");
	if (existsSync(target)) fail("daemon TMPDIR target must be fresh");
	mkdirSync(target, { mode: 0o700 });
	const aliasContainer = mkdtempSync(join(SHORT_ALIAS_PARENT, "mwq-"));
	const alias = join(aliasContainer, "tmp");
	try {
		symlinkSync(target, alias, "dir");
		const canonicalTemporaryRoot = realpathSync(temporaryRoot);
		const canonicalTarget = realpathSync(target);
		if (!isWithin(canonicalTemporaryRoot, canonicalTarget) || canonicalTarget === canonicalTemporaryRoot) fail("daemon TMPDIR target escaped the qualification temporary root");
		if (realpathSync(alias) !== canonicalTarget) fail("daemon TMPDIR alias resolved to an unexpected target");
		return { alias, aliasContainer, target };
	} catch (error) {
		try { unlinkSync(alias); } catch {}
		try { rmSync(aliasContainer, { recursive: true, force: true }); } catch {}
		try { rmSync(target, { recursive: true, force: true }); } catch {}
		throw error;
	}
}

function removeTaskOwnedShortTmpAlias(entry, temporaryRoot) {
	const aliasInfo = lstatSync(entry.alias);
	if (!aliasInfo.isSymbolicLink()) fail("daemon TMPDIR alias changed type");
	const canonicalTemporaryRoot = realpathSync(temporaryRoot);
	const canonicalTarget = realpathSync(entry.target);
	if (!isWithin(canonicalTemporaryRoot, canonicalTarget) || realpathSync(entry.alias) !== canonicalTarget) fail("daemon TMPDIR alias target changed");
	unlinkSync(entry.alias);
	removeOwnedRoot(entry.aliasContainer, { sourceRoot, home: homedir() });
}

export function parseQualificationArgs(args, context = {}) {
	const values = {};
	const allowed = new Set(["--tarball", "--source-commit", "--temporary-root", "--results"]);
	if (args.length !== 8) fail("Expected exactly --tarball, --source-commit, --temporary-root, and --results");
	for (let index = 0; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (!allowed.has(option) || !value || Object.hasOwn(values, option)) fail(`Invalid option: ${option || "(missing)"}`);
		values[option] = value;
	}
	const tarball = values["--tarball"];
	if (!isAbsolute(tarball)) fail("--tarball must be absolute");
	assertRegularFile(tarball, "tarball");
	if (basename(tarball) !== `${PUBLIC_NAME}-${PUBLIC_VERSION}.tgz`) fail("Unexpected tarball filename");
	const sourceCommit = values["--source-commit"];
	if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) fail("--source-commit must be a lowercase 40-hex commit");
	const validationContext = {
		sourceRoot: context.sourceRoot ?? sourceRoot,
		home: context.home ?? homedir(),
	};
	const temporaryRoot = validateOwnedRoot(values["--temporary-root"], "--temporary-root", validationContext);
	const results = validateOwnedRoot(values["--results"], "--results", validationContext);
	if (realpathSync(dirname(temporaryRoot)) !== realpathSync(dirname(results))) {
		fail("--temporary-root and --results must be sibling children of one caller-owned root");
	}
	if (temporaryRoot === results) fail("--temporary-root and --results must differ");
	return { tarball: resolve(tarball), sourceCommit, temporaryRoot, results };
}

const SAFE_ENV_NAMES = new Set([
	"PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "COMSPEC",
	"PATHEXT", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "USER", "LOGNAME", "CI",
]);

export function sanitizeEnvironment(inherited, roots, additions = {}) {
	const env = {};
	for (const [name, value] of Object.entries(inherited)) {
		if (SAFE_ENV_NAMES.has(name) && typeof value === "string" && value.length > 0) env[name] = value;
	}
	Object.assign(env, {
		HOME: roots.home,
		USERPROFILE: roots.home,
		npm_config_cache: roots.cache,
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
		MILLWRIGHT_CODING_AGENT_DIR: roots.agent,
		MILLWRIGHT_SESSION_DIR: roots.session,
		MILLWRIGHT_OFFLINE: "1",
		MILLWRIGHT_SKIP_VERSION_CHECK: "1",
		TZ: "UTC",
		LC_ALL: "C",
	}, additions);
	return env;
}

function shellQuote(value) {
	return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function ptyInvocation(targetPlatform, wrapperPath) {
	if (targetPlatform === "darwin") {
		return { command: "/usr/bin/script", args: ["-q", "/dev/null", wrapperPath] };
	}
	if (targetPlatform === "linux") {
		return { command: "script", args: ["-q", "-e", "-c", shellQuote(wrapperPath), "/dev/null"] };
	}
	fail(`Real PTY support is unavailable on ${targetPlatform}`);
}

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function processStartId(pid) {
	if (!processAlive(pid)) return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (fields[19]) return `proc:${fields[19]}`;
	} catch {}
	const value = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } });
	return value.status === 0 && value.stdout.trim() ? `ps:${value.stdout.trim()}` : null;
}

function identityAlive(identity) {
	if (!identity?.pid || typeof identity.startId !== "string" || !processAlive(identity.pid)) return false;
	return processStartId(identity.pid) === identity.startId;
}

function processGroup(pid) {
	const value = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" });
	const parsed = Number.parseInt(value.stdout?.trim() || "", 10);
	return Number.isInteger(parsed) ? parsed : null;
}

function processIdentity(pid) {
	const startId = processStartId(pid);
	const group = processGroup(pid);
	return startId && Number.isInteger(group) && group > 0 ? { pid, startId, processGroup: group } : null;
}

function processRegistryHook() {
	return `
const childProcess = require("node:child_process");
const { appendFileSync, readFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const registry = process.env.${PROCESS_REGISTRY_ENV};
const token = process.env.${PROCESS_REGISTRY_TOKEN_ENV};
const scope = process.env.${PROCESS_SCOPE_ENV};
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;
const originalFork = childProcess.fork;
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function startId(pid) {
	if (!alive(pid)) return null;
	try {
		const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (fields[19]) return "proc:" + fields[19];
	} catch {}
	const value = originalSpawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } });
	return value.status === 0 && value.stdout.trim() ? "ps:" + value.stdout.trim() : null;
}
function group(pid) {
	const value = originalSpawnSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" });
	const parsed = Number.parseInt(value.stdout && value.stdout.trim() || "", 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
function register(pid, parentPid) {
	if (!registry || !token || !scope || !Number.isInteger(pid) || pid < 1) return;
	const identity = { pid, startId: startId(pid), processGroup: group(pid) };
	if (!identity.startId || !identity.processGroup) return;
	appendFileSync(registry, JSON.stringify({ token, scope, parentPid, ...identity }) + "\\n", { encoding: "utf8", flag: "a", mode: 0o600 });
}
register(process.pid, process.ppid);
childProcess.spawn = function (...args) {
	const child = originalSpawn.apply(this, args);
	register(child.pid, process.pid);
	return child;
};
childProcess.fork = function (...args) {
	const child = originalFork.apply(this, args);
	register(child.pid, process.pid);
	return child;
};
syncBuiltinESMExports();
`;
}

function createProcessRegistry(root) {
	const hookPath = join(root, ".millwright-qualification-process-hook.cjs");
	const registryPath = join(root, ".millwright-qualification-processes.jsonl");
	const token = randomBytes(24).toString("hex");
	writeFileSync(registryPath, "", { mode: 0o600 });
	writeFileSync(hookPath, processRegistryHook(), { mode: 0o600 });
	const registry = { hookPath, registryPath, token, identities: new Map() };
	processRegistries.set(registryPath, registry);
	return registry;
}

function processRegistryEnvironment(registry) {
	return {
		NODE_OPTIONS: `--require=${JSON.stringify(registry.hookPath)}`,
		[PROCESS_REGISTRY_ENV]: registry.registryPath,
		[PROCESS_REGISTRY_TOKEN_ENV]: registry.token,
	};
}

function registryForEnvironment(environment) {
	const registry = processRegistries.get(environment?.[PROCESS_REGISTRY_ENV]);
	return registry?.token === environment?.[PROCESS_REGISTRY_TOKEN_ENV] ? registry : null;
}

function scopedProcessEnvironment(environment, processRegistryRoot) {
	const registry = processRegistryRoot ? createProcessRegistry(processRegistryRoot) : registryForEnvironment(environment);
	if (!registry) return { environment, registry: null, scope: null };
	const scope = `${process.pid}-${++processScopeSequence}`;
	return { environment: { ...environment, ...processRegistryEnvironment(registry), [PROCESS_SCOPE_ENV]: scope }, registry, scope };
}

function registeredIdentities(registry, scope) {
	if (!registry || !existsSync(registry.registryPath)) return [];
	const size = statSync(registry.registryPath).size;
	if (size > PROCESS_REGISTRY_LIMIT) fail("Qualification process registry exceeded its declared byte ceiling");
	const rows = readFileSync(registry.registryPath, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => {
		let row;
		try { row = JSON.parse(line); } catch { fail("Qualification process registry contains malformed evidence"); }
		if (row.token !== registry.token || typeof row.scope !== "string" || !Number.isInteger(row.pid) || row.pid < 1 || typeof row.startId !== "string" || !row.startId || !Number.isInteger(row.processGroup) || row.processGroup < 1) fail("Qualification process registry contains invalid evidence");
		return row;
	});
	for (const row of rows) {
		const key = `${row.pid}:${row.startId}`;
		const existing = registry.identities.get(key);
		if (existing && existing.processGroup !== row.processGroup) fail("Qualification process registry identity changed process group");
		registry.identities.set(key, { pid: row.pid, startId: row.startId, processGroup: row.processGroup });
	}
	const selected = scope ? rows.filter((row) => row.scope === scope) : rows;
	return [...new Map(selected.map(({ pid, startId, processGroup }) => [`${pid}:${startId}`, { pid, startId, processGroup }])).values()];
}

function mergeIdentities(...collections) {
	return [...new Map(collections.flat().filter((identity) => identity?.startId).map((identity) => [`${identity.pid}:${identity.startId}`, identity])).values()];
}

function processTable() {
	const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } });
	if (result.status !== 0) return [];
	return result.stdout.split(/\r?\n/u).flatMap((line) => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u);
		return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startId: `ps:${match[4]}` }] : [];
	});
}

function descendantsOf(pid) {
	const table = processTable();
	const found = [];
	const parents = new Set([pid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const entry of table) {
			if (parents.has(entry.ppid) && !parents.has(entry.pid)) {
				parents.add(entry.pid);
				found.push({ pid: entry.pid, startId: processStartId(entry.pid) ?? entry.startId, processGroup: entry.pgid });
				changed = true;
			}
		}
	}
	return found;
}


function signalOwnedIdentity(identity, signal) {
	if (!identityAlive(identity)) return;
	try {
		if (process.platform !== "win32" && identity.processGroup === identity.pid && processGroup(identity.pid) === identity.processGroup) process.kill(-identity.processGroup, signal);
		else process.kill(identity.pid, signal);
	} catch {
		try { if (identityAlive(identity)) process.kill(identity.pid, signal); } catch {}
	}
}

async function waitUntil(predicate, timeoutMs, intervalMs = 25) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((done) => setTimeout(done, intervalMs));
	}
	return false;
}

function appendBounded(current, chunk, limit) {
	if (current.length >= limit) return current;
	const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
	return Buffer.concat([current, buffer.subarray(0, limit - current.length)]);
}

export async function runBoundedCommand(command, args, options) {
	const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
	const scoped = scopedProcessEnvironment(options.env, options.processRegistryRoot);
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: scoped.environment,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const identity = { pid: child.pid ?? null, startId: child.pid ? processStartId(child.pid) : null, processGroup: child.pid ? processGroup(child.pid) : null };
	const observedDescendants = new Map();
	const observeDescendants = () => {
		for (const current of descendantsOf(identity.pid ?? -1)) {
			if (current.startId) observedDescendants.set(`${current.pid}:${current.startId}`, current);
		}
	};
	const monitor = setInterval(observeDescendants, 20);
	let stdout = Buffer.alloc(0);
	let stderr = Buffer.alloc(0);
	child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, maxOutputBytes); });
	child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, maxOutputBytes); });
	let timedOut = false;
	let timer;
	const settled = await new Promise((done) => {
		timer = setTimeout(() => {
			timedOut = true;
			signalOwnedIdentity(identity, "SIGTERM");
			setTimeout(() => signalOwnedIdentity(identity, "SIGKILL"), 500).unref();
		}, options.timeoutMs);
		child.once("error", (error) => done({ code: null, signal: null, error }));
		child.once("exit", (code, signal) => done({ code, signal, error: null }));
	});
	clearTimeout(timer);
	clearInterval(monitor);
	observeDescendants();
	if (child.pid) await waitUntil(() => !processAlive(child.pid), 1500);
	const registered = registeredIdentities(scoped.registry, scoped.scope).filter((current) => current.pid !== identity.pid || current.startId !== identity.startId);
	const descendants = mergeIdentities([...observedDescendants.values()], registered);
	await waitUntil(() => descendants.every((current) => !identityAlive(current)), 250);
	const lingering = descendants.filter(identityAlive);
	if (!options.retainDescendants) for (const current of lingering) await stopOwnedIdentity(current);
	const residualPids = [identity, ...descendants].filter(identityAlive).map(({ pid }) => pid);
	return {
		...settled,
		timedOut,
		stdout: stdout.toString("utf8"),
		stderr: stderr.toString("utf8"),
		identity,
		processRegistry: scoped.registry,
		processScope: scoped.scope,
		cleanup: { observedDescendants: descendants, reapedPids: options.retainDescendants ? [] : lingering.map(({ pid }) => pid), residualPids },
	};
}

function rootSet(temporaryRoot, id, socketDirectory = temporaryRoot) {
	const base = join(temporaryRoot, "cases", id);
	const roots = {
		base,
		project: join(base, "project"),
		home: join(base, "home"),
		cache: join(base, "cache"),
		agent: join(base, "home", ".millwright"),
		session: join(base, "sessions"),
		socket: join(socketDirectory, `${sha256(id).slice(0, 2)}.s`),
		python: join(base, "python"),
	};
	for (const path of [roots.project, roots.home, roots.cache, roots.agent, roots.session, dirname(roots.socket), roots.python]) {
		mkdirSync(path, { recursive: true });
	}
	return roots;
}

function createLegacySentinels(roots) {
	const sentinels = [
		join(roots.home, ".prime", "sentinel.bin"),
		join(roots.home, ".millrace-cli", "sentinel.bin"),
		join(roots.project, ".prime", "sentinel.bin"),
		join(roots.project, ".millrace-cli", "sentinel.bin"),
	];
	for (const path of sentinels) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, Buffer.from(`legacy:${basename(dirname(path))}:unchanged`, "utf8"));
	}
	return sentinels.map((path) => ({ path, sha256: sha256(readFileSync(path)) }));
}

const LEGACY_SENTINEL_LOCATIONS = ["home/.prime", "home/.millrace-cli", "project/.prime", "project/.millrace-cli"];

function verifyLegacySentinels(before) {
	return before.every(({ path, sha256: expected }) => existsSync(path) && sha256(readFileSync(path)) === expected);
}

function redactText(text, secrets, replacements = []) {
	let value = String(text ?? "");
	for (const secret of secrets) if (secret) value = value.split(secret).join("[REDACTED]");
	for (const [raw, replacement] of replacements) if (raw) value = value.split(raw).join(replacement);
	return value.slice(0, MAX_OUTPUT_BYTES);
}

function secretValues(environment) {
	return Object.entries(environment)
		.filter(([name, value]) => value && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/iu.test(name))
		.map(([, value]) => String(value));
}

async function record(id, action, redaction) {
	const start = Date.now();
	try {
		const result = await action();
		const stdout = redactText(result.stdout ?? "", redaction.secrets, redaction.paths);
		const stderr = redactText(result.stderr ?? "", redaction.secrets, redaction.paths);
		return {
			id,
			status: "passed",
			durationMs: Math.max(0, Date.now() - start),
			exitCode: result.exitCode ?? null,
			stdoutSha256: sha256(stdout),
			stderrSha256: sha256(stderr),
			details: result.details ?? {},
		};
	} catch (error) {
		const message = redactText(error instanceof Error ? error.message : String(error), redaction.secrets, redaction.paths);
		return {
			id,
			status: "failed",
			durationMs: Math.max(0, Date.now() - start),
			exitCode: typeof error?.exitCode === "number" ? error.exitCode : null,
			stdoutSha256: error?.stdout ? sha256(redactText(error.stdout, redaction.secrets, redaction.paths)) : EMPTY_SHA256,
			stderrSha256: sha256(message),
			details: { error: message.slice(0, 1000) },
		};
	}
}

function assertCommand(result, label, accepted = [0]) {
	if (result.timedOut) fail(`${label} timed out`);
	if (!accepted.includes(result.code)) {
		const error = new Error(`${label} failed (${result.code ?? result.signal ?? "spawn"}): ${(result.stderr || result.stdout).slice(0, 2000)}`);
		error.exitCode = result.code;
		error.stdout = result.stdout;
		throw error;
	}
}

function assertInstalledExecutable(path, installedRoot) {
	let info;
	try { info = lstatSync(path); } catch { fail("installed executable does not exist"); }
	if (!info.isFile() && !info.isSymbolicLink()) fail("installed executable is not a file or package link");
	const resolvedPath = realpathSync(path);
	if (!statSync(resolvedPath).isFile()) fail("installed executable target is not a file");
	if (!isWithin(realpathSync(join(installedRoot, "dist")), resolvedPath) || isWithin(sourceRoot, resolvedPath)) fail("installed executable escaped the installed package");
}

function installedEntrypoints(installedRoot) {
	return [
		"dist/index.js",
		"dist/config.js",
		"dist/core/settings-manager.js",
		"dist/core/session-manager.js",
		"dist/core/skills.js",
		"dist/core/slash-commands.js",
		"dist/core/refinement/index.js",
	].map((path) => join(installedRoot, path));
}

function validateEntrypoints(installedRoot, entries) {
	const dist = `${realpathSync(join(installedRoot, "dist"))}${sep}`;
	for (const entry of entries) {
		assertRegularFile(entry, "installed first-party entrypoint");
		if (!realpathSync(entry).startsWith(dist)) fail(`First-party entrypoint escaped installed dist: ${entry}`);
		if (isWithin(sourceRoot, realpathSync(entry))) fail("First-party entrypoint resolved to the source checkout");
	}
	return entries.map((entry) => relative(installedRoot, entry).split(sep).join("/"));
}

function writeProbe(path, installedRoot) {
	const entry = Object.fromEntries(installedEntrypoints(installedRoot).map((value) => [relative(installedRoot, value), pathToFileURL(value).href]));
	const aiUrl = pathToFileURL(join(installedRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")).href;
	writeFileSync(path, `
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const mode = process.argv[2];
const urls = ${JSON.stringify(entry)};
const output = (value) => process.stdout.write(JSON.stringify(value));
if (mode === "config") {
	const config = await import(urls["dist/config.js"]);
	const settingsModule = await import(urls["dist/core/settings-manager.js"]);
	const settings = settingsModule.SettingsManager.create(process.cwd(), process.env.MILLWRIGHT_CODING_AGENT_DIR);
	output({ product: config.PRODUCT_NAME, packageName: config.PRODUCT_PACKAGE_NAME, command: config.PRODUCT_COMMAND_NAME, agentRootMatches: config.getAgentDir() === process.env.MILLWRIGHT_CODING_AGENT_DIR, freshAutoRefine: settings.getAutoRefineSettings().enabled });
} else if (mode === "session") {
	const { SessionManager } = await import(urls["dist/core/session-manager.js"]);
	const manager = SessionManager.create(process.cwd(), process.env.MILLWRIGHT_SESSION_DIR);
	manager.appendCustomEntry("millwright.qualification", { installed: true });
	output({ persisted: !!manager.getSessionFile?.(), sessionRootMatches: manager.getSessionFile?.().startsWith(process.env.MILLWRIGHT_SESSION_DIR), entries: manager.getEntries().length });
} else if (mode === "skills") {
	const { loadSkillsFromDir } = await import(urls["dist/core/skills.js"]);
	const loaded = loadSkillsFromDir({ dir: process.env.MWQ_SKILL_DIR, source: "path" });
	output({ names: loaded.skills.map((skill) => skill.name), diagnostics: loaded.diagnostics.length });
} else if (mode === "refinement") {
	const api = await import(urls["dist/index.js"]);
	const slash = await import(urls["dist/core/slash-commands.js"]);
	const ai = await import(${JSON.stringify(aiUrl)});
	const fresh = api.SettingsManager.inMemory();
	const explicit = api.SettingsManager.inMemory({ autoRefine: { enabled: true } });
	const faux = ai.registerFauxProvider({ provider: "millwright-qualification-faux" });
	const model = faux.getModel();
	faux.setResponses([ai.fauxAssistantMessage(JSON.stringify({ summary: "Installed refinement", rationale: "Deterministic qualification", expectedOutcome: "Persist installed memory", edits: [{ action: "create", kind: "memory", id: "installed_qualification", title: "Installed qualification", content: "Installed /refine path executed.", reason: "qualification" }] }))]);
	const auth = api.AuthStorage.inMemory();
	auth.setRuntimeApiKey(model.provider, "faux-key");
	const registry = api.ModelRegistry.inMemory(auth);
	registry.registerProvider(model.provider, { baseUrl: model.baseUrl, apiKey: "faux-key", api: faux.api, models: faux.models.map((item) => ({ id: item.id, name: item.name, api: item.api, reasoning: item.reasoning, input: item.input, cost: item.cost, contextWindow: item.contextWindow, maxTokens: item.maxTokens, baseUrl: item.baseUrl })) });
	const manager = api.SessionManager.create(process.cwd(), process.env.MILLWRIGHT_SESSION_DIR);
	const created = await api.createAgentSession({ cwd: process.cwd(), agentDir: process.env.MILLWRIGHT_CODING_AGENT_DIR, authStorage: auth, modelRegistry: registry, model, sessionManager: manager, settingsManager: explicit, noTools: "all", tools: [] });
	try {
		await created.session.prompt("/refine remember the installed qualification path");
		await created.session.waitForSessionInputIdle();
		const resultRows = manager.getEntries().filter((row) => row.type === "custom_message" && row.customType === "session_slash_command_result");
		const harnessPath = join(manager.getSessionArtifactDir(), "harness", "harness_state.json");
		const state = existsSync(harnessPath) ? JSON.parse(readFileSync(harnessPath, "utf8")) : undefined;
		output({ freshEnabled: fresh.getAutoRefineSettings().enabled, explicitEnabled: explicit.getAutoRefineSettings().enabled, commandPresent: slash.BUILTIN_SLASH_COMMANDS.some((command) => command.name === "refine"), promptPath: resultRows.some((row) => String(row.content).includes("Refined continual harness state")), persisted: !!state?.entries?.memory?.installed_qualification, fauxCalls: faux.state.callCount });
	} finally {
		await created.session.disposeAsync?.();
		created.session.dispose();
		faux.unregister();
	}
}
`);
}

async function runStateProbe(mode, roots, installedRoot, environment) {
	const probe = join(roots.project, "installed-probe.mjs");
	writeProbe(probe, installedRoot);
	if (mode === "skills") {
		const skillDir = join(roots.project, "installed-fixture");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: installed-fixture\ndescription: Installed fixture skill.\n---\n");
		environment = { ...environment, MWQ_SKILL_DIR: skillDir };
	}
	const result = await runBoundedCommand(process.execPath, [probe, mode], { cwd: roots.project, env: environment, timeoutMs: 30_000 });
	assertCommand(result, `${mode} installed probe`);
	return { details: JSON.parse(result.stdout), stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
}

async function substitutedStateProbe(substitution, mode, roots, installedRoot) {
	const result = await substitution({ roots, installedRoot });
	const key = mode === "config" ? "configState" : mode === "session" ? "sessionState" : mode === "skills" ? "skillDiscovery" : "refinementSafety";
	return { details: result[key], stdout: JSON.stringify(result[key]), stderr: "", exitCode: 0 };
}

function assertStateProbe(mode, details) {
	if (mode === "config") {
		if (details?.agentRootMatches !== true || details.product !== "Millwright" || details.packageName !== PUBLIC_NAME || details.command !== "millwright" || details.freshAutoRefine !== false) {
			fail(`Installed config contract failed: ${JSON.stringify(details)}`);
		}
		return;
	}
	if (mode === "session") {
		if (details?.sessionRootMatches !== true || details.persisted !== true) fail(`Installed session contract failed: ${JSON.stringify(details)}`);
		return;
	}
	if (!Array.isArray(details?.names) || !details.names.includes("installed-fixture") || details.diagnostics !== 0) {
		fail(`Installed skill contract failed: ${JSON.stringify(details)}`);
	}
}

function npmCommand() {
	const execPath = process.env.npm_execpath;
	return execPath ? { command: process.execPath, prefix: [execPath] } : { command: "npm", prefix: [] };
}

async function installTarball(options, roots, processEnvironment) {
	const project = join(options.temporaryRoot, "install", "project");
	const cache = join(options.temporaryRoot, "install", "cache");
	const home = join(options.temporaryRoot, "install", "home");
	mkdirSync(project, { recursive: true });
	mkdirSync(cache, { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "millwright-installed-qualification", private: true, version: "1.0.0" })}\n`);
	const npm = npmCommand();
	const env = sanitizeEnvironment(process.env, { home, cache, agent: join(home, ".millwright"), session: join(home, "sessions") }, processEnvironment);
	const result = await runBoundedCommand(npm.command, [...npm.prefix, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", options.tarball], { cwd: project, env, timeoutMs: 120_000 });
	assertCommand(result, "isolated npm install");
	const installedRoot = join(project, "node_modules", PUBLIC_NAME);
	assertRegularFile(join(installedRoot, "package.json"), "installed package manifest");
	const manifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
	if (manifest.name !== PUBLIC_NAME || manifest.version !== PUBLIC_VERSION) fail("Installed package identity is not frozen");
	if (Object.hasOwn(manifest, "millwrightQualificationFixture")) fail("Artifact-controlled qualification fixture marker is forbidden");
	const provenancePath = join(installedRoot, "PROVENANCE.json");
	if (!existsSync(provenancePath)) fail("Installed package is missing PROVENANCE.json");
	const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
	if (provenance.sourceCommit !== options.sourceCommit) fail("Installed provenance source commit mismatch");
	return { project, installedRoot, manifest, installResult: result };
}

function launcherClientHelperSource() {
	return `const { spawn, spawnSync } = require("node:child_process");
const { readFileSync, renameSync, writeFileSync } = require("node:fs");

const markerPath = process.env.MWQ_LAUNCHER_MARKER;
const [cli, ...args] = process.argv.slice(2);

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function processStartId(pid) {
	if (!processAlive(pid)) return null;
	try {
		const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (fields[19]) return "proc:" + fields[19];
	} catch {}
	const value = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } });
	return value.status === 0 && value.stdout.trim() ? "ps:" + value.stdout.trim() : null;
}

function processGroup(pid) {
	const value = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" });
	const group = Number.parseInt(value.stdout?.trim() || "", 10);
	return Number.isInteger(group) && group > 0 ? group : null;
}

function writeMarker(value) {
	const temporary = markerPath + ".tmp-" + process.pid;
	writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
	renameSync(temporary, markerPath);
}

if (!markerPath || !cli) {
	console.error("launcher client helper is missing its marker or CLI");
	process.exitCode = 1;
} else {
	const child = spawn(cli, args, { env: process.env, stdio: "inherit" });
	const identity = { pid: child.pid ?? null, startId: child.pid ? processStartId(child.pid) : null, processGroup: child.pid ? processGroup(child.pid) : null };
	child.once("error", (error) => {
		writeMarker({ ...identity, exitCode: null, signal: null, error: String(error) });
		process.exitCode = 1;
	});
	child.once("exit", (code, signal) => {
		writeMarker({ ...identity, exitCode: code, signal: signal ?? null });
		process.exitCode = typeof code === "number" ? code : 1;
	});
}
`;
}

function wrapper(path, kind, helperPath) {
	const body = kind === "tui"
		? '#!/bin/sh\nexec "$MWQ_CLI" --no-session\n'
		: `#!/bin/sh\nexec "$MWQ_NODE" "$MWQ_LAUNCHER_HELPER" "$MWQ_CLI" --print --offline --daemon-socket "$MWQ_SOCKET" ${shellQuote(LAUNCHER_PRINT_COMMAND)}\n`;
	writeFileSync(path, body, { mode: 0o700 });
	if (kind === "launcher") writeFileSync(helperPath, launcherClientHelperSource(), { mode: 0o600 });
}

function launcherClientEvidence(markerPath, result) {
	if (!existsSync(markerPath)) fail("Installed launcher did not write a completed client identity marker");
	let marker;
	try { marker = JSON.parse(readFileSync(markerPath, "utf8")); } catch { fail("Installed launcher client identity marker was invalid"); }
	if (!Number.isInteger(marker?.pid) || marker.pid <= 0 || typeof marker.startId !== "string" || !marker.startId || !Number.isInteger(marker.processGroup) || marker.processGroup <= 0) {
		fail(`Installed launcher client identity marker was incomplete: ${JSON.stringify(marker)}`);
	}
	const observed = result.cleanup.observedDescendants.find((identity) => identity.pid === marker.pid && identity.startId === marker.startId);
	if (!observed || observed.processGroup !== marker.processGroup) fail("Installed launcher client marker was not bound to an observed process identity");
	const signal = marker.signal ?? null;
	if (marker.exitCode !== result.code || signal !== (result.signal ?? null)) fail("Installed launcher client exit evidence did not match the PTY command result");
	if (marker.exitCode !== 0 || signal !== null) fail(`Installed launcher client did not exit successfully: ${JSON.stringify({ exitCode: marker.exitCode, signal })}`);
	if (identityAlive(marker)) fail("Installed launcher client remained alive after its PTY parent exited");
	return { pid: marker.pid, startId: marker.startId, processGroup: marker.processGroup, exitCode: marker.exitCode, signal };
}

async function runPty(cli, roots, environment, kind) {
	const path = join(roots.base, `${kind}-wrapper.sh`);
	const helperPath = join(roots.base, `${kind}-launcher-helper.cjs`);
	const markerPath = join(roots.base, "launcher-client.json");
	wrapper(path, kind, helperPath);
	const invocation = ptyInvocation(process.platform, path);
	const env = {
		...environment,
		MWQ_CLI: cli,
		...(kind === "tui"
			? { MILLWRIGHT_STARTUP_BENCHMARK: "1", MILLWRIGHT_TIMING: "1" }
			: { MWQ_SOCKET: roots.socket, MWQ_NODE: process.execPath, MWQ_LAUNCHER_HELPER: helperPath, MWQ_LAUNCHER_MARKER: markerPath }),
	};
	const result = await runBoundedCommand(invocation.command, invocation.args, { cwd: roots.project, env, timeoutMs: kind === "tui" ? TUI_TIMEOUT_MS : 20_000, retainDescendants: kind === "launcher" });
	if (kind === "launcher" && !result.timedOut && result.code === 0) launcherClientEvidence(markerPath, result);
	return result;
}

function socketExists(path) {
	try { return lstatSync(path).isSocket(); } catch { return false; }
}

function managedSpawn(command, args, options) {
	const scoped = scopedProcessEnvironment(options.env);
	const child = spawn(command, args, { cwd: options.cwd, env: scoped.environment, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
	let stdout = Buffer.alloc(0);
	let stderr = Buffer.alloc(0);
	child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, MAX_OUTPUT_BYTES); });
	child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, MAX_OUTPUT_BYTES); });
	const group = child.pid ? processGroup(child.pid) : null;
	return { child, stdout: () => stdout.toString("utf8"), stderr: () => stderr.toString("utf8"), identity: { pid: child.pid ?? null, startId: child.pid ? processStartId(child.pid) : null, processGroup: group }, group, processRegistry: scoped.registry, processScope: scoped.scope };
}

async function stopManaged(managed) {
	await stopOwnedIdentity(managed.identity);
}

async function stopOwnedIdentity(identity) {
	if (!identityAlive(identity)) return true;
	signalOwnedIdentity(identity, "SIGTERM");
	if (await waitUntil(() => !identityAlive(identity), 3000)) return true;
	signalOwnedIdentity(identity, "SIGKILL");
	return waitUntil(() => !identityAlive(identity), 1500);
}

async function statusFor(cli, roots, env) {
	const status = await runBoundedCommand(cli, ["status", "--json"], { cwd: roots.project, env, timeoutMs: 10_000 });
	assertCommand(status, "installed status --json");
	let rows;
	try { rows = JSON.parse(status.stdout); } catch { fail("installed status returned invalid JSON"); }
	if (!Array.isArray(rows)) fail("installed status JSON must be an array");
	return { command: status, rows };
}

function matchingStatusRows(rows, roots) {
	return rows.filter((row) => resolve(row.socketPath ?? row.socket ?? "") === resolve(roots.socket));
}

function assertCurrentStatusRow(row, managed) {
	if (row.status !== "current") fail("Installed daemon status must be current");
	const candidates = [
		{ pid: row.supervisorPid, startId: row.supervisorProcessStartId ?? (row.supervisorPid ? processStartId(row.supervisorPid) : undefined) },
		{ pid: row.pid, startId: row.processStartId ?? (row.pid ? processStartId(row.pid) : undefined) },
	].filter(({ pid, startId }) => Number.isInteger(pid) && pid > 0 && typeof startId === "string" && startId.length > 0)
		.map((identity) => ({ ...identity, processGroup: processGroup(identity.pid) }));
	if (candidates.length === 0 || candidates.some((identity) => !identityAlive(identity))) fail(`Installed daemon status identity is invalid: ${JSON.stringify({ candidates, current: candidates.map(({ pid }) => processStartId(pid)) })}`);
	if (!managed) return candidates[0];
	const matching = candidates.find((identity) => identity.pid === managed.identity.pid && identity.startId === managed.identity.startId);
	if (!matching) fail("Installed daemon status does not correspond to the managed launcher identity");
	return matching;
}

function socketListenerIdentity(socketPath) {
	if (!socketExists(socketPath)) return null;
	const result = spawnSync("lsof", ["-n", "-t", "--", socketPath], { encoding: "utf8" });
	if (result.status !== 0) return null;
	const pids = [...new Set(result.stdout.split(/\s+/u).filter(Boolean).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
	if (pids.length !== 1) fail("Task-owned daemon socket must have exactly one listener");
	const pid = pids[0];
	return { pid, startId: processStartId(pid), processGroup: processGroup(pid) };
}

async function waitForCaseDaemon(cli, roots, env, managed, observe) {
	let observed = [];
	let matchedIdentity;
	const ready = await waitUntil(async () => {
		if (managed && (managed.child.exitCode !== null || managed.child.signalCode !== null)) return false;
		const listener = socketListenerIdentity(roots.socket);
		if (listener?.startId) observe?.(listener);
		try {
			const status = await statusFor(cli, roots, env);
			observed = status.rows;
			const matches = matchingStatusRows(observed, roots);
			if (matches.length > 1) fail("Installed status returned duplicate task-owned daemon rows");
			if (matches.length !== 1) return false;
			matchedIdentity = assertCurrentStatusRow(matches[0], managed);
			observe?.(matchedIdentity);
			return true;
		} catch (error) {
			if (socketExists(roots.socket)) throw error;
			return false;
		}
	}, 15_000, 100);
	if (!ready) fail(`Installed daemon did not become visible for ${basename(roots.base)}${managed ? `: ${managed.stderr()}` : ""}`);
	if (observed.length !== 1) fail("Unrelated daemon was visible in the isolated status result");
	return { identity: matchedIdentity, row: matchingStatusRows(observed, roots)[0] };
}

function caseSummary(id, roots, launcher, daemon, beforeDescendants, afterDescendants, observed, cleanup) {
	return {
		id,
		launcher,
		daemon,
		processGroup: daemon?.processGroup ?? null,
		descendantIdentitiesBefore: beforeDescendants,
		descendantIdentitiesAfter: afterDescendants,
		socketPath: `$TEMP/${basename(roots.socket)}`,
		socketStateBefore: false,
		socketStateAfter: socketExists(roots.socket),
		observedExit: observed?.exitCode ?? null,
		observedSignal: observed?.signal ?? null,
		cleanup,
	};
}

function liveRegisteredProcesses(owner) {
	return registeredIdentities(owner?.processRegistry, owner?.processScope).filter((identity) => {
		if (!identityAlive(identity)) return false;
		if (processGroup(identity.pid) !== identity.processGroup) fail("Registered task-owned process changed process group");
		return true;
	});
}

function ownedDaemonDescendants(owner, daemon, launcher) {
	return mergeIdentities(daemon?.pid ? descendantsOf(daemon.pid) : [], liveRegisteredProcesses(owner)).filter((identity) =>
		identityAlive(identity) &&
		(identity.pid !== daemon?.pid || identity.startId !== daemon?.startId) &&
		(identity.pid !== launcher?.pid || identity.startId !== launcher?.startId));
}

function assertRegisteredTransition(owner, message) {
	const living = liveRegisteredProcesses(owner);
	if (living.length) fail(`Registered task-owned process ${living.map(({ pid, startId, processGroup }) => `${pid}/${startId}/${processGroup}`).join(", ")} did not stop during ${message}`);
}

async function runDaemonCases(cli, options, tracked) {
	const daemonTemporary = createTaskOwnedShortTmpAlias(options.temporaryRoot);
	tracked.daemonTemporaryAliases.add(daemonTemporary);
	const daemonTemporaryRoot = daemonTemporary.alias;
	const daemonSocketDirectory = join(daemonTemporaryRoot, `millwright-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
	const cases = [];
	for (const id of DAEMON_CASE_IDS) {
		const roots = rootSet(options.temporaryRoot, `daemon-${id}`, daemonSocketDirectory);
		const legacy = createLegacySentinels(roots);
		const env = sanitizeEnvironment(process.env, roots, { ...(options.daemonEnvironment ?? {}), ...options.processEnvironment, TMPDIR: daemonTemporaryRoot });
		if (socketExists(roots.socket)) fail(`Daemon case socket was not fresh: ${id}`);
		tracked.sockets.add(roots.socket);
		if (id === "startup-validation-failure") {
			const unsafeAgent = join(roots.home, ".prime", "unsafe-state");
			mkdirSync(unsafeAgent, { recursive: true });
			const failed = await runBoundedCommand(cli, ["--mode", "daemon", "--daemon-socket", roots.socket], { cwd: roots.project, env: { ...env, MILLWRIGHT_CODING_AGENT_DIR: unsafeAgent }, timeoutMs: 10_000 });
			if (failed.code === 0 || failed.timedOut) fail("startup-validation-failure did not fail safely");
			if (socketExists(roots.socket)) fail("startup-validation-failure left a socket");
			cases.push(caseSummary(id, roots, failed.identity, null, [], [], { exitCode: failed.code, signal: failed.signal }, { legacyUnchanged: verifyLegacySentinels(legacy), residualPids: failed.cleanup.residualPids, residualSockets: [] }));
			continue;
		}
		if (id === "launcher-parent-exit") {
			let daemon;
			let parent;
			try {
				parent = await runPty(cli, roots, env, "launcher");
				for (const identity of parent.cleanup.observedDescendants.filter(identityAlive)) tracked.launcherDaemons.add(identity);
				assertCommand(parent, "installed launcher parent PTY");
				const observed = await waitForCaseDaemon(cli, roots, env, undefined, (identity) => {
					if (!daemon) {
						daemon = identity;
						tracked.launcherDaemons.add(daemon);
					}
				});
				daemon ??= observed.identity;
				const before = ownedDaemonDescendants(parent, daemon, parent.identity);
				const shutdown = await runBoundedCommand(cli, ["shutdown", "--force", "--json"], { cwd: roots.project, env, timeoutMs: 15_000 });
				assertCommand(shutdown, "installed shutdown --force --json");
				const transitioned = await waitUntil(() => !socketExists(roots.socket) && !identityAlive(daemon) && liveRegisteredProcesses(parent).length === 0, 5000);
				if (!transitioned) {
					assertRegisteredTransition(parent, "launcher shutdown");
					fail("Launcher daemon did not stop within the bounded transition");
				}
				const after = ownedDaemonDescendants(parent, daemon, parent.identity);
				cases.push(caseSummary(id, roots, parent.identity, daemon, before, after, { exitCode: parent.code, signal: parent.signal }, { legacyUnchanged: verifyLegacySentinels(legacy), residualPids: after.map(({ pid }) => pid), residualSockets: socketExists(roots.socket) ? ["daemon.sock"] : [] }));
			} finally {
				if (daemon && await stopOwnedIdentity(daemon)) tracked.launcherDaemons.delete(daemon);
			}
			continue;
		}
		const managed = managedSpawn(cli, ["--mode", "daemon", "--daemon-socket", roots.socket], { cwd: roots.project, env });
		tracked.children.add(managed);
		let listener;
		const observed = await waitForCaseDaemon(cli, roots, env, managed, (identity) => {
			if (!listener) {
				listener = identity;
				tracked.launcherDaemons.add(identity);
			}
		});
		const daemon = observed.identity;
		const before = ownedDaemonDescendants(managed, daemon, managed.identity);
		if (id === "clean-stop") {
			const shutdown = await runBoundedCommand(cli, ["shutdown", "--force", "--json"], { cwd: roots.project, env, timeoutMs: 15_000 });
			assertCommand(shutdown, "installed shutdown --force --json");
		} else if (daemon.pid) {
			process.kill(daemon.pid, "SIGTERM");
		}
		const transitioned = await waitUntil(() => !socketExists(roots.socket) && !identityAlive(daemon) && liveRegisteredProcesses(managed).length === 0, 5000);
		if (!transitioned) {
			assertRegisteredTransition(managed, `${id} transition`);
			fail("Daemon did not stop within the bounded transition");
		}
		await stopManaged(managed);
		tracked.children.delete(managed);
		const after = ownedDaemonDescendants(managed, daemon, managed.identity);
		cases.push(caseSummary(id, roots, managed.identity, daemon, before, after, { exitCode: managed.child.exitCode, signal: managed.child.signalCode }, { legacyUnchanged: verifyLegacySentinels(legacy), residualPids: after.map(({ pid }) => pid), residualSockets: socketExists(roots.socket) ? ["daemon.sock"] : [] }));
	}
	for (const entry of cases) {
		if (!entry.cleanup.legacyUnchanged || entry.cleanup.residualPids.length || entry.cleanup.residualSockets.length || entry.socketStateAfter) fail(`Daemon case cleanup failed: ${entry.id}`);
	}
	return { details: { cases }, stdout: JSON.stringify(cases.map(({ id }) => id)), stderr: "", exitCode: 0 };
}

async function kernelProbe(installedRoot, roots, env, fixture) {
	const runtime = join(installedRoot, "dist", "prime-agent-runtime");
	if (!existsSync(runtime)) fail("Installed prime-agent-runtime is missing");
	const bootstrap = join(installedRoot, "dist", "core", "kernel", "bootstrap.js");
	if (!existsSync(bootstrap)) fail("Installed kernel bootstrap is missing");
	if (fixture) return { details: { bootstrap: "dist/core/kernel/bootstrap.js", runtime: "dist/prime-agent-runtime", importBelowInstalledRuntime: true, sourcePythonPath: false }, stdout: "fixture rlm", stderr: "", exitCode: 0 };
	const uv = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin")]
		.map((directory) => join(directory, process.platform === "win32" ? "uv.exe" : "uv"))
		.find((path) => existsSync(path) && statSync(path).isFile());
	if (!uv) fail("uv executable is unavailable");
	const venv = join(roots.python, "venv");
	let result = await runBoundedCommand(uv, ["venv", venv], { cwd: roots.project, env, timeoutMs: 60_000 });
	assertCommand(result, "uv venv");
	const python = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
	result = await runBoundedCommand(uv, ["pip", "install", "--python", python, "--no-deps", "--editable", runtime], { cwd: roots.project, env, timeoutMs: 90_000 });
	assertCommand(result, "uv pip install installed runtime");
	const imported = await runBoundedCommand(python, ["-c", "import json, pathlib, rlm; print(json.dumps({'path': str(pathlib.Path(rlm.__file__).resolve())}))"], { cwd: roots.project, env, timeoutMs: 20_000 });
	assertCommand(imported, "installed rlm import");
	const modulePath = JSON.parse(imported.stdout).path;
	if (!isWithin(realpathSync(runtime), realpathSync(modulePath))) fail(`rlm imported outside the installed runtime: ${modulePath}`);
	return { details: { bootstrap: "dist/core/kernel/bootstrap.js", runtime: "dist/prime-agent-runtime", importBelowInstalledRuntime: true, sourcePythonPath: false }, stdout: imported.stdout, stderr: `${result.stderr}${imported.stderr}`, exitCode: imported.code };
}

const IDENTITY_SURFACES = [
	"commandTuiOutput", "updaterText", "daemonDiagnostics", "telemetryAcpMetadata", "installedSkills",
	"packageMetadata", "shippedDocsExamples", "settingsRefinementDefaults", "observedStateTrees", "kernelRuntimeDiscovery",
];

const IDENTITY_FILE_CEILING = 100_000;
const IDENTITY_BYTE_CEILING = 16 * 1024 * 1024;

function identityFiles(root, predicate, label) {
	const files = [];
	const visit = (path) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) visit(child);
			else if (entry.isFile() && predicate(child)) {
				files.push(child);
				if (files.length > IDENTITY_FILE_CEILING) fail(`Identity corpus ${label} exceeded the declared file ceiling`);
			}
		}
	};
	if (existsSync(root)) visit(root);
	return files.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

function readBoundedIdentityFile(path, remaining, label) {
	const descriptor = openSync(path, "r");
	try {
		const size = fstatSync(descriptor).size;
		if (size > remaining) fail(`Identity corpus ${label} exceeded the declared byte ceiling`);
		const value = Buffer.alloc(size);
		let offset = 0;
		while (offset < size) {
			const count = readSync(descriptor, value, offset, size - offset, offset);
			if (count === 0) break;
			offset += count;
		}
		if (offset !== size || readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) fail(`Identity corpus ${label} changed during its bounded read`);
		return value;
	} finally {
		closeSync(descriptor);
	}
}

function boundedEntries(files, root, label) {
	if (files.length > IDENTITY_FILE_CEILING) fail(`Identity corpus ${label} exceeded the declared file ceiling`);
	let remaining = IDENTITY_BYTE_CEILING;
	return files.map((path) => {
		const value = readBoundedIdentityFile(path, remaining, label);
		remaining -= value.length;
		return { path: relative(root, path).split(sep).join("/"), text: value.toString("utf8") };
	});
}

function isCurrentProductPi(line) {
	return /\bcommand\s*:\s*["']pi["']|\bpi\s+-[A-Za-z]\b|\bpi\s+--[A-Za-z][A-Za-z0-9-]*\b|\b(?:start|use|invoke|inside|exit)\s+(?:the\s+)?pi\b|\bpi(?:['’]s|s')\s+(?:default|current|active|primary|main)\b|\b(?:notify|setTitle|setLabel)\s*\(\s*["']Pi["']/iu.test(line);
}

function hasBrandedPi(line) {
	return isCurrentProductPi(line) || /@earendil-works\/pi-|\bpi-(?:mono|skills|package|agent|coding-agent|ai|tui)\b|(?:^|[\s`'"(])(?:~\/)?\.pi(?:[\s`'"/.)]|$)|["']pi["']\s*[:=]|\bpi\s+(?:CLI|command|package|manifest|API|product|agent|is\b)|\bpi\.(?:on|ui|register|send|get|set|exec|append|events|prompts|skills|themes)[A-Za-z0-9_]*\b|\b(?:use|run|invoke)\s+(?:the\s+)?pi\b/iu.test(line);
}

function identityTokens(line) {
	const tokens = new Set();
	for (const match of line.matchAll(/Prime Agent|prime-agent(?:-[A-Za-z0-9._-]+)?|\bPrime\b|\bprime\b|\bPI_[A-Z][A-Z0-9_]*\b/gu)) tokens.add(match[0]);
	if (hasBrandedPi(line)) {
		for (const match of line.matchAll(/@earendil-works\/pi-[A-Za-z0-9._-]+|\b(?:Pi|pi)\b|(?:^|\s)(?:~\/)?\.pi(?:[/A-Za-z0-9._-]*)/gu)) {
			const token = match[0].trim();
			if (token) tokens.add(token);
		}
	}
	return [...tokens];
}

function classifyC001Identity(path, line, token) {
	const lower = `${path}\n${line}`.toLowerCase();
	const generated = path.startsWith("dist/bundle/") || path.startsWith("dist/core/export-html/vendor/") || /sourceMappingURL=/.test(line);
	if (path.startsWith("skills/prime-intellect/") || (generated && path.startsWith("dist/skills/prime-intellect/"))) return "provider";
	if (/prime agent traces|prime agent trace|prime-agent-traces|agent-traces|x-prime-team-id/.test(lower) || (token === "prime" && path.includes("telemetry"))) return "provider";
	if (/\.prime|\.millrace-cli/.test(lower)) return "private-internal";
	if (/prime-agent-runtime|prime-agent-skill-|application\/vnd\.prime-agent|ai\.primeintellect\.prime-agent|prime-agent\.sh|prime-agent\.(?:refinement|daemon|worker_|update_)|daemon worker|daemon supervisor|currenttheme/.test(lower)) return "private-internal";
	if (token === "Prime Agent" || token === "prime-agent") return /upstream|provenance|attribution|fork|imported|lineage|license|notice|snapshot|derived|github.com\/primeintellect-ai\/prime-agent/.test(lower) ? "provenance" : "unclassified";
	if ((token === "Prime" || token === "prime") && /\b(?:current|default)\s+(?:application|command|product|agent|name)\b|\b(?:Pi|pi|Prime|prime)\s+is\s+(?:the\s+)?(?:current|default)\b/.test(lower)) return "unclassified";
	if (/^prime_agent_traces_|\bprime_agent_traces_/.test(token.toLowerCase())) return "provider";
	if (/^pi_(?:tui_write_log|timing)$/iu.test(token)) return "private-internal";
	if (/^PI_[A-Z][A-Z0-9_]*$/.test(token) && (!generated || /\b(?:env(?:ironment)?|config(?:uration)?|state|setting|current|millwright)\b/.test(lower))) return "unclassified";
	if (/prime-butterfly|assets\/brand|prime-logo|prime brand/.test(lower)) return "attribution";
	if (/(?:^|\/)prime-(?:team-selector|onboarding-splash)|(?:^|\/)theme(?:\/|\.|$)/.test(lower)) return "private-internal";
	if (/@earendil-works\/pi-|\bpi-(?:mono|skills|package|agent|coding-agent|ai|tui)\b|\bpi\.(?:on|ui|register|send|get|set|exec|append|events|prompts|skills|themes)\b|\b(?:Pi|pi)\b/.test(token)) {
		if (/upstream|provenance|attribution|fork|imported|lineage|license|notice|pi-mono|pi skills|snapshot/.test(lower)) return "provenance";
		if ((token === "Pi" || token === "pi") && (isCurrentProductPi(line) || /\b(?:current|default)\s+(?:application|command|product|agent|name)\b|\b(?:Pi|pi|Prime|prime)\s+is\s+(?:the\s+)?(?:current|default)\b/.test(lower))) return "unclassified";
		if (/@earendil-works\/pi-|\bpi-(?:mono|skills|package|agent|coding-agent|ai|tui)\b|\bpi\s+packages?\b|\bpi\s+manifest\b|\bpi\.(?:on|ui|register|send|get|set|exec|append|events|prompts|skills|themes)[A-Za-z0-9_]*\b|(?:^|[\s`'"(])(?:~\/)?\.pi(?:[\s`'"/.)]|$)|["']pi["']\s*[:=]/.test(lower)) return "private-internal";
		return generated ? "generated/vendor" : "unclassified";
	}
	if (/prime inference|prime-inference|prime api|primeintellect\.ai|prime intellect|prime-intellect|prime cli|prime-rl|prime team|prime provider/.test(lower)) return "provider";
	if (/upstream|provenance|attribution|fork|imported|lineage|license|notice|snapshot|derived|github.com\/primeintellect-ai\/prime-agent/.test(lower)) return "provenance";
	return generated ? "generated/vendor" : "unclassified";
}

function classifyIdentity(entries) {
	const counts = {
		"public-millwright-identity": 0,
		"retained-internal-compatibility-identity": 0,
		"provider-specific-prime-identity": 0,
		"required-attribution-or-provenance": 0,
		"forbidden-accidental-identity": 0,
	};
	let unclassified = 0;
	for (const { path, text } of entries) {
		counts["public-millwright-identity"] += (text.match(/\bMillwright\b/gu) ?? []).length;
		for (const line of text.split(/\r?\n/u)) {
			for (const token of identityTokens(line)) {
				const classification = classifyC001Identity(path, line, token);
				if (classification === "provider") counts["provider-specific-prime-identity"]++;
				else if (classification === "provenance" || classification === "attribution") counts["required-attribution-or-provenance"]++;
				else if (classification === "unclassified") { counts["forbidden-accidental-identity"]++; unclassified++; }
				else counts["retained-internal-compatibility-identity"]++;
			}
		}
	}
	return { counts, unclassified };
}

function identityProbe(installedRoot, commandOutput, temporaryRoot, fixture) {
	const textFile = (path) => /\.(?:c?js|mjs|ts|tsx|json|md|txt|yaml|yml|toml|py)$/iu.test(path);
	const stateRoots = existsSync(join(temporaryRoot, "cases"))
		? readdirSync(join(temporaryRoot, "cases"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
			.flatMap((entry) => ["home", "project", "sessions", "session-artifacts"].map((name) => join(temporaryRoot, "cases", entry.name, name)))
		: [];
	const daemonStateRoots = DAEMON_CASE_IDS.flatMap((id) => ["home", "project", "sessions"].map((name) => join(temporaryRoot, "cases", `daemon-${id}`, name)));
	const observedStateTree = stateRoots.flatMap((root) => identityFiles(root, () => true, "observedStateTrees")).map((path) => relative(temporaryRoot, path).split(sep).join("/")).sort((left, right) => Buffer.from(left).compare(Buffer.from(right))).join("\n");
	if (Buffer.byteLength(observedStateTree) > IDENTITY_BYTE_CEILING) fail("Identity corpus observedStateTrees exceeded the declared byte ceiling");
	const metadataPaths = ["package.json", "PROVENANCE.json", "UPSTREAM.json", "NOTICE", "THIRD_PARTY_NOTICES.md"].map((path) => join(installedRoot, path)).filter(existsSync);
	const surfaces = {
		commandTuiOutput: [{ path: "command-output", text: commandOutput }],
		updaterText: boundedEntries(identityFiles(join(installedRoot, "dist"), (path) => textFile(path) && /(?:config|package-manager|update)/u.test(path), "updaterText"), installedRoot, "updaterText"),
		daemonDiagnostics: boundedEntries(daemonStateRoots.flatMap((root) => identityFiles(root, (path) => (textFile(path) || /\.log$/iu.test(path)) && /(?:daemon|diagnostic|log)/iu.test(basename(path)), "daemonDiagnostics")), temporaryRoot, "daemonDiagnostics"),
		telemetryAcpMetadata: boundedEntries(identityFiles(join(installedRoot, "dist"), (path) => textFile(path) && /(?:telemetry|agent-traces|acp-meta)/u.test(path), "telemetryAcpMetadata"), installedRoot, "telemetryAcpMetadata"),
		installedSkills: boundedEntries([...identityFiles(join(installedRoot, "skills"), textFile, "installedSkills"), ...identityFiles(join(installedRoot, "dist", "skills"), textFile, "installedSkills")], installedRoot, "installedSkills"),
		packageMetadata: boundedEntries(metadataPaths, installedRoot, "packageMetadata"),
		shippedDocsExamples: boundedEntries([...identityFiles(join(installedRoot, "docs"), textFile, "shippedDocsExamples"), ...identityFiles(join(installedRoot, "examples"), textFile, "shippedDocsExamples"), ...(existsSync(join(installedRoot, "README.md")) ? [join(installedRoot, "README.md")] : [])], installedRoot, "shippedDocsExamples"),
		settingsRefinementDefaults: boundedEntries(identityFiles(join(installedRoot, "dist", "core"), (path) => textFile(path) && /(?:settings-manager|refinement|slash-commands)/u.test(path), "settingsRefinementDefaults"), installedRoot, "settingsRefinementDefaults"),
		observedStateTrees: [{ path: "observed-state-tree", text: observedStateTree }],
		kernelRuntimeDiscovery: boundedEntries(identityFiles(join(installedRoot, "dist", "prime-agent-runtime"), textFile, "kernelRuntimeDiscovery"), installedRoot, "kernelRuntimeDiscovery"),
	};
	const perSurface = IDENTITY_SURFACES.map((id) => {
		const entries = surfaces[id] ?? [];
		const corpus = entries.map(({ path, text }) => `${path}\n${text}`).join("\n");
		const classified = classifyIdentity(entries);
		return { id, sha256: sha256(corpus), hitCount: Object.values(classified.counts).reduce((sum, count) => sum + count, 0), classificationCounts: classified.counts, unclassifiedHits: classified.unclassified };
	});
	const classificationCounts = Object.fromEntries(Object.keys(perSurface[0].classificationCounts).map((key) => [key, perSurface.reduce((sum, surface) => sum + surface.classificationCounts[key], 0)]));
	const unclassifiedHits = perSurface.reduce((sum, surface) => sum + surface.unclassifiedHits, 0);
	if (!fixture && (classificationCounts["forbidden-accidental-identity"] !== 0 || unclassifiedHits !== 0)) {
		fail(`Installed identity scan found forbidden or unclassified product identity: ${JSON.stringify({ classificationCounts, unclassifiedHits, surfaces: perSurface.filter(({ unclassifiedHits: count }) => count > 0).map(({ id, hitCount, unclassifiedHits: count }) => ({ id, hitCount, unclassifiedHits: count })) })}`);
	}
	return { surfaces: perSurface.map(({ unclassifiedHits: _unused, ...surface }) => surface), classificationCounts, unclassifiedHits, forbiddenHits: classificationCounts["forbidden-accidental-identity"] };
}

function removedBytes(path) {
	let total = 0;
	const visit = (current) => {
		if (!existsSync(current)) return;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const child = join(current, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) visit(child);
			else if (entry.isFile()) { try { total += statSync(child).size; } catch {} }
		}
	};
	visit(path);
	return total;
}

function legacySentinelFiles(root) {
	const files = [];
	const visit = (current) => {
		if (!existsSync(current)) return;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const child = join(current, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) visit(child);
			else if (entry.isFile() && entry.name === "sentinel.bin") files.push(child);
		}
	};
	visit(root);
	return files;
}

function atomicReport(path, report) {
	const temp = `${path}.tmp-${process.pid}`;
	try {
		writeFileSync(temp, `${JSON.stringify(report, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}

async function qualify(options, substitutions = {}) {
	const records = [];
	const tracked = { children: new Set(), launcherDaemons: new Set(), sockets: new Set(), daemonTemporaryAliases: new Set() };
	const secrets = secretValues(process.env);
	const redaction = { secrets, paths: [[options.temporaryRoot, "$TEMP"], [options.results, "$RESULTS"], [dirname(options.temporaryRoot), "$OUTER"], [homedir(), "$HOME"], [sourceRoot, "$SOURCE"]] };
	let installed;
	let processRegistry;
	let processEnvironment = {};
	let removed = 0;
	let commandOutput = "";
	try {
		mkdirSync(options.temporaryRoot);
		mkdirSync(options.results);
		processRegistry = createProcessRegistry(options.temporaryRoot);
		processEnvironment = processRegistryEnvironment(processRegistry);
		installed = await installTarball(options, rootSet(options.temporaryRoot, "install-environment"), processEnvironment);
		const cli = join(installed.project, "node_modules", ".bin", "millwright");
		assertInstalledExecutable(cli, installed.installedRoot);
		const entries = validateEntrypoints(installed.installedRoot, installedEntrypoints(installed.installedRoot));
		for (const id of ["help", "version"]) {
			const roots = rootSet(options.temporaryRoot, id);
			const env = sanitizeEnvironment(process.env, roots, processEnvironment);
			const args = id === "help" ? ["--help"] : ["--version"];
			const current = await record(id, async () => {
				const result = await runBoundedCommand(cli, args, { cwd: roots.project, env, timeoutMs: 15_000 });
				assertCommand(result, `installed ${id}`);
				const output = `${result.stdout}\n${result.stderr}`;
				if (id === "help" && !/millwright/iu.test(output)) fail("Installed help is not Millwright-branded");
				if (id === "version" && !output.includes(PUBLIC_VERSION)) fail("Installed version is not 0.0.3");
				commandOutput += output;
				return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code, details: { product: "Millwright", ...(id === "version" ? { version: PUBLIC_VERSION } : {}) } };
			}, redaction);
			records.push(current);
		}
		{
			const roots = rootSet(options.temporaryRoot, "tui");
			const legacy = createLegacySentinels(roots);
			const env = sanitizeEnvironment(process.env, roots, processEnvironment);
			records.push(await record("tui", async () => {
				const result = await runPty(cli, roots, env, "tui");
				assertCommand(result, "installed offline TUI");
				if (!/interactiveMode\.init/iu.test(`${result.stdout}\n${result.stderr}`)) fail("Installed TUI did not emit interactiveMode.init readiness evidence");
				if (result.cleanup.reapedPids.length || result.cleanup.residualPids.length) fail("Installed TUI left residual child processes");
				if (!verifyLegacySentinels(legacy)) fail("TUI changed legacy state");
				commandOutput += `${result.stdout}\n${result.stderr}`;
				return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code, details: { realPty: true, timingEnabled: true, initialized: true, readiness: "interactiveMode.init", startupBenchmark: true, offline: true, noSession: true, legacyUnchanged: true } };
			}, redaction));
		}
		for (const [id, mode] of [["configState", "config"], ["sessionState", "session"], ["skillDiscovery", "skills"]]) {
			const roots = rootSet(options.temporaryRoot, id);
			const legacy = createLegacySentinels(roots);
			const env = sanitizeEnvironment(process.env, roots, processEnvironment);
			records.push(await record(id, async () => {
				const result = substitutions.qualifyInstalledState ? await substitutedStateProbe(substitutions.qualifyInstalledState, mode, roots, installed.installedRoot) : await runStateProbe(mode, roots, installed.installedRoot, env);
				assertStateProbe(mode, result.details);
				if (!verifyLegacySentinels(legacy)) fail(`${id} changed legacy state`);
				return { ...result, details: { ...result.details, entrypoints: entries.filter((path) => id === "configState" ? /config|settings/u.test(path) : id === "sessionState" ? /session/u.test(path) : /skills/u.test(path)), legacyUnchanged: true } };
			}, redaction));
		}
		{
			const roots = rootSet(options.temporaryRoot, "kernelDiscovery");
			const env = sanitizeEnvironment(process.env, roots, processEnvironment);
			records.push(await record("kernelDiscovery", () => substitutions.kernelProbe ? substitutions.kernelProbe(installed.installedRoot, roots, env) : kernelProbe(installed.installedRoot, roots, env, false), redaction));
		}
		records.push(await record("daemonLifecycle", () => runDaemonCases(cli, { ...options, daemonEnvironment: substitutions.daemonEnvironment, processEnvironment }, tracked), redaction));
		{
			const sentinels = legacySentinelFiles(options.temporaryRoot);
			const unchanged = sentinels.every((path) => readFileSync(path, "utf8").startsWith("legacy:") && readFileSync(path, "utf8").endsWith(":unchanged"));
			records.push(await record("legacyState", async () => {
				if (!unchanged) fail("Legacy state sentinel changed");
				return { details: { byteUnchanged: true, sentinelCount: sentinels.length, sentinelLocations: LEGACY_SENTINEL_LOCATIONS }, stdout: "", stderr: "", exitCode: null };
			}, redaction));
		}
		{
			const roots = rootSet(options.temporaryRoot, "refinementSafety");
			const legacy = createLegacySentinels(roots);
			const env = sanitizeEnvironment(process.env, roots, processEnvironment);
			records.push(await record("refinementSafety", async () => {
				const result = substitutions.qualifyInstalledState ? await substitutedStateProbe(substitutions.qualifyInstalledState, "refinement", roots, installed.installedRoot) : await runStateProbe("refinement", roots, installed.installedRoot, env);
				if (!verifyLegacySentinels(legacy)) fail("Refinement changed legacy state");
				if (result.details.freshEnabled !== false || result.details.explicitEnabled !== true || !result.details.commandPresent || !result.details.promptPath || !result.details.persisted) fail(`Installed refinement contract failed: ${JSON.stringify(result.details)}`);
				return { ...result, details: { ...result.details, providerCalls: 0, deterministicPlannerCalls: result.details.fauxCalls ?? 1, legacyUnchanged: true } };
			}, redaction));
		}
		records.push(await record("identity", async () => {
			if (substitutions.identityFailure) fail("synthetic identity assertion failure");
			const details = identityProbe(installed.installedRoot, commandOutput, options.temporaryRoot, substitutions.allowSyntheticIdentity === true);
			return { details, stdout: "", stderr: "", exitCode: null };
		}, redaction));
	} catch (error) {
		if (records.length < REPORT_IDS.length - 1) {
			for (const id of REPORT_IDS.slice(records.length, -1)) {
				records.push(await record(id, async () => { throw error; }, redaction));
			}
		}
	} finally {
		for (const managed of tracked.children) await stopManaged(managed);
		for (const identity of tracked.launcherDaemons) await stopOwnedIdentity(identity);
		if (processRegistry) for (const identity of registeredIdentities(processRegistry).filter(identityAlive)) await stopOwnedIdentity(identity);
		for (const socket of tracked.sockets) rmSync(socket, { force: true });
		for (const alias of tracked.daemonTemporaryAliases) removeTaskOwnedShortTmpAlias(alias, options.temporaryRoot);
		removed = removedBytes(options.temporaryRoot);
		removeOwnedRoot(options.temporaryRoot, { sourceRoot, home: homedir() });
		const residualPids = [
			...[...tracked.children].flatMap((managed) => managed.child.pid && processAlive(managed.child.pid) ? [managed.child.pid] : []),
			...[...tracked.launcherDaemons].filter(identityAlive).map(({ pid }) => pid),
			...(processRegistry ? [...processRegistry.identities.values()].filter(identityAlive).map(({ pid }) => pid) : []),
		];
		const residualSockets = [...tracked.sockets].filter(existsSync).map(basename);
		const residualAliases = [...tracked.daemonTemporaryAliases].filter(({ aliasContainer }) => existsSync(aliasContainer)).map(() => "$DAEMON_TMP_ALIAS");
		records.push(await record("cleanup", async () => {
			if (existsSync(options.temporaryRoot) || residualPids.length || residualSockets.length || residualAliases.length) fail("Driver cleanup left residual resources");
			return { details: { temporaryRootRemoved: true, removedRoots: ["$TEMP"], reclaimedBytes: removed, residualPids, residualSockets }, stdout: "", stderr: "", exitCode: null };
		}, redaction));
		if (processRegistry) processRegistries.delete(processRegistry.registryPath);
	}
	if (records.length !== REPORT_IDS.length || records.some((entry, index) => entry.id !== REPORT_IDS[index])) fail("Internal report order violation");
	const tarballBytes = readFileSync(options.tarball);
	const report = {
		schemaVersion: 1,
		sourceCommit: options.sourceCommit,
		artifact: { filename: basename(options.tarball), sha256: sha256(tarballBytes), integrity: sha512Integrity(tarballBytes) },
		toolchain: { node: process.versions.node, npm: spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout.trim() },
		platform: { os: platform(), release: release(), arch: process.arch },
		records,
	};
	atomicReport(join(options.results, "installed-qualification.json"), report);
	return report;
}

export async function qualifyInstalledArtifactForTest(options, substitutions) {
	if (!substitutions || typeof substitutions.qualifyInstalledState !== "function") fail("Explicit in-process test substitutions are required");
	return qualify(options, substitutions);
}

async function main() {
	const options = parseQualificationArgs(process.argv.slice(2));
	const report = await qualify(options);
	const failed = report.records.filter(({ status }) => status !== "passed").map(({ id }) => id);
	console.log(JSON.stringify({ report: join(options.results, "installed-qualification.json"), failed }));
	if (failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
