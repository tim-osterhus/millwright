import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import {
	DAEMON_CASE_IDS,
	REPORT_IDS,
	parseQualificationArgs,
	ptyInvocation,
	qualifyInstalledArtifactForTest,
	runBoundedCommand,
	sanitizeEnvironment,
	sha256,
} from "../qualify-installed-millwright.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const driver = resolve(root, "scripts/qualify-installed-millwright.mjs");
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SOURCE_COMMIT = "a".repeat(40);
const fixtureOptions = new Map();

function tempRoot(prefix = "millwright-c002-driver-test-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

function write(path, content, mode) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, mode === undefined ? undefined : { mode });
}

function fixtureCliSource(forceFailure) {
	return `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const forcedFailure = ${JSON.stringify(forceFailure)};
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const agentDir = process.env.MILLWRIGHT_CODING_AGENT_DIR;
const registry = agentDir && join(agentDir, "fixture-daemon.json");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const startId = (pid) => {
	try {
		const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (fields[19]) return "proc:" + fields[19];
	} catch {}
	const value = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
	return value.status === 0 && value.stdout.trim() ? "ps:" + value.stdout.trim() : undefined;
};
const readRegistry = () => { try { return JSON.parse(readFileSync(registry, "utf8")); } catch { return undefined; } };
const processGroup = (pid) => { const value = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" }); return Number.parseInt(value.stdout.trim(), 10); };

if (args.includes("--help")) { console.log("Millwright fixture help"); process.exit(0); }
if (args.includes("--version")) { console.log("0.0.1"); process.exit(0); }

if (args[0] === "--mode" && args[1] === "daemon") {
	const socketPath = value("--daemon-socket");
	if (!socketPath || !agentDir || agentDir.split(/[\\/]/u).some((part) => part === ".prime" || part === ".millrace-cli")) {
		console.error("unsafe startup state root");
		process.exit(2);
	}
	if (forcedFailure === "daemon-listener-descendant" && process.env.MWQ_LISTENER_CHILD !== "1") {
		const childEnvironment = { ...process.env, MWQ_LISTENER_CHILD: "1" };
		delete childEnvironment.NODE_OPTIONS;
		delete childEnvironment.MILLWRIGHT_QUALIFICATION_PROCESS_REGISTRY;
		delete childEnvironment.MILLWRIGHT_QUALIFICATION_PROCESS_TOKEN;
		delete childEnvironment.MILLWRIGHT_QUALIFICATION_PROCESS_SCOPE;
		const child = spawn(process.execPath, [process.argv[1], ...args], {
			detached: true, env: childEnvironment, stdio: "ignore",
		});
		if (process.env.MILLWRIGHT_QUALIFICATION_PROCESS_REGISTRY) {
			writeFileSync(process.env.MILLWRIGHT_QUALIFICATION_PROCESS_REGISTRY, "");
		}
		child.unref();
		setInterval(() => {}, 1000);
		await new Promise(() => {});
	}
	mkdirSync(dirname(socketPath), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	try { rmSync(socketPath, { force: true }); } catch {}
	const server = createServer((connection) => connection.end());
	const cleanup = () => {
		try { server.close(); } catch {}
		try { rmSync(socketPath, { force: true }); } catch {}
		try { rmSync(registry, { force: true }); } catch {}
		setTimeout(() => process.exit(0), 5).unref();
	};
	process.on("SIGTERM", cleanup);
	process.on("SIGINT", cleanup);
	const launched = process.env.MWQ_LAUNCHER_CHILD === "1";
	server.listen(socketPath, () => {
		mkdirSync(join(agentDir, "logs"), { recursive: true });
		writeFileSync(join(agentDir, "logs", "daemon.log"), "Millwright fixture daemon diagnostic\\n");
		writeFileSync(registry, JSON.stringify({ pid: process.pid, processStartId: startId(process.pid), socketPath, launched }));
		if (forcedFailure === "daemon-listener-descendant") {
			writeFileSync(process.env.MILLWRIGHT_QUALIFICATION_DAEMON_MARKER, JSON.stringify({ pid: process.pid, startId: startId(process.pid), processGroup: processGroup(process.pid), socketPath }));
		}
		if (launched && forcedFailure === "launcher-cleanup") writeFileSync(process.env.MILLWRIGHT_QUALIFICATION_LAUNCHER_MARKER ?? join(process.env.TMPDIR, "millwright-fixture-launcher.pid"), String(process.pid));
		if (forcedFailure === "daemon-detached-worker") {
			const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, env: process.env, stdio: "ignore" });
			writeFileSync(process.env.MILLWRIGHT_QUALIFICATION_WORKER_MARKER ?? join(process.env.TMPDIR, "millwright-fixture-worker.json"), JSON.stringify({ pid: worker.pid, startId: startId(worker.pid), processGroup: processGroup(worker.pid), socketPath, tmpdir: process.env.TMPDIR }));
			worker.unref();
		}
	});
	setInterval(() => {}, 1000);
} else if (args[0] === "status" && args.includes("--json")) {
	const record = readRegistry();
	const publicRecord = record ? { pid: record.pid, socketPath: record.socketPath, launched: record.launched } : undefined;
	const rows = publicRecord && alive(publicRecord.pid) ? [{ ...publicRecord, status: forcedFailure === "status-invalid" ? "stale" : "current", ...(forcedFailure === "status-mismatch" ? { processStartId: "ps:mismatched-start" } : {}) }] : [];
	if (forcedFailure === "status-duplicate" && rows.length === 1) rows.push({ ...rows[0] });
	if (forcedFailure === "launcher-cleanup" && record?.launched) rows.push({ pid: process.pid, socketPath: join(dirname(record.socketPath), "unrelated.s"), status: "reachable" });
	console.log(JSON.stringify(rows));
} else if (args[0] === "shutdown" && args.includes("--force") && args.includes("--json")) {
	const record = readRegistry();
	if (record && alive(record.pid) && forcedFailure !== "daemon-transition") process.kill(record.pid, "SIGTERM");
	const deadline = Date.now() + 3000;
	while (record && alive(record.pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
	console.log(JSON.stringify({ stopped: record ? [{ socketPath: record.socketPath }] : [], failed: [] }));
} else if (forcedFailure === "launcher-status" && process.env.MWQ_LAUNCHER_MARKER) {
	const marker = process.env.MILLWRIGHT_QUALIFICATION_LAUNCHER_MARKER;
	const identity = { pid: process.pid, startId: startId(process.pid), processGroup: processGroup(process.pid), tmpdir: process.env.TMPDIR };
	const command = args.at(-1);
	if (!marker) {
		console.error("fixture launcher marker output is missing");
		process.exit(6);
	}
	if (!args.includes("--print") || command !== "/goal status") {
		writeFileSync(marker, JSON.stringify({ ...identity, command, rejectedEmptyPrint: args.includes("--print") && command !== "/goal status" }));
		console.error("fixture launcher requires explicit /goal status");
		process.exit(4);
	}
	const socketPath = value("--daemon-socket");
	const child = spawn(process.execPath, [process.argv[1], "--mode", "daemon", "--daemon-socket", socketPath], {
		detached: true, env: { ...process.env, MWQ_LAUNCHER_CHILD: "1" }, stdio: "ignore",
	});
	child.unref();
	writeFileSync(marker, JSON.stringify({ ...identity, command, exitCode: 0 }));
	console.log("fixture public print command completed");
	process.exit(0);
} else if (process.env.MILLWRIGHT_QUALIFICATION_FIXTURE_CLIENT === "1") {
	const socketPath = value("--daemon-socket");
	const child = spawn(process.execPath, [process.argv[1], "--mode", "daemon", "--daemon-socket", socketPath], {
		detached: true, env: { ...process.env, MWQ_LAUNCHER_CHILD: "1" }, stdio: "ignore",
	});
	child.unref();
	console.log("fixture public client exited");
} else {
	if (!process.stdin.isTTY) { console.error("real PTY required"); process.exit(3); }
	console.log("Millwright fixture TUI initialized");
	if (forcedFailure !== "tui-no-init") console.log("MILLWRIGHT_TIMING interactiveMode.init 1ms");
}
`;
}

