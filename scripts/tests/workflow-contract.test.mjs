import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import YAML from "yaml";

const root = resolve(new URL("../..", import.meta.url).pathname);
const REPORT_IDS = ["help", "version", "tui", "configState", "sessionState", "skillDiscovery", "kernelDiscovery", "daemonLifecycle", "legacyState", "refinementSafety", "identity", "cleanup"];
const DAEMON_CASE_IDS = ["clean-stop", "sigterm", "launcher-parent-exit", "startup-validation-failure"];
const IDENTITY_SURFACE_IDS = ["commandTuiOutput", "updaterText", "daemonDiagnostics", "telemetryAcpMetadata", "installedSkills", "packageMetadata", "shippedDocsExamples", "settingsRefinementDefaults", "observedStateTrees", "kernelRuntimeDiscovery"];
const CLASSIFICATION_KEYS = ["public-millwright-identity", "retained-internal-compatibility-identity", "provider-specific-prime-identity", "required-attribution-or-provenance", "forbidden-accidental-identity"];

function read(path) {
	return readFileSync(resolve(root, path), "utf8");
}

function workflow(path) {
	return YAML.parse(read(path));
}

function stepText(job) {
	return YAML.stringify(job.steps || []);
}

function qualificationWriterFixture(fixture, mutateInstalled) {
	const logs = join(fixture, "logs");
	mkdirSync(logs);
	const artifactSha256 = "a".repeat(64);
	const integrity = `sha512-${Buffer.from("integrity").toString("base64")}`;
	const sourceCommit = "b".repeat(40);
	const pack = {
		sourceCommit,
		source: { dirty: false, status: [], trackedSourceManifestSha256: "c".repeat(64) },
		artifact: { filename: "millwright-agent-0.0.3.tgz", sha256: artifactSha256, integrity },
	};
	const verified = { sourceCommit, sha256: artifactSha256, integrity };
	const zeroClassifications = () => Object.fromEntries(CLASSIFICATION_KEYS.map((key) => [key, 0]));
	const recordDetails = (id) => {
		if (id === "help") return { product: "Millwright" };
		if (id === "version") return { product: "Millwright", version: "0.0.3" };
		if (id === "tui") return { realPty: true, timingEnabled: true, initialized: true, readiness: "interactiveMode.init", startupBenchmark: true, offline: true, noSession: true, legacyUnchanged: true };
		if (id === "configState") return { product: "Millwright", packageName: "millwright-agent", command: "millwright", agentRootMatches: true, freshAutoRefine: false, entrypoints: ["dist/config.js", "dist/core/settings-manager.js"], legacyUnchanged: true };
		if (id === "sessionState") return { persisted: true, sessionRootMatches: true, entries: 1, entrypoints: ["dist/core/session-manager.js"], legacyUnchanged: true };
		if (id === "skillDiscovery") return { names: ["installed-fixture"], diagnostics: 0, entrypoints: ["dist/core/skills.js"], legacyUnchanged: true };
		if (id === "kernelDiscovery") return { bootstrap: "dist/core/kernel/bootstrap.js", runtime: "dist/prime-agent-runtime", importBelowInstalledRuntime: true, sourcePythonPath: false };
		if (id === "daemonLifecycle") return {
			cases: DAEMON_CASE_IDS.map((caseId, index) => ({
				id: caseId,
				launcher: { pid: 100 + index, startId: `ps:launcher-${index}`, processGroup: 100 + index },
				daemon: caseId === "startup-validation-failure" ? null : { pid: 200 + index, startId: `ps:daemon-${index}`, processGroup: 200 + index },
				processGroup: caseId === "startup-validation-failure" ? null : 200 + index,
				descendantIdentitiesBefore: [],
				descendantIdentitiesAfter: [],
				socketPath: `$TEMP/${caseId}.s`,
				socketStateBefore: false,
				socketStateAfter: false,
				observedExit: caseId === "startup-validation-failure" ? 1 : caseId === "sigterm" ? 143 : 0,
				observedSignal: null,
				cleanup: { legacyUnchanged: true, residualPids: [], residualSockets: [] },
			})),
		};
		if (id === "legacyState") return { byteUnchanged: true, sentinelCount: 32, sentinelLocations: ["home/.prime", "home/.millrace-cli", "project/.prime", "project/.millrace-cli"] };
		if (id === "refinementSafety") return { freshEnabled: false, explicitEnabled: true, commandPresent: true, promptPath: true, persisted: true, fauxCalls: 1, providerCalls: 0, deterministicPlannerCalls: 1, legacyUnchanged: true };
		if (id === "identity") return { surfaces: IDENTITY_SURFACE_IDS.map((surfaceId) => ({ id: surfaceId, sha256: createHash("sha256").update(surfaceId).digest("hex"), hitCount: 0, classificationCounts: zeroClassifications() })), classificationCounts: zeroClassifications(), unclassifiedHits: 0, forbiddenHits: 0 };
		if (id === "cleanup") return { temporaryRootRemoved: true, removedRoots: ["$TEMP"], reclaimedBytes: 1024, residualPids: [], residualSockets: [] };
		throw new Error(`Unknown record: ${id}`);
	};
	const installed = {
		schemaVersion: 1,
		sourceCommit,
		artifact: { filename: "millwright-agent-0.0.3.tgz", sha256: artifactSha256, integrity },
		toolchain: { node: "22.22.0", npm: "10.9.2" },
		platform: { os: "linux", release: "6.11.0", arch: "x64" },
		records: REPORT_IDS.map((id) => ({
			id,
			status: "passed",
			durationMs: 1,
			exitCode: ["legacyState", "identity", "cleanup"].includes(id) ? null : 0,
			stdoutSha256: createHash("sha256").update(`${id}:stdout`).digest("hex"),
			stderrSha256: createHash("sha256").update(`${id}:stderr`).digest("hex"),
			details: recordDetails(id),
		})),
	};
	mutateInstalled?.(installed);
	const packPath = join(fixture, "pack.json");
	const verifiedPath = join(fixture, "verified.json");
	const installedPath = join(fixture, "installed.json");
	writeFileSync(packPath, JSON.stringify(pack));
	writeFileSync(verifiedPath, JSON.stringify(verified));
	writeFileSync(installedPath, JSON.stringify(installed));
	for (const gate of ["build", "checks", "cleanSource", "installSmoke", "pack", "tests", "types"]) writeFileSync(join(logs, `${gate}.log`), `${gate}\n`);
	return { artifactSha256, installed, installedPath, integrity, logs, packPath, sourceCommit, verifiedPath };
}

