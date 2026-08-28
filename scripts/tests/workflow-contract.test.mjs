import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import YAML from "yaml";

const root = resolve(new URL("../..", import.meta.url).pathname);

function read(path) {
	return readFileSync(resolve(root, path), "utf8");
}

function workflow(path) {
	return YAML.parse(read(path));
}

function stepText(job) {
	return YAML.stringify(job.steps || []);
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
	assert.match(fullTests.run, /MILLWRIGHT_OFFLINE=1 npx vitest/u);
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
		"vitest --run --tagsFilter process-stress test/daemon-supervisor-process.test.ts",
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
		"v0.0.1",
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
		const logs = join(fixture, "logs");
		mkdirSync(logs);
		const digest = "a".repeat(64);
		const integrity = `sha512-${Buffer.from("integrity").toString("base64")}`;
		const commit = "b".repeat(40);
		const pack = {
			sourceCommit: commit,
			source: { dirty: false, status: [], trackedSourceManifestSha256: "c".repeat(64) },
			artifact: { filename: "millwright-agent-0.0.1.tgz", sha256: digest, integrity },
		};
		const verified = { sourceCommit: commit, sha256: digest, integrity };
		writeFileSync(join(fixture, "pack.json"), JSON.stringify(pack));
		writeFileSync(join(fixture, "verified.json"), JSON.stringify(verified));
		for (const gate of ["build", "checks", "cleanSource", "installSmoke", "pack", "tests", "types"]) writeFileSync(join(logs, `${gate}.log`), `${gate}\n`);
		const output = join(fixture, "qualification-report.json");
		const result = spawnSync(
			process.execPath,
			[
				resolve(root, "scripts/write-millwright-qualification-report.mjs"),
				"--output", output,
				"--pack-report", join(fixture, "pack.json"),
				"--package-report", join(fixture, "verified.json"),
				"--logs-dir", logs,
			],
			{
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, GITHUB_REPOSITORY: "tim-osterhus/millwright", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" },
			},
		);
		assert.equal(result.status, 0, result.stderr);
		const report = JSON.parse(readFileSync(output, "utf8"));
		assert.equal(report.commit, commit);
		assert.equal(report.runId, "123");
		assert.equal(report.runAttempt, 2);
		assert.equal(report.toolchain.node, "22.22.0");
		assert.equal(report.toolchain.npm, "10.9.2");
		assert.equal(report.toolchain.uv, "0.12.6");
		assert.equal(report.artifact.sha256, digest);
		for (const gate of Object.values(report.gates)) {
			assert.equal(gate.status, "passed");
			assert.match(gate.outputSha256, /^[0-9a-f]{64}$/u);
		}
		assert.match(JSON.parse(result.stdout).sha256, /^[0-9a-f]{64}$/u);
		assert.equal(createHash("sha256").update(readFileSync(output)).digest("hex"), JSON.parse(result.stdout).sha256);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