async function qualifyInstalledStateForTest({ roots, installedRoot }, forceFailure) {
	mkdirSync(roots.agent, { recursive: true });
	mkdirSync(roots.session, { recursive: true });
	mkdirSync(roots.project, { recursive: true });
	const sessionArtifactMarker = join(roots.base, "session-artifacts", "Prime Agent marker", "state.txt");
	mkdirSync(dirname(sessionArtifactMarker), { recursive: true });
	writeFileSync(sessionArtifactMarker, "Millwright session artifact fixture.\n");
	writeFileSync(join(roots.agent, "settings.json"), JSON.stringify({ autoRefine: { enabled: true } }));
	writeFileSync(join(roots.session, "fixture-session.jsonl"), "fixture session\\n");
	const skill = join(roots.project, "fixture-skill", "SKILL.md");
	mkdirSync(join(roots.project, "fixture-skill"), { recursive: true });
	writeFileSync(skill, "---\\nname: installed-fixture\\ndescription: fixture\\n---\\n");
	const result = {
		entrypoints: ["dist/index.js", "dist/config.js", "dist/core/settings-manager.js", "dist/core/session-manager.js", "dist/core/skills.js", "dist/core/slash-commands.js", "dist/core/refinement/index.js"].map((path) => join(installedRoot, path)),
		configState: { agentRootMatches: true, product: "Millwright", packageName: "millwright-agent", command: "millwright", freshAutoRefine: false },
		sessionState: { sessionRootMatches: true, persisted: true, entries: 1 },
		skillDiscovery: { names: ["installed-fixture"], diagnostics: 0 },
		refinementSafety: { freshEnabled: false, explicitEnabled: true, commandPresent: true, promptPath: true, persisted: readFileSync(join(roots.agent, "settings.json"), "utf8").includes("true"), fauxCalls: 1 },
	};
	if (forceFailure === "state-proofs") {
		result.configState.agentRootMatches = false;
		result.sessionState.persisted = false;
		result.skillDiscovery = { names: [], diagnostics: 1 };
	}
	return result;
}

function testSubstitutions(forceFailure, daemonEnvironment = {}) {
	return {
		qualifyInstalledState: (input) => qualifyInstalledStateForTest(input, forceFailure),
		kernelProbe: async () => ({ details: { bootstrap: "dist/core/kernel/bootstrap.js", runtime: "dist/prime-agent-runtime", importBelowInstalledRuntime: true, sourcePythonPath: false }, stdout: "fixture rlm", stderr: "", exitCode: 0 }),
		daemonEnvironment: { MILLWRIGHT_QUALIFICATION_FIXTURE_CLIENT: "1", ...daemonEnvironment },
		allowSyntheticIdentity: true,
		identityFailure: forceFailure === "identity",
	};
}