function runQualificationWriter(fixture, inputs, digestOverride) {
	const output = join(fixture, "qualification-report.json");
	let installedReportSha256 = digestOverride;
	if (!installedReportSha256) {
		try { installedReportSha256 = createHash("sha256").update(readFileSync(inputs.installedPath)).digest("hex"); }
		catch { installedReportSha256 = "0".repeat(64); }
	}
	const result = spawnSync(
		process.execPath,
		[
			resolve(root, "scripts/write-millwright-qualification-report.mjs"),
			"--output", output,
			"--pack-report", inputs.packPath,
			"--package-report", inputs.verifiedPath,
			"--logs-dir", inputs.logs,
			"--installed-report", inputs.installedPath,
			"--installed-report-sha256", installedReportSha256,
		],
		{
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, GITHUB_REPOSITORY: "tim-osterhus/millwright", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" },
		},
	);
	return { installedReportSha256, output, result };
}

test("CI is pinned, cross-platform, non-mutating, and incapable of publication", () => {
	const value = workflow(".github/workflows/ci.yml");
	assert.deepEqual(Object.keys(value.on).sort(), ["pull_request", "push"]);
	assert.deepEqual(value.permissions, { contents: "read" });
	const job = value.jobs.verify;
	assert.deepEqual(job.strategy.matrix.os, ["macos-latest", "ubuntu-latest"]);
	assert.equal(job["runs-on"], "${{ matrix.os }}");
	const text = stepText(job);
	for (const required of [
		"node-version: 22.22.0",
		"npm@10.9.2",
		"npm ci --ignore-scripts",
		"npm run check:ci",
		"npx tsgo --noEmit",
		"npm run build:release",
		"npm run test --workspace=packages/tui",
		"npm run test --workspace=packages/ai",
		"npm run test --workspace=packages/agent",
		"npm run test:ci --workspace=packages/coding-agent -- --shard=1/3",
		"npm run test:ci --workspace=packages/coding-agent -- --shard=2/3",
		"npm run test:ci --workspace=packages/coding-agent -- --shard=3/3",
		"npm run test:process --workspace=packages/coding-agent",
		"npm run test:process-stress --workspace=packages/coding-agent",
		"npm run test:kernel --workspace=packages/coding-agent",
		"npm run pack:release",
		"verify-millwright-package.mjs",
		"git diff --exit-code",
		"git status --porcelain=v1 --untracked-files=all",
	]) assert.match(text, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(text, /npm publish|npm version|git (?:commit|tag|push)|--write/u);
	assert.match(text, /qualification-report\.json/u);
	assert.match(text, /millwright-qualification-ubuntu-/u);
	assert.match(text, /retention-days:\s*90/u);
	const fullTests = job.steps.find((step) => step.name === "Full tests and release contracts");
	assert.ok(fullTests);
	assert.equal(fullTests.env.MILLWRIGHT_OFFLINE, undefined);
	assert.equal(fullTests.env.DEEPSEEK_API_KEY, "");
	assert.match(fullTests.run, /set -euo pipefail/u);
	assert.doesNotMatch(fullTests.run, /MILLWRIGHT_OFFLINE=1 npx vitest/u);
	assert.equal(job.environment, undefined);
});

test("CI provisions and verifies the exact uv toolchain without caching", () => {
	const value = workflow(".github/workflows/ci.yml");
	const job = value.jobs.verify;
	const uvSetup = job.steps.find((step) => step.name === "Set up uv");
	assert.ok(uvSetup);
	assert.equal(uvSetup.uses, "astral-sh/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9");
	assert.deepEqual(uvSetup.with, { version: "0.12.6", "enable-cache": false });
	const toolchain = job.steps.find((step) => step.name === "Pin and verify toolchain");
	assert.ok(toolchain);
	assert.match(toolchain.run, /node_version="\$\(node --version\)"/u);
	assert.match(toolchain.run, /npm_version="\$\(npm --version\)"/u);
	assert.match(toolchain.run, /uv_version="\$\(uv --version \| awk '\{print \$2\}'\)"/u);
	assert.match(toolchain.run, /printf 'node=%s npm=%s uv=%s\\n'/u);
	assert.match(toolchain.run, /test "\$uv_version" = "0\.12\.6"/u);
});

test("ordinary macOS and Ubuntu CI qualify the verified installed artifact without source-workspace substitution", () => {
	const value = workflow(".github/workflows/ci.yml");
	const job = value.jobs.verify;
	assert.deepEqual(job.strategy.matrix.os, ["macos-latest", "ubuntu-latest"]);
	const packageIndex = job.steps.findIndex((step) => step.name === "Verify package and isolated install smoke");
	const installedIndex = job.steps.findIndex((step) => step.name === "Qualify installed artifact");
	assert.equal(packageIndex >= 0 && installedIndex > packageIndex, true);
	const installed = job.steps[installedIndex];
	assert.match(installed.run, /node scripts\/qualify-installed-millwright\.mjs/u);
	assert.match(installed.run, /--tarball "\$RUNNER_TEMP\/millwright-pack\/millwright-agent-0\.0\.3\.tgz"/u);
	assert.match(installed.run, /--source-commit "\$GITHUB_SHA"/u);
	assert.match(installed.run, /--temporary-root "\$RUNNER_TEMP\/millwright-installed\/driver-temp"/u);
	assert.match(installed.run, /--results "\$RUNNER_TEMP\/millwright-installed\/installed-driver"/u);
	const fullTests = job.steps.find((step) => step.name === "Full tests and release contracts");
	assert.doesNotMatch(fullTests.run, /qualify-installed-millwright|MILLWRIGHT_OFFLINE=1 npx vitest/u);
	for (const sourceRegression of ["packages/tui", "packages/ai", "packages/agent", "packages/coding-agent"]) assert.match(fullTests.run, new RegExp(sourceRegression.replaceAll("/", "\\/")));
	const upload = job.steps.find((step) => step.name === "Upload installed qualification report");
	assert.ok(upload);
	assert.equal(upload.with.path, "${{ runner.temp }}/millwright-installed/installed-driver/installed-qualification.json");
	const cleanup = job.steps.find((step) => step.name === "Clean task-owned roots");
	assert.equal(cleanup.if, "always()");
	assert.match(cleanup.run, /test ! -e "\$RUNNER_TEMP\/millwright-installed\/driver-temp"/u);
	assert.match(cleanup.run, /rm -rf "\$RUNNER_TEMP\/millwright-installed"/u);
	assert.match(cleanup.run, /test ! -e "\$RUNNER_TEMP\/millwright-installed"/u);
});

test("installed artifact qualification isolates HOME under the task-owned runner temp sibling", () => {
	const value = workflow(".github/workflows/ci.yml");
	const installed = value.jobs.verify.steps.find((step) => step.name === "Qualify installed artifact");
	assert.equal(installed?.env?.HOME, "${{ runner.temp }}/millwright-home");
});

test("coding-agent process regressions run in a dedicated serial lane", () => {
	const scripts = JSON.parse(read("packages/coding-agent/package.json")).scripts;
	assert.equal(
		scripts["test:ci"],
		"tsx src/core/kernel/bootstrap-cli.ts && vitest --run --exclude test/daemon-supervisor-process.test.ts --exclude test/suite/regressions/4603-worker-recovery.test.ts",
	);
	assert.equal(
		scripts["test:process"],
		"vitest --run --no-file-parallelism test/daemon-supervisor-process.test.ts test/suite/regressions/4603-worker-recovery.test.ts",
	);
	assert.equal(
		scripts["test:process-stress"],
		"vitest --run --no-file-parallelism --tagsFilter process-stress test/daemon-supervisor-process.test.ts test/footer-data-provider.test.ts test/suite/agent-session-autonomous.test.ts test/suite/regressions/4606-update-restart-coordinator.test.ts",
	);
	assert.equal(
		scripts["test:kernel"],
		"vitest --run --no-file-parallelism --tagsFilter kernel-heavy test/acp-kernel-features.test.ts test/acp-cold-cli.test.ts test/kernel-attach-image-skill.test.ts test/kernel-agent-message-skill.test.ts test/kernel-goal-skill.test.ts test/kernel-state-roundtrip.test.ts test/suite/regressions/4428-remove-legacy-pi-mono-tools.test.ts",
	);
});

test("publication is exact-tag, exact-artifact, minimal-permission, and approval gated", () => {
	const value = workflow(".github/workflows/publish-npm.yml");
	assert.deepEqual(value.on, { push: { tags: ["v*"] } });
	const verify = value.jobs.verify;
	assert.deepEqual(verify.permissions, { actions: "read", contents: "read" });
	assert.equal(verify.environment, undefined);
	const verifyText = stepText(verify);
	for (const required of [
		"v0.0.3",
		"verify-millwright-release.mjs",
		"verify-millwright-package.mjs",
		"actions/upload-artifact@v4",
		"compression-level: 0",
		"retention-days: 30",
	]) assert.match(verifyText, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(verifyText, /npm publish/u);
	const verifyShell = verify.steps.map((step) => step.run || "").join("\n");
	assert.doesNotMatch(verifyShell, /\$\{\{\s*steps\.release\.outputs\./u);
	const releaseBinding = verify.steps.find((step) => step.name === "Read frozen release binding");
	assert.ok(releaseBinding);
	assert.match(releaseBinding.run, /sourceCommit/u);
	assert.match(releaseBinding.run, /\^\[0-9a-f\]\{40\}\$/u);
	assert.match(releaseBinding.run, /reportArtifactName/u);
	const publish = value.jobs.publish;
	assert.equal(publish.environment, "npm-production");
	assert.deepEqual(publish.permissions, { contents: "read", "id-token": "write" });
	assert.deepEqual(publish.needs, ["verify"]);
	const publishText = stepText(publish);
	assert.match(publishText, /actions\/download-artifact@v4/u);
	assert.match(publishText, /npm@11\.5\.1/u);
	assert.match(publishText, /npm --version[^\n]*11\.5\.1/u);
	assert.match(publishText, /npm publish (?:"\$TARBALL"|.*\.tgz) --access public --provenance/u);
	assert.doesNotMatch(publishText, /npm (?:pack|run build|version)|git (?:commit|tag|push)/u);
});

test("release workflow restores the runner-local annotated tag immediately after checkout", () => {
	const value = workflow(".github/workflows/publish-npm.yml");
	const steps = value.jobs.verify.steps;
	const checkoutIndex = steps.findIndex((step) => step.name === "Check out annotated tag");
	const restoreIndex = steps.findIndex((step) => step.name === "Restore annotated release tag");
	assert.notEqual(checkoutIndex, -1);
	assert.equal(restoreIndex, checkoutIndex + 1);
	const restore = steps[restoreIndex];
	assert.equal(restore.shell, "bash");
	assert.match(restore.run, /git fetch --force --no-tags origin/u);
	assert.match(restore.run, /refs\/tags\/\$GITHUB_REF_NAME:refs\/tags\/\$GITHUB_REF_NAME/u);
	assert.match(restore.run, /git cat-file -t "refs\/tags\/\$GITHUB_REF_NAME"/u);
	assert.match(restore.run, /git rev-list -n 1 "refs\/tags\/\$GITHUB_REF_NAME"/u);
	assert.match(restore.run, /\$GITHUB_SHA/u);
	assert.doesNotMatch(restore.run, /git (?:push|tag)|gh /u);
});

test("root scripts and source workspaces expose no local release mutator", () => {
	const rootManifest = JSON.parse(read("package.json"));
	const scripts = rootManifest.scripts || {};
	for (const name of ["publish", "publish:dry", "release:patch", "release:minor", "release:major", "version:patch", "version:minor", "version:major", "version:set"]) {
		assert.equal(scripts[name], undefined, `${name} must be absent`);
	}
	assert.equal(scripts["pack:release"], "node scripts/pack-millwright-release.mjs");
	assert.ok(scripts["check:ci"]);
	assert.doesNotMatch(JSON.stringify(scripts), /npm publish|npm version|git (?:commit|tag|push)/u);
	for (const path of ["packages/agent/package.json", "packages/ai/package.json", "packages/coding-agent/package.json", "packages/tui/package.json"]) {
		assert.equal(JSON.parse(read(path)).private, true, `${path} must remain private`);
	}
});

test("Ubuntu qualification writer binds clean pack, verifier, toolchain, gates, and run identity", () => {
	const fixture = mkdtempSync(join(tmpdir(), "millwright-b003-qualification-"));
	try {
		const inputs = qualificationWriterFixture(fixture);
		const { installedReportSha256, output, result } = runQualificationWriter(fixture, inputs);
		assert.equal(result.status, 0, result.stderr);
		const report = JSON.parse(readFileSync(output, "utf8"));
		assert.equal(report.commit, inputs.sourceCommit);
		assert.equal(report.runId, "123");
		assert.equal(report.runAttempt, 2);
		assert.equal(report.toolchain.node, "22.22.0");
		assert.equal(report.toolchain.npm, "10.9.2");
		assert.equal(report.toolchain.uv, "0.12.6");
		assert.equal(report.artifact.sha256, inputs.artifactSha256);
		for (const gate of Object.values(report.gates)) {
			assert.equal(gate.status, "passed");
			assert.match(gate.outputSha256, /^[0-9a-f]{64}$/u);
		}
		assert.equal(report.installedQualification.reportSha256, installedReportSha256);
		assert.equal(report.installedQualification.sourceCommit, inputs.sourceCommit);
		assert.equal(report.installedQualification.artifactSha256, inputs.artifactSha256);
		assert.deepEqual(report.installedQualification.platform, inputs.installed.platform);
		assert.deepEqual(report.installedQualification.toolchain, inputs.installed.toolchain);
		assert.deepEqual(report.installedQualification.behaviors.map(({ id }) => id), REPORT_IDS);
		assert.deepEqual(report.installedQualification.behaviors.map(({ status }) => status), REPORT_IDS.map(() => "passed"));
		for (const behavior of report.installedQualification.behaviors) {
			assert.match(behavior.stdoutSha256, /^[0-9a-f]{64}$/u);
			assert.match(behavior.stderrSha256, /^[0-9a-f]{64}$/u);
		}
		assert.match(JSON.parse(result.stdout).sha256, /^[0-9a-f]{64}$/u);
		assert.equal(createHash("sha256").update(readFileSync(output)).digest("hex"), JSON.parse(result.stdout).sha256);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("Ubuntu qualification writer rejects missing, failed, substituted, malformed, or unclean installed evidence", () => {
	const cases = [
		["failed behavior", (value) => { value.records[4].status = "failed"; }],
		["duplicate behavior", (value) => { value.records[1].id = value.records[0].id; }],
		["wrong commit", (value) => { value.sourceCommit = "0".repeat(40); }],
		["wrong artifact", (value) => { value.artifact.sha256 = "0".repeat(64); }],
		["unclean driver", (value) => { value.records.at(-1).details.residualPids.push(999); }],
		["unclean daemon", (value) => { value.records[7].details.cases[0].socketStateAfter = true; }],
		...REPORT_IDS.map((id, index) => [`sparse ${id}`, (value) => { value.records[index].details = {}; }]),
		["wrong record exit", (value) => { value.records[0].exitCode = null; }],
		["TUI not initialized", (value) => { value.records[2].details.initialized = false; }],
		["config entrypoints missing", (value) => { value.records[3].details.entrypoints = []; }],
		["session was not persisted", (value) => { value.records[4].details.persisted = false; }],
		["skill diagnostics present", (value) => { value.records[5].details.diagnostics = 1; }],
		["kernel resolved source", (value) => { value.records[6].details.sourcePythonPath = true; }],
		["daemon launcher PID invalid", (value) => { value.records[7].details.cases[0].launcher.pid = 0; }],
		["daemon process group mismatch", (value) => { value.records[7].details.cases[0].daemon.processGroup += 1; }],
		["daemon descendant invalid", (value) => { value.records[7].details.cases[0].descendantIdentitiesBefore.push({ pid: 2 }); }],
		["daemon exit observation invalid", (value) => { value.records[7].details.cases[0].observedExit = 1; }],
		["legacy locations incomplete", (value) => { value.records[8].details.sentinelLocations.pop(); }],
		["refinement persistence missing", (value) => { value.records[9].details.persisted = false; }],
		["refinement call proof missing", (value) => { value.records[9].details.fauxCalls = 0; }],
		["identity surface order changed", (value) => { value.records[10].details.surfaces[1].id = value.records[10].details.surfaces[0].id; }],
		["identity digest malformed", (value) => { value.records[10].details.surfaces[0].sha256 = "bad"; }],
		["identity hit count invalid", (value) => { value.records[10].details.surfaces[0].hitCount = -1; }],
		["identity classification key missing", (value) => { delete value.records[10].details.surfaces[0].classificationCounts[CLASSIFICATION_KEYS[0]]; }],
		["identity aggregate mismatch", (value) => { value.records[10].details.classificationCounts[CLASSIFICATION_KEYS[0]] = 1; }],
		["cleanup removed roots widened", (value) => { value.records[11].details.removedRoots.push("$OTHER"); }],
	];
	for (const [label, mutate] of cases) {
		const fixture = mkdtempSync(join(tmpdir(), "millwright-b003-installed-rejection-"));
		try {
			const inputs = qualificationWriterFixture(fixture, mutate);
			const { result } = runQualificationWriter(fixture, inputs);
			assert.notEqual(result.status, 0, `${label} must fail`);
			assert.ok(result.stderr.trim(), `${label} must report the violated invariant`);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	}
	for (const label of ["missing", "malformed", "wrong digest"]) {
		const fixture = mkdtempSync(join(tmpdir(), "millwright-b003-installed-file-rejection-"));
		try {
			const inputs = qualificationWriterFixture(fixture);
			if (label === "missing") rmSync(inputs.installedPath);
			if (label === "malformed") writeFileSync(inputs.installedPath, "not json\n");
			const digestOverride = label === "wrong digest" ? "0".repeat(64) : undefined;
			const { result } = runQualificationWriter(fixture, inputs, digestOverride);
			assert.notEqual(result.status, 0, `${label} must fail`);
			assert.ok(result.stderr.trim(), `${label} must report the violated invariant`);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	}
});
