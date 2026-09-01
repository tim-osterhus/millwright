import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const sourceRoot = resolve(new URL("../..", import.meta.url).pathname);
const verifier = join(sourceRoot, "scripts", "verify-millwright-release.mjs");
const repository = "tim-osterhus/millwright";
const upstreamCommit = "9f9501146e869466acaca66dac49cff857b7b4f9";

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function integrity(value) {
	return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

function sortJson(value) {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
				.map(([key, child]) => [key, sortJson(child)]),
		);
	}
	return value;
}

function writeCanonical(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(sortJson(value), null, "\t")}\n`);
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
	return result.stdout.trim();
}

function git(repo, ...args) {
	return run("git", args, repo);
}

function sourceTreeSha256(repo, commit) {
	const listing = spawnSync("git", ["ls-tree", "-rz", commit], { cwd: repo, encoding: null });
	assert.equal(listing.status, 0, listing.stderr?.toString());
	const records = [];
	for (const row of listing.stdout.subarray(0, -1).toString("utf8").split("\0")) {
		const match = row.match(/^(\d+) blob ([0-9a-f]{40})\t(.+)$/u);
		if (!match || match[3] === "RELEASE.json") continue;
		const content = readFileSync(join(repo, match[3]));
		records.push({ mode: match[1], path: match[3], digest: sha256(content) });
	}
	records.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
	return sha256(Buffer.from(records.map(({ mode, digest, path }) => `${mode}\t${digest}\t${path}\n`).join(""), "utf8"));
}

function qualificationHash(qualification) {
	const value = structuredClone(qualification);
	delete value.attestationSha256;
	return sha256(Buffer.from(JSON.stringify(sortJson(value)), "utf8"));
}

function createFixture(options = {}) {
	const root = mkdtempSync(join(tmpdir(), "millwright-b003-release-"));
	const repo = join(root, "repo");
	const evidence = join(root, "evidence");
	mkdirSync(repo);
	mkdirSync(evidence);
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "fixture@example.invalid");
	git(repo, "config", "user.name", "Fixture");
	writeCanonical(join(repo, "package.json"), { name: "millwright", private: true, version: "0.7.2" });
	writeFileSync(join(repo, ".node-version"), "22.22.0\n");
	writeFileSync(join(repo, "source.txt"), "qualified source\n");
	if (options.largeTrackedBlob) writeFileSync(join(repo, "large.bin"), Buffer.alloc(1_500_000, 0x5a));
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "qualified source");
	const sourceCommit = git(repo, "rev-parse", "HEAD");
	const sourceTree = sourceTreeSha256(repo, sourceCommit);
	const artifactFile = "millwright-agent-0.0.2.tgz";
	const artifact = Buffer.from(options.artifactBytes || "qualified artifact\n");
	const artifactPath = join(evidence, artifactFile);
	writeFileSync(artifactPath, artifact);
	const artifactSha256 = sha256(artifact);
	const npmIntegrity = integrity(artifact);
	const runId = "123456789";
	const runAttempt = 1;
	const artifactName = `millwright-qualification-ubuntu-${sourceCommit}-${runId}-${runAttempt}`;
	const ubuntuReport = {
		schemaVersion: 1,
		repository,
		runId,
		runAttempt,
		commit: sourceCommit,
		tree: sourceTree,
		toolchain: { node: "22.22.0", npm: "10.9.2", uv: "0.12.6" },
		gates: Object.fromEntries(
			["build", "checks", "cleanSource", "installSmoke", "pack", "tests", "types"].map((gate) => [gate, { status: "passed", outputSha256: sha256(Buffer.from(`${gate}\n`)) }]),
		),
		artifact: { filename: artifactFile, sha256: artifactSha256, integrity: npmIntegrity },
	};
	const ubuntuReportPath = join(evidence, "qualification-report.json");
	writeCanonical(ubuntuReportPath, ubuntuReport);
	const ubuntuRun = {
		repository,
		runId,
		runAttempt,
		headSha: sourceCommit,
		conclusion: "success",
		artifactName,
	};
	const ubuntuRunPath = join(evidence, "ubuntu-run.json");
	writeCanonical(ubuntuRunPath, ubuntuRun);
	const packageReport = {
		schemaVersion: 1,
		package: { name: "millwright-agent", version: "0.0.2" },
		sha256: artifactSha256,
		integrity: npmIntegrity,
		sourceCommit,
		provenance: {
			schemaVersion: 1,
			millwrightVersion: "0.0.2",
			packerVersion: "millwright-release-packer/1",
			sourceCommit,
			trackedSourceManifestSha256: sourceTree,
			stagedInputManifestSha256: "1".repeat(64),
			upstreamPrimeVersion: "0.7.2",
			upstreamPrimeCommit: upstreamCommit,
		},
		installSmoke: { status: "passed" },
	};
	const packageReportPath = join(evidence, "package-report.json");
	writeCanonical(packageReportPath, packageReport);
	const qualification = {
		decision: "approved",
		sourceCommit,
		artifactSha256,
		platformRuns: [
			{ platform: "macos", kind: "local", commit: sourceCommit, artifactSha256, reportSha256: "2".repeat(64) },
			{
				platform: "ubuntu",
				kind: "github-actions",
				repository,
				runId,
				runAttempt,
				commit: sourceCommit,
				artifactSha256,
				reportArtifactName: artifactName,
				reportFile: "qualification-report.json",
				reportSha256: sha256(readFileSync(ubuntuReportPath)),
			},
		],
		reviews: ["spec-conformance", "package-code-quality", "stateful-adversarial"].map((role) => ({ role, verdict: "APPROVE", reportSha256: "3".repeat(64) })),
	};
	qualification.attestationSha256 = qualificationHash(qualification);
	const release = {
		schemaVersion: 1,
		product: "millwright-agent",
		version: "0.0.2",
		sourceCommit,
		sourceTreeSha256: sourceTree,
		artifactFile,
		artifactSha256,
		npmIntegrity,
		upstream: { product: "Prime Agent", version: "0.7.2", commit: upstreamCommit },
		qualification,
	};
	if (options.release) options.release(release);
	if (options.ubuntuRun) options.ubuntuRun(ubuntuRun);
	if (options.ubuntuReport) options.ubuntuReport(ubuntuReport);
	if (options.packageReport) options.packageReport(packageReport);
	if (release.qualification) release.qualification.attestationSha256 = qualificationHash(release.qualification);
	if (options.tamperAttestation) release.qualification.attestationSha256 = "0".repeat(64);
	writeCanonical(join(repo, "RELEASE.json"), release);
	if (options.extraTagFile) writeFileSync(join(repo, "extra.txt"), "not manifest-only\n");
	const tag = options.tag || "v0.0.2";
	if (!options.preTag) {
		git(repo, "add", ".");
		git(repo, "commit", "-qm", "release manifest");
		if (options.lightweightTag) git(repo, "tag", tag);
		else git(repo, "tag", "-am", "Millwright v0.0.2", tag);
		if (options.rewriteReleaseAfterTag) {
			release.fixtureOnlySubstitution = true;
			writeCanonical(join(repo, "RELEASE.json"), release);
		}
	}
	writeCanonical(ubuntuRunPath, ubuntuRun);
	writeCanonical(ubuntuReportPath, ubuntuReport);
	writeCanonical(packageReportPath, packageReport);
	if (options.removeUbuntuRun) rmSync(ubuntuRunPath);
	return { root, repo, evidence, tag, artifactPath, packageReportPath, ubuntuRunPath, ubuntuReportPath };
}

function verifyFixture(fixture, extraArgs = []) {
	return spawnSync(
		process.execPath,
		[
			verifier,
			"--repo", fixture.repo,
			"--release", join(fixture.repo, "RELEASE.json"),
			"--tag", fixture.tag,
			"--artifact", fixture.artifactPath,
			"--package-report", fixture.packageReportPath,
			"--ubuntu-run", fixture.ubuntuRunPath,
			"--ubuntu-report", fixture.ubuntuReportPath,
			...extraArgs,
		],
		{ cwd: sourceRoot, encoding: "utf8" },
	);
}

test("release verifier accepts the exact frozen manifest, tag, artifact, and qualification binding", () => {
	const fixture = createFixture();
	try {
		const result = verifyFixture(fixture);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const report = JSON.parse(result.stdout);
		assert.equal(report.verified, true);
		assert.equal(report.releaseTag, "v0.0.2");
		assert.equal(report.artifactSha256, sha256(readFileSync(fixture.artifactPath)));
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("pre-tag verification accepts a tracked blob larger than the default child-process buffer", () => {
	const fixture = createFixture({ preTag: true, largeTrackedBlob: true });
	try {
		const result = verifyFixture(fixture, ["--pre-tag"]);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const report = JSON.parse(result.stdout);
		assert.equal(report.verified, true);
		assert.equal(report.mode, "pre-tag");
		assert.equal(report.tagCommit, null);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("pre-tag verification waives only absent topology for one untracked release manifest", () => {
	const fixture = createFixture({ preTag: true });
	try {
		const result = verifyFixture(fixture, ["--pre-tag"]);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const report = JSON.parse(result.stdout);
		assert.equal(report.mode, "pre-tag");
		assert.equal(report.tagCommit, null);
		writeFileSync(join(fixture.repo, "unexpected.txt"), "dirty\n");
		const dirty = verifyFixture(fixture, ["--pre-tag"]);
		assert.notEqual(dirty.status, 0);
		assert.match(dirty.stderr, /only untracked RELEASE\.json/u);
		rmSync(join(fixture.repo, "unexpected.txt"));
		git(fixture.repo, "tag", "-am", "premature tag", fixture.tag);
		const alreadyTagged = verifyFixture(fixture, ["--pre-tag"]);
		assert.notEqual(alreadyTagged.status, 0);
		assert.match(alreadyTagged.stderr, /intended tag to be absent/u);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("pre-tag verification rejects a symlinked release manifest", () => {
	const fixture = createFixture({ preTag: true });
	try {
		const releasePath = join(fixture.repo, "RELEASE.json");
		const target = join(fixture.evidence, "release-target.json");
		writeFileSync(target, readFileSync(releasePath));
		rmSync(releasePath);
		symlinkSync(target, releasePath);
		const result = verifyFixture(fixture, ["--pre-tag"]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /RELEASE\.json must be one regular file/u);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("release verifier rejects invalid identity, topology, evidence, and artifact substitutions", () => {
	const cases = [
		["product", { release: (value) => { value.product = "other"; } }],
		["version", { release: (value) => { value.version = "0.0.1"; } }],
		["upstream", { release: (value) => { value.upstream.commit = "0".repeat(40); } }],
		["hash shape", { release: (value) => { value.artifactSha256 = "bad"; } }],
		["source commit", { release: (value) => { value.sourceCommit = "0".repeat(40); } }],
		["source tree", { release: (value) => { value.sourceTreeSha256 = "0".repeat(64); } }],
		["artifact", { artifactBytes: "substituted artifact\n", release: (value) => { value.artifactSha256 = "0".repeat(64); } }],
		["extra manifest commit file", { extraTagFile: true }],
		["lightweight tag", { lightweightTag: true }],
		["wrong tag", { tag: "v0.0.1" }],
		["substituted release file", { rewriteReleaseAfterTag: true }],
		["missing qualification", { release: (value) => { delete value.qualification; } }],
		["qualification attestation", { tamperAttestation: true }],
		["missing run fixture", { removeUbuntuRun: true }],
		["failed run", { ubuntuRun: (value) => { value.conclusion = "failure"; } }],
		["wrong run commit", { ubuntuRun: (value) => { value.headSha = "0".repeat(40); } }],
		["wrong report", { ubuntuReport: (value) => { value.commit = "0".repeat(40); } }],
		["wrong qualification uv", { ubuntuReport: (value) => { value.toolchain.uv = "0.12.5"; } }],
		["wrong package provenance", { packageReport: (value) => { value.provenance.sourceCommit = "0".repeat(40); } }],
	];
	for (const [label, options] of cases) {
		const fixture = createFixture(options);
		try {
			const result = verifyFixture(fixture);
			assert.notEqual(result.status, 0, `${label} must be rejected`);
			assert.ok(result.stderr.trim(), `${label} must identify the violated invariant`);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	}
});