function createFixtureTarball(outer, { artifactMarker = false, forceFailure, oversizedIdentity = false, oversizedDaemonSupport = false } = {}) {
	const packageRoot = join(outer, `fixture-package-${forceFailure || "pass"}`);
	const output = join(outer, `fixture-tarball-${forceFailure || "pass"}`);
	mkdirSync(packageRoot);
	mkdirSync(output);
	write(
		join(packageRoot, "package.json"),
		`${JSON.stringify({
			name: "millwright-agent",
			version: "0.0.1",
			type: "module",
			bin: { millwright: "dist/cli.js" },
			files: ["dist", "docs", "examples", "skills", "README.md", "PROVENANCE.json"],
			...(artifactMarker ? { millwrightQualificationFixture: "dist/qualification-fixture.mjs" } : {}),
		}, null, 2)}\n`,
	);
	write(join(packageRoot, "dist/cli.js"), fixtureCliSource(forceFailure), 0o755);
	if (artifactMarker) write(join(packageRoot, "dist/qualification-fixture.mjs"), "export const bypass = true;\n");
	write(join(packageRoot, "PROVENANCE.json"), `${JSON.stringify({ sourceCommit: SOURCE_COMMIT })}\n`);
	for (const path of [
		"dist/index.js", "dist/config.js", "dist/core/settings-manager.js", "dist/core/session-manager.js",
		"dist/core/skills.js", "dist/core/slash-commands.js", "dist/core/refinement/index.js",
		"dist/core/kernel/bootstrap.js", "dist/modes/acp/acp-meta.js", "dist/core/agent-traces.js",
	]) write(join(packageRoot, path), "export const fixture = true;\n");
	if (oversizedDaemonSupport) write(join(packageRoot, "dist/daemon-generated.js"), `export const generated = "${"x".repeat(16 * 1024 * 1024)}";\n`);
	write(join(packageRoot, "dist/prime-agent-runtime/pyproject.toml"), "[build-system]\nrequires=[]\nbuild-backend='setuptools.build_meta'\n[project]\nname='millwright-fixture-rlm'\nversion='0.0.1'\n");
	write(join(packageRoot, "dist/prime-agent-runtime/src/rlm/__init__.py"), "FIXTURE = True\n");
	write(join(packageRoot, "README.md"), "# Millwright fixture\n");
	write(join(packageRoot, "docs/runtime.md"), "Millwright runtime fixture.\n");
	if (oversizedIdentity) write(join(packageRoot, "docs/oversized.md"), `Millwright ${"x".repeat(16 * 1024 * 1024)}\n`);
	write(join(packageRoot, "examples/example.md"), "Millwright example fixture.\n");
	write(join(packageRoot, "examples/example.ts"), 'export const productName = "Millwright";\n');
	write(join(packageRoot, "skills/refine/SKILL.md"), "---\nname: refine\ndescription: Millwright fixture\n---\n");
	const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", output], {
		cwd: packageRoot,
		encoding: "utf8",
		env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
	});
	assert.equal(packed.status, 0, packed.stderr || packed.stdout);
	const tarball = join(output, "millwright-agent-0.0.1.tgz");
	fixtureOptions.set(tarball, { forceFailure, oversizedIdentity });
	return tarball;
}

function runCliDriver(tarball, outer, env = {}) {
	const temporaryRoot = join(outer, "driver-temp");
	const results = join(outer, "driver-results");
	const result = spawnSync(
		process.execPath,
		[
			driver,
			"--tarball", tarball,
			"--source-commit", SOURCE_COMMIT,
			"--temporary-root", temporaryRoot,
			"--results", results,
		],
		{ cwd: root, encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000 },
	);
	return { result, temporaryRoot, results, reportPath: join(results, "installed-qualification.json") };
}

async function runDriver(tarball, outer, environment = {}, daemonEnvironment = {}) {
	const temporaryRoot = join(outer, "driver-temp");
	const results = join(outer, "driver-results");
	const options = parseQualificationArgs([
		"--tarball", tarball,
		"--source-commit", SOURCE_COMMIT,
		"--temporary-root", temporaryRoot,
		"--results", results,
	], { sourceRoot: root, home: process.env.HOME });
	let report;
	let error;
	const previous = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
	try {
		Object.assign(process.env, environment);
		report = await qualifyInstalledArtifactForTest(options, testSubstitutions(fixtureOptions.get(tarball)?.forceFailure, daemonEnvironment));
	} catch (caught) {
		error = caught;
	} finally {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
	const failed = report?.records.filter(({ status }) => status !== "passed") ?? [];
	const result = { status: error || failed.length ? 1 : 0, stdout: report ? JSON.stringify({ failed: failed.map(({ id }) => id) }) : "", stderr: error instanceof Error ? error.message : "" };
	return { result, temporaryRoot, results, reportPath: join(results, "installed-qualification.json") };
}

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function stopFixtureProcess(pid) {
	if (!Number.isInteger(pid) || !processAlive(pid)) return;
	try { process.kill(pid, "SIGTERM"); } catch {}
	const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
	const deadline = Date.now() + 3000;
	while (processAlive(pid) && Date.now() < deadline) Atomics.wait(waitBuffer, 0, 0, 25);
	if (processAlive(pid)) {
		try { process.kill(pid, "SIGKILL"); } catch {}
	}
}

test("parses the exact four-option interface and rejects unsafe or existing owned roots", () => {
	const outer = tempRoot();
	try {
		const tarball = join(outer, "millwright-agent-0.0.1.tgz");
		writeFileSync(tarball, "fixture");
		const temporaryRoot = join(outer, "driver-temp");
		const results = join(outer, "driver-results");
		assert.deepEqual(
			parseQualificationArgs([
				"--tarball", tarball,
				"--source-commit", SOURCE_COMMIT,
				"--temporary-root", temporaryRoot,
				"--results", results,
			], { sourceRoot: root, home: process.env.HOME }),
			{ tarball, sourceCommit: SOURCE_COMMIT, temporaryRoot, results },
		);
		for (const args of [
			[],
			["--tarball", tarball, "--source-commit", SOURCE_COMMIT, "--temporary-root", "relative", "--results", results],
			["--tarball", tarball, "--source-commit", "bad", "--temporary-root", temporaryRoot, "--results", results],
			["--unknown", "value", "--tarball", tarball, "--source-commit", SOURCE_COMMIT, "--temporary-root", temporaryRoot, "--results", results],
		]) assert.throws(() => parseQualificationArgs(args, { sourceRoot: root, home: process.env.HOME }));
		mkdirSync(temporaryRoot);
		assert.throws(() => parseQualificationArgs([
			"--tarball", tarball, "--source-commit", SOURCE_COMMIT,
			"--temporary-root", temporaryRoot, "--results", results,
		], { sourceRoot: root, home: process.env.HOME }), /must not already exist/u);
		assert.throws(() => parseQualificationArgs([
			"--tarball", tarball, "--source-commit", SOURCE_COMMIT,
			"--temporary-root", root, "--results", results,
		], { sourceRoot: root, home: process.env.HOME }), /source root/u);
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("accepts ordinary macOS tmpdir paths through only the fixed system var alias", { skip: process.platform !== "darwin" }, () => {
	const outer = mkdtempSync(join(tmpdir(), "millwright-c002-raw-tmpdir-"));
	try {
		const tarball = join(outer, "millwright-agent-0.0.1.tgz");
		writeFileSync(tarball, "fixture");
		const temporaryRoot = join(outer, "driver-temp");
		const results = join(outer, "driver-results");
		assert.deepEqual(parseQualificationArgs([
			"--tarball", tarball,
			"--source-commit", SOURCE_COMMIT,
			"--temporary-root", temporaryRoot,
			"--results", results,
		], { sourceRoot: root, home: process.env.HOME }), { tarball, sourceCommit: SOURCE_COMMIT, temporaryRoot, results });
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("rejects symlink-parent escapes before creating or deleting anything", () => {
	const outer = tempRoot();
	const elsewhere = tempRoot("millwright-c002-symlink-target-");
	try {
		const tarball = join(outer, "millwright-agent-0.0.1.tgz");
		writeFileSync(tarball, "fixture");
		symlinkSync(elsewhere, join(outer, "escape"), "dir");
		assert.throws(() => parseQualificationArgs([
			"--tarball", tarball, "--source-commit", SOURCE_COMMIT,
			"--temporary-root", join(outer, "escape", "driver-temp"),
			"--results", join(outer, "driver-results"),
		], { sourceRoot: root, home: process.env.HOME }), /symlink/u);
		assert.equal(existsSync(join(elsewhere, "driver-temp")), false);
		mkdirSync(join(elsewhere, "nested"));
		assert.throws(() => parseQualificationArgs([
			"--tarball", tarball, "--source-commit", SOURCE_COMMIT,
			"--temporary-root", join(outer, "escape", "nested", "driver-temp"),
			"--results", join(outer, "driver-results"),
		], { sourceRoot: root, home: process.env.HOME }), /symlink/u);
		assert.equal(existsSync(join(elsewhere, "nested", "driver-temp")), false);
	} finally {
		rmSync(outer, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	}
});

test("sanitizes inherited credentials and state overrides while keeping the fixed synthetic roots", () => {
	const roots = { home: "/safe/home", cache: "/safe/cache", agent: "/safe/home/.millwright", session: "/safe/sessions" };
	const env = sanitizeEnvironment({
		PATH: "/bin", TMPDIR: "/tmp", LANG: "C", SHELL: "/bin/sh",
		NODE_OPTIONS: "--require=/untrusted/preload.cjs",
		PI_API_KEY: "pi-secret", PRIME_API_KEY: "prime-secret", OPENAI_API_KEY: "provider-secret",
		RLM_SESSION_DIR: "/legacy/rlm", XDG_CONFIG_HOME: "/legacy/xdg", MILLRACE_HOME: "/legacy/millrace",
		MILLWRIGHT_CODING_AGENT_DIR: "/wrong", MILLWRIGHT_SESSION_DIR: "/wrong-session",
	}, roots);
	assert.equal(env.PATH, "/bin");
	assert.equal(env.HOME, roots.home);
	assert.equal(env.USERPROFILE, roots.home);
	assert.equal(env.npm_config_cache, roots.cache);
	assert.equal(env.MILLWRIGHT_CODING_AGENT_DIR, roots.agent);
	assert.equal(env.MILLWRIGHT_SESSION_DIR, roots.session);
	assert.equal(env.MILLWRIGHT_OFFLINE, "1");
	assert.equal(env.MILLWRIGHT_SKIP_VERSION_CHECK, "1");
	for (const name of ["PI_API_KEY", "PRIME_API_KEY", "OPENAI_API_KEY", "RLM_SESSION_DIR", "XDG_CONFIG_HOME", "MILLRACE_HOME"]) {
		assert.equal(env[name], undefined, name);
	}
	assert.equal(env.NODE_OPTIONS, undefined);
});

test("selects the exact real-PTY platform contract without interpolating caller values as shell", () => {
	assert.deepEqual(ptyInvocation("darwin", "/owned/tui-wrapper.sh"), {
		command: "/usr/bin/script",
		args: ["-q", "/dev/null", "/owned/tui-wrapper.sh"],
	});
	assert.deepEqual(ptyInvocation("linux", "/owned/wrapper's.sh"), {
		command: "script",
		args: ["-q", "-e", "-c", "'/owned/wrapper'\"'\"'s.sh'", "/dev/null"],
	});
	assert.throws(() => ptyInvocation("win32", "/owned/tui-wrapper.sh"), /PTY support/u);
});

test("bounds output, propagates timeout failure, and reaps the child process group", async () => {
	const outer = tempRoot();
	try {
		const child = join(outer, "hang.mjs");
		writeFileSync(child, "process.stdout.write('x'.repeat(200000)); setInterval(() => {}, 1000);\n");
		const result = await runBoundedCommand(process.execPath, [child], {
			cwd: outer,
			env: { PATH: process.env.PATH },
			timeoutMs: 100,
			maxOutputBytes: 4096,
		});
		assert.equal(result.timedOut, true);
		assert.equal(result.stdout.length <= 4096, true);
		assert.equal(result.cleanup.residualPids.length, 0);
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("registers and reaps a detached descendant whose launcher exits immediately", async () => {
	const outer = tempRoot();
	const marker = join(outer, "detached.pid");
	let detachedPid;
	try {
		const grandchild = join(outer, "grandchild.mjs");
		const launcher = join(outer, "launcher.mjs");
		writeFileSync(grandchild, "setInterval(() => {}, 1000);\n");
		writeFileSync(launcher, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { detached: true, stdio: "ignore" }); writeFileSync(${JSON.stringify(marker)}, String(child.pid)); child.unref();\n`);
		const result = await runBoundedCommand(process.execPath, [launcher], { cwd: outer, env: { PATH: process.env.PATH }, timeoutMs: 3000, processRegistryRoot: outer });
		detachedPid = Number.parseInt(readFileSync(marker, "utf8"), 10);
		assert.equal(result.code, 0);
		assert.equal(result.cleanup.observedDescendants.some(({ pid }) => pid === detachedPid), true);
		assert.equal(processAlive(detachedPid), false, `detached descendant ${detachedPid} survived command cleanup`);
		assert.equal(result.cleanup.residualPids.length, 0);
	} finally {
		stopFixtureProcess(detachedPid);
		rmSync(outer, { recursive: true, force: true });
	}
});

test("checks a registered detached daemon worker during stop and reaps its exact identity on error", async () => {
	const outer = tempRoot();
	const marker = join(outer, "millwright-fixture-worker.json");
	let worker;
	try {
		const tarball = createFixtureTarball(outer, { forceFailure: "daemon-detached-worker" });
		const { result, reportPath } = await runDriver(tarball, outer, { TMPDIR: outer }, { MILLWRIGHT_QUALIFICATION_WORKER_MARKER: marker });
		worker = JSON.parse(readFileSync(marker, "utf8"));
		assert.notEqual(result.status, 0);
		assert.equal(Number.isInteger(worker.pid) && worker.pid > 0, true);
		assert.equal(typeof worker.startId === "string" && worker.startId.length > 0, true);
		assert.equal(Number.isInteger(worker.processGroup) && worker.processGroup > 0, true);
		assert.equal(processAlive(worker.pid), false, `registered daemon worker ${worker.pid} survived driver cleanup`);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		const lifecycle = report.records.find(({ id }) => id === "daemonLifecycle");
		assert.equal(lifecycle.status, "failed");
		assert.match(lifecycle.details.error, /registered task-owned process.*did not stop/iu);
		assert.equal(lifecycle.details.error.includes(`${worker.pid}/${worker.startId}/${worker.processGroup}`), true);
		assert.equal(report.records.find(({ id }) => id === "cleanup").status, "passed");
	} finally {
		stopFixtureProcess(worker?.pid);
		rmSync(outer, { recursive: true, force: true });
	}
});

test("uses a short task-owned TMPDIR for daemon cases instead of inherited ambient TMPDIR", async () => {
	const outer = tempRoot("millwright-c005-daemon-tmp-");
	const ambient = join(outer, "ambient", "a".repeat(220));
	const ambientMarker = join(ambient, "millwright-fixture-worker.json");
	const workerMarker = join(outer, "millwright-fixture-worker.json");
	mkdirSync(ambient, { recursive: true });
	try {
		const tarball = createFixtureTarball(outer, { forceFailure: "daemon-detached-worker" });
		const { result, reportPath } = await runDriver(tarball, outer, { TMPDIR: ambient }, { MILLWRIGHT_QUALIFICATION_WORKER_MARKER: workerMarker });
		assert.equal(ambient.length > 200, true);
		assert.notEqual(result.status, 0);
		assert.equal(existsSync(ambientMarker), false, `daemon inherited ambient TMPDIR: ${ambient}`);
		const worker = JSON.parse(readFileSync(workerMarker, "utf8"));
		const daemonSocketDir = join(worker.tmpdir, `millwright-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
		assert.equal(dirname(worker.socketPath), daemonSocketDir);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		assert.equal(report.records.find(({ id }) => id === "cleanup").status, "passed");
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("runs an explicit provider-free status command through the installed public PTY launcher", async () => {
	const outer = tempRoot("millwright-c005-launcher-status-");
	const marker = join(outer, "launcher-client.json");
	try {
		const tarball = createFixtureTarball(outer, { forceFailure: "launcher-status" });
		const { result, reportPath } = await runDriver(tarball, outer, {}, { MILLWRIGHT_QUALIFICATION_LAUNCHER_MARKER: marker });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "report missing"}`);
		const markerRecord = JSON.parse(readFileSync(marker, "utf8"));
		assert.equal(markerRecord.rejectedEmptyPrint, undefined);
		assert.equal(markerRecord.command, "/goal status");
		assert.equal(markerRecord.exitCode, 0);
		assert.equal(existsSync(markerRecord.tmpdir), false);
		assert.equal(existsSync(dirname(markerRecord.tmpdir)), false);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		const cleanup = report.records.find(({ id }) => id === "cleanup");
		assert.deepEqual(Object.keys(cleanup.details).sort(), ["reclaimedBytes", "removedRoots", "residualPids", "residualSockets", "temporaryRootRemoved"]);
		assert.deepEqual(cleanup.details.removedRoots, ["$TEMP"]);
		const daemonCases = report.records.find(({ id }) => id === "daemonLifecycle").details.cases;
		for (const daemonCase of daemonCases) {
			assert.deepEqual(Object.keys(daemonCase).sort(), ["cleanup", "daemon", "descendantIdentitiesAfter", "descendantIdentitiesBefore", "id", "launcher", "observedExit", "observedSignal", "processGroup", "socketPath", "socketStateAfter", "socketStateBefore"]);
		}
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("qualifies one synthetic installed package with isolated case roots and the exact bounded report", async () => {
	const outer = tempRoot();
	try {
		const tarball = createFixtureTarball(outer);
		const { result, temporaryRoot, results, reportPath } = await runDriver(tarball, outer, {
			PRIME_API_KEY: "must-not-appear",
			OPENAI_API_KEY: "also-must-not-appear",
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "report missing"}`);
		assert.equal(existsSync(temporaryRoot), false);
		assert.deepEqual(readdirSync(results), ["installed-qualification.json"]);
		const bytes = readFileSync(reportPath);
		const report = JSON.parse(bytes);
		assert.equal(report.schemaVersion, 1);
		assert.equal(report.sourceCommit, SOURCE_COMMIT);
		assert.deepEqual(report.records.map(({ id }) => id), REPORT_IDS);
		assert.deepEqual(report.records.map(({ status }) => status), REPORT_IDS.map(() => "passed"));
		for (const record of report.records) {
			assert.equal(Number.isInteger(record.durationMs) && record.durationMs >= 0, true, record.id);
			assert.match(record.stdoutSha256, /^[0-9a-f]{64}$/u);
			assert.match(record.stderrSha256, /^[0-9a-f]{64}$/u);
		}
		assert.equal(report.records.find(({ id }) => id === "help").stderrSha256, EMPTY_SHA256);
		assert.deepEqual(report.records.find(({ id }) => id === "daemonLifecycle").details.cases.map(({ id }) => id), DAEMON_CASE_IDS);
		assert.equal(report.records.find(({ id }) => id === "legacyState").details.byteUnchanged, true);
		assert.equal(report.records.find(({ id }) => id === "legacyState").details.sentinelCount, 32);
		assert.deepEqual(report.records.find(({ id }) => id === "legacyState").details.sentinelLocations, ["home/.prime", "home/.millrace-cli", "project/.prime", "project/.millrace-cli"]);
		const identity = report.records.find(({ id }) => id === "identity");
		const shippedDocsExamples = identity.details.surfaces.find(({ id }) => id === "shippedDocsExamples");
		assert.equal(shippedDocsExamples.hitCount, 4);
		const observedStateTrees = identity.details.surfaces.find(({ id }) => id === "observedStateTrees");
		assert.equal(observedStateTrees.classificationCounts["forbidden-accidental-identity"], 4, "session-artifacts identity marker was not scanned");
		assert.equal(report.records.find(({ id }) => id === "cleanup").details.temporaryRootRemoved, true);
		assert.equal(JSON.stringify(report).includes("must-not-appear"), false);
		assert.equal(JSON.stringify(report).includes(outer), false);
		assert.match(sha256(bytes), /^[0-9a-f]{64}$/u);
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("rejects an artifact-controlled qualification fixture marker on the normal CLI path", () => {
	const outer = tempRoot();
	try {
		const tarball = createFixtureTarball(outer, { artifactMarker: true });
		const { result, reportPath } = runCliDriver(tarball, outer);
		assert.notEqual(result.status, 0);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		assert.match(report.records[0].details.error, /artifact-controlled qualification fixture marker/iu);
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("fails a zero-exit TUI probe that never emits interactiveMode.init readiness", async () => {
	const outer = tempRoot();
	try {
		const tarball = createFixtureTarball(outer, { forceFailure: "tui-no-init" });
		const { result, reportPath } = await runDriver(tarball, outer);
		assert.notEqual(result.status, 0);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		const tui = report.records.find(({ id }) => id === "tui");
		assert.equal(tui.status, "failed");
		assert.match(tui.details.error, /interactiveMode\.init/iu);
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("rejects mismatched, non-current, and duplicate daemon status evidence", async () => {
	for (const forceFailure of ["status-mismatch", "status-invalid", "status-duplicate"]) {
		const outer = tempRoot();
		try {
			const tarball = createFixtureTarball(outer, { forceFailure });
			const { result, reportPath } = await runDriver(tarball, outer);
			assert.notEqual(result.status, 0, forceFailure);
			const report = JSON.parse(readFileSync(reportPath, "utf8"));
			assert.equal(report.records.find(({ id }) => id === "daemonLifecycle").status, "failed", forceFailure);
			assert.equal(report.records.find(({ id }) => id === "cleanup").status, "passed", forceFailure);
		} finally {
			rmSync(outer, { recursive: true, force: true });
		}
	}
});

test("fails explicitly when the authorized identity corpus exceeds its declared byte ceiling", async () => {
	const outer = tempRoot();
	try {
		const tarball = createFixtureTarball(outer, { oversizedIdentity: true });
		const { result, reportPath } = await runDriver(tarball, outer);
		assert.notEqual(result.status, 0);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		const identity = report.records.find(({ id }) => id === "identity");
		assert.equal(identity.status, "failed");
		assert.match(identity.details.error, /identity corpus .* ceiling/iu);
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("scans task-owned daemon diagnostics without treating installed support trees as diagnostics", async () => {
	const outer = tempRoot();
	try {
		const tarball = createFixtureTarball(outer, { oversizedDaemonSupport: true });
		const { result, reportPath } = await runDriver(tarball, outer);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		const identity = report.records.find(({ id }) => id === "identity");
		const daemonDiagnostics = identity.details.surfaces?.find(({ id }) => id === "daemonDiagnostics");
		assert.equal(result.status, 0, JSON.stringify(report.records.filter(({ status }) => status !== "passed")));
		assert.equal(identity.status, "passed");
		assert.ok(daemonDiagnostics.hitCount > 0, "task-owned daemon log was not scanned");
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("cleans a partially-created temporary root when results-root creation fails", () => {
	const outer = tempRoot();
	try {
		const tarball = createFixtureTarball(outer);
		const temporaryRoot = join(outer, "partial-driver-temp");
		const result = spawnSync(process.execPath, [
			driver,
			"--tarball", tarball,
			"--source-commit", SOURCE_COMMIT,
			"--temporary-root", temporaryRoot,
			"--results", join(outer, "r".repeat(300)),
		], { cwd: root, encoding: "utf8", env: process.env, timeout: 30_000 });
		assert.notEqual(result.status, 0);
		assert.equal(existsSync(temporaryRoot), false);
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("rejects zero-exit config, session, and skill probes that return false installed-state proofs", async () => {
	const outer = tempRoot();
	try {
		const tarball = createFixtureTarball(outer, { forceFailure: "state-proofs" });
		const { result, reportPath } = await runDriver(tarball, outer);
		assert.notEqual(result.status, 0);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		for (const id of ["configState", "sessionState", "skillDiscovery"]) {
			const record = report.records.find((entry) => entry.id === id);
			assert.equal(record.status, "failed", id);
			assert.match(record.details.error, /installed .* contract failed/iu, id);
		}
		assert.equal(report.records.find(({ id }) => id === "cleanup").status, "passed");
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("fails a daemon case when the requested bounded shutdown transition does not complete", async () => {
	const outer = tempRoot();
	try {
		const tarball = createFixtureTarball(outer, { forceFailure: "daemon-transition" });
		const { result, reportPath } = await runDriver(tarball, outer);
		assert.notEqual(result.status, 0);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		const lifecycle = report.records.find(({ id }) => id === "daemonLifecycle");
		assert.equal(lifecycle.status, "failed");
		assert.match(lifecycle.details.error, /(?:daemon did not stop within the bounded transition|registered task-owned process.*did not stop during clean-stop transition)/iu);
		assert.equal(report.records.find(({ id }) => id === "cleanup").status, "passed");
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("reaps the exact launcher daemon identity when strict status validation fails", async () => {
	const outer = tempRoot();
	const marker = join(outer, "millwright-fixture-launcher.pid");
	let daemonPid;
	try {
		const tarball = createFixtureTarball(outer, { forceFailure: "launcher-cleanup" });
		const { result, reportPath } = await runDriver(tarball, outer, { TMPDIR: outer }, { MILLWRIGHT_QUALIFICATION_LAUNCHER_MARKER: marker });
		daemonPid = Number.parseInt(readFileSync(marker, "utf8"), 10);
		assert.notEqual(result.status, 0);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		assert.equal(report.records.find(({ id }) => id === "daemonLifecycle").status, "failed");
		assert.equal(processAlive(daemonPid), false, `launcher daemon ${daemonPid} survived driver cleanup`);
		assert.equal(report.records.find(({ id }) => id === "cleanup").status, "passed");
	} finally {
		stopFixtureProcess(daemonPid);
		rmSync(outer, { recursive: true, force: true });
	}
});

test("reaps the exact managed listener identity when status rejects a descendant daemon", async () => {
	const outer = tempRoot();
	const marker = join(outer, "millwright-fixture-daemon.json");
	let daemon;
	try {
		const tarball = createFixtureTarball(outer, { forceFailure: "daemon-listener-descendant" });
		const { result, reportPath } = await runDriver(tarball, outer, {}, { MILLWRIGHT_QUALIFICATION_DAEMON_MARKER: marker });
		daemon = JSON.parse(readFileSync(marker, "utf8"));
		assert.notEqual(result.status, 0);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		assert.equal(report.records.find(({ id }) => id === "daemonLifecycle").status, "failed");
		assert.equal(processAlive(daemon.pid), false, `managed listener ${daemon.pid} survived driver cleanup`);
		assert.equal(report.records.find(({ id }) => id === "cleanup").status, "passed");
	} finally {
		stopFixtureProcess(daemon?.pid);
		rmSync(outer, { recursive: true, force: true });
	}
});

test("writes failed evidence atomically and still cleans roots, sockets, and processes after a failed assertion", async () => {
	const outer = tempRoot();
	try {
		const tarball = createFixtureTarball(outer, { forceFailure: "identity" });
		const { result, temporaryRoot, results, reportPath } = await runDriver(tarball, outer);
		assert.notEqual(result.status, 0);
		assert.equal(existsSync(temporaryRoot), false);
		assert.deepEqual(readdirSync(results), ["installed-qualification.json"]);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		assert.equal(report.records.find(({ id }) => id === "identity").status, "failed");
		assert.equal(report.records.find(({ id }) => id === "cleanup").status, "passed");
		assert.equal(report.records.find(({ id }) => id === "cleanup").details.residualPids.length, 0);
		const cleanup = report.records.find(({ id }) => id === "cleanup");
		assert.equal(cleanup.details.residualSockets.length, 0);
		assert.deepEqual(Object.keys(cleanup.details).sort(), ["reclaimedBytes", "removedRoots", "residualPids", "residualSockets", "temporaryRootRemoved"]);
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("packs the clean accepted source once and qualifies only the real installed tarball", { timeout: 600_000 }, () => {
	assert.equal(process.version, "v22.22.0", "real-pack integration requires the repository-pinned Node");
	const outer = tempRoot("millwright-c002-real-pack-");
	try {
		const clone = join(outer, "source");
		const pack = join(outer, "pack");
		mkdirSync(pack);
		const cloned = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", root, clone], { encoding: "utf8" });
		assert.equal(cloned.status, 0, cloned.stderr);
		const lifecyclePath = "packages/coding-agent/src/main.ts";
		const currentLifecycle = readFileSync(join(root, lifecyclePath), "utf8");
		if (readFileSync(join(clone, lifecyclePath), "utf8") !== currentLifecycle) {
			writeFileSync(join(clone, lifecyclePath), currentLifecycle);
			const staged = spawnSync("git", ["add", "--", lifecyclePath], { cwd: clone, encoding: "utf8" });
			assert.equal(staged.status, 0, staged.stderr);
			const committed = spawnSync("git", ["-c", "user.name=Millwright Qualification", "-c", "user.email=qualification@invalid", "commit", "--quiet", "-m", "test: overlay startup lifecycle fix"], { cwd: clone, encoding: "utf8" });
			assert.equal(committed.status, 0, committed.stderr);
		}
		const packed = spawnSync("npx", ["--yes", "npm@10.9.2", "run", "pack:release", "--", "--output", pack], {
			cwd: clone,
			encoding: "utf8",
			env: process.env,
			timeout: 300_000,
		});
		assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
		const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).stdout.trim();
		const temporaryRoot = join(outer, "real-driver-temp");
		const results = join(outer, "real-driver-results");
		const qualified = spawnSync(process.execPath, [
			driver,
			"--tarball", join(pack, "millwright-agent-0.0.1.tgz"),
			"--source-commit", commit,
			"--temporary-root", temporaryRoot,
			"--results", results,
		], { cwd: root, encoding: "utf8", env: process.env, timeout: 240_000 });
		const reportPath = join(results, "installed-qualification.json");
		const diagnostic = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "report missing";
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		const tui = report.records.find(({ id }) => id === "tui");
		const identity = report.records.find(({ id }) => id === "identity");
		assert.equal(tui.status, "passed", diagnostic);
		assert.ok(tui.durationMs <= 120_000, `TUI readiness exceeded its 120s bound: ${tui.durationMs}ms`);
		assert.equal(identity.status, "passed", diagnostic);
		assert.equal(qualified.status, 0, `${qualified.stdout}\n${qualified.stderr}\n${diagnostic}`);
		assert.deepEqual(report.records.map(({ id }) => id), REPORT_IDS);
		assert.deepEqual(report.records.map(({ status }) => status), REPORT_IDS.map(() => "passed"));
		assert.equal(report.records.find(({ id }) => id === "refinementSafety").details.providerCalls, 0);
		assert.equal(report.records.find(({ id }) => id === "cleanup").details.residualPids.length, 0);
	} finally {
		rmSync(outer, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	}
});
