#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const PRODUCT = "millwright-agent";
const VERSION = "0.0.3";
const TAG = "v0.0.3";
const ARTIFACT = "millwright-agent-0.0.3.tgz";
const NODE_VERSION = "22.22.0";
const NPM_VERSION = "10.9.2";
const UV_VERSION = "0.12.6";
const REPOSITORY = "tim-osterhus/millwright";
const UPSTREAM_VERSION = "0.7.2";
const UPSTREAM_COMMIT = "9f9501146e869466acaca66dac49cff857b7b4f9";
const REVIEW_ROLES = ["spec-conformance", "package-code-quality", "stateful-adversarial"];
const BLOB_BUFFER_ALLOWANCE = 64 * 1024;

function fail(message) {
	throw new Error(message);
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function npmIntegrity(value) {
	return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

function assertRegularFile(path, label, requireNonExecutable = false) {
	let info;
	try {
		info = lstatSync(path);
	} catch (error) {
		fail(`${label} must be one regular file: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be one regular file`);
	if (requireNonExecutable && (info.mode & 0o111) !== 0) fail(`${label} must not be executable`);
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

function parseJson(path, label, canonical = false) {
	let bytes;
	let value;
	try {
		bytes = readFileSync(path);
		value = JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (canonical) {
		const expected = Buffer.from(`${JSON.stringify(sortJson(value), null, "\t")}\n`, "utf8");
		if (!bytes.equals(expected)) fail(`${label} is not canonical sorted JSON`);
	}
	return { bytes, value };
}

function parseArgs(args) {
	const values = {};
	let preTag = false;
	const allowed = new Set(["repo", "release", "tag", "artifact", "package-report", "ubuntu-run", "ubuntu-report"]);
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--pre-tag") {
			if (preTag) fail("Unexpected or duplicate option: --pre-tag");
			preTag = true;
			continue;
		}
		if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
		const key = arg.slice(2);
		if (!allowed.has(key) || values[key] !== undefined) fail(`Unexpected or duplicate option: ${arg}`);
		const value = args[++index];
		if (!value) fail(`${arg} requires a value`);
		values[key] = value;
	}
	for (const key of allowed) if (values[key] === undefined) fail(`--${key} is required`);
	return {
		repo: resolve(values.repo),
		release: resolve(values.release),
		tag: values.tag,
		artifact: resolve(values.artifact),
		packageReport: resolve(values["package-report"]),
		ubuntuRun: resolve(values["ubuntu-run"]),
		ubuntuReport: resolve(values["ubuntu-report"]),
		preTag,
	};
}

function git(repo, args, encoding = "utf8", maxBuffer) {
	const options = { cwd: repo, encoding, stdio: ["ignore", "pipe", "pipe"] };
	if (maxBuffer !== undefined) options.maxBuffer = maxBuffer;
	const result = spawnSync("git", args, options);
	if (result.status !== 0) {
		const detail = result.error?.message || result.stderr?.toString().trim() || "unknown error";
		fail(`git ${args.join(" ")} failed: ${detail}`);
	}
	return result.stdout;
}

function assertHash(value, field) {
	if (!/^[0-9a-f]{64}$/u.test(value || "")) fail(`${field} must be 64 lowercase hexadecimal characters`);
}

function assertCommit(value, field) {
	if (!/^[0-9a-f]{40}$/u.test(value || "")) fail(`${field} must be a 40-character lowercase Git commit`);
}

function sourceTreeSha256(repo, commit) {
	const listing = git(repo, ["ls-tree", "-rlz", commit], null);
	const records = [];
	let cursor = 0;
	while (cursor < listing.length) {
		const end = listing.indexOf(0, cursor);
		if (end === -1) fail("source tree listing is malformed");
		const row = listing.subarray(cursor, end);
		cursor = end + 1;
		if (row.length === 0) continue;
		const tab = row.indexOf(9);
		if (tab === -1) fail("source tree record has no path separator");
		const metadata = row.subarray(0, tab).toString("ascii").match(/^(\d+) (\S+) ([0-9a-f]{40})(?: +(\d+))?$/u);
		const pathBytes = row.subarray(tab + 1);
		const path = pathBytes.toString("utf8");
		if (!metadata || metadata[2] !== "blob" || metadata[4] === undefined) fail(`source tree contains unsupported entry: ${path}`);
		const mode = metadata[1];
		const objectId = metadata[3];
		const size = Number(metadata[4]);
		if (!Number.isSafeInteger(size) || size < 0) fail(`source tree blob size is invalid at ${path}`);
		if (path === "RELEASE.json") continue;
		if (!["100644", "100755"].includes(mode)) fail(`source tree contains a non-regular tracked mode at ${path}`);
		if (/[\t\n\r]/u.test(path)) fail(`source path contains a forbidden control character: ${path}`);
		const maxBuffer = size + BLOB_BUFFER_ALLOWANCE;
		if (!Number.isSafeInteger(maxBuffer)) fail(`source tree blob size is too large for a safe buffer at ${path}`);
		const content = git(repo, ["cat-file", "blob", objectId], null, maxBuffer);
		records.push({ mode, digest: sha256(content), path, pathBytes });
	}
	records.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
	const manifest = records.map(({ mode, digest, path }) => `${mode}\t${digest}\t${path}\n`).join("");
	return sha256(Buffer.from(manifest, "utf8"));
}

function verifyTag(repo, tag, sourceCommit) {
	if (tag !== TAG) fail(`release tag must be exactly ${TAG}`);
	const reference = `refs/tags/${tag}`;
	if (git(repo, ["cat-file", "-t", reference]).trim() !== "tag") fail("release tag must be annotated");
	const tagCommit = git(repo, ["rev-parse", `${reference}^{commit}`]).trim();
	const head = git(repo, ["rev-parse", "HEAD"]).trim();
	if (head !== tagCommit) fail("HEAD must equal the annotated release tag commit");
	const parents = git(repo, ["rev-list", "--parents", "-n", "1", tagCommit]).trim().split(/\s+/u);
	if (parents.length !== 2) fail("release manifest commit must have exactly one parent");
	if (parents[1] !== sourceCommit) fail("release manifest parent does not equal sourceCommit");
	const releaseEntry = git(repo, ["ls-tree", tagCommit, "--", "RELEASE.json"]).trim();
	if (!/^100644 blob [0-9a-f]{40}\tRELEASE\.json$/u.test(releaseEntry)) {
		fail("release tag commit must contain RELEASE.json as a non-executable regular file");
	}
	const sourceManifest = spawnSync("git", ["cat-file", "-e", `${sourceCommit}:RELEASE.json`], {
		cwd: repo,
		stdio: "ignore",
	});
	if (sourceManifest.status === 0) fail("sourceCommit must not already contain RELEASE.json");
	const changed = git(repo, ["diff", "--name-only", "-z", sourceCommit, tagCommit], null)
		.subarray(0, -1)
		.toString("utf8")
		.split("\0")
		.filter(Boolean);
	if (changed.length !== 1 || changed[0] !== "RELEASE.json") fail("release tag commit must add only RELEASE.json");
	return tagCommit;
}

function verifyPreTag(repo, releasePath, tag, sourceCommit) {
	if (tag !== TAG) fail(`intended release tag must be exactly ${TAG}`);
	if (releasePath !== resolve(repo, "RELEASE.json")) fail("pre-tag RELEASE.json must be at the repository root");
	const head = git(repo, ["rev-parse", "HEAD"]).trim();
	if (head !== sourceCommit) fail("pre-tag HEAD must equal sourceCommit");
	const sourceManifest = spawnSync("git", ["cat-file", "-e", `${sourceCommit}:RELEASE.json`], {
		cwd: repo,
		stdio: "ignore",
	});
	if (sourceManifest.status === 0) fail("sourceCommit must not already contain RELEASE.json");
	const tagRef = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], {
		cwd: repo,
		stdio: "ignore",
	});
	if (tagRef.status === 0) fail("pre-tag verification requires the intended tag to be absent");
	const status = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], null);
	if (!status.equals(Buffer.from("?? RELEASE.json\0", "utf8"))) {
		fail("pre-tag worktree may contain only untracked RELEASE.json");
	}
	return null;
}

function qualificationDigest(qualification) {
	const value = structuredClone(qualification);
	delete value.attestationSha256;
	return sha256(Buffer.from(JSON.stringify(sortJson(value)), "utf8"));
}

function verifyQualification(release, ubuntuRun, ubuntuReport, ubuntuReportBytes) {
	const qualification = release.qualification;
	if (!qualification || typeof qualification !== "object") fail("qualification is required");
	if (qualification.decision !== "approved") fail("qualification.decision must be approved");
	if (qualification.sourceCommit !== release.sourceCommit) fail("qualification.sourceCommit must match sourceCommit");
	if (qualification.artifactSha256 !== release.artifactSha256) fail("qualification.artifactSha256 must match artifactSha256");
	assertHash(qualification.attestationSha256, "qualification.attestationSha256");
	if (qualificationDigest(qualification) !== qualification.attestationSha256) fail("qualification.attestationSha256 does not match canonical qualification contents");
	if (!Array.isArray(qualification.platformRuns) || qualification.platformRuns.length !== 2) fail("qualification.platformRuns must contain exactly macOS and Ubuntu");
	const [macos, ubuntu] = qualification.platformRuns;
	if (macos?.platform !== "macos" || macos.kind !== "local") fail("qualification.platformRuns[0] must be the local macOS run");
	if (macos.commit !== release.sourceCommit || macos.artifactSha256 !== release.artifactSha256) fail("macOS qualification binding does not match the release");
	assertHash(macos.reportSha256, "macOS reportSha256");
	if (ubuntu?.platform !== "ubuntu" || ubuntu.kind !== "github-actions") fail("qualification.platformRuns[1] must be the GitHub Actions Ubuntu run");
	if (ubuntu.repository !== REPOSITORY || ubuntu.commit !== release.sourceCommit || ubuntu.artifactSha256 !== release.artifactSha256) fail("Ubuntu qualification binding does not match the release");
	if (!/^\d+$/u.test(String(ubuntu.runId)) || !Number.isInteger(ubuntu.runAttempt) || ubuntu.runAttempt < 1) fail("Ubuntu run ID/attempt are invalid");
	const expectedName = `millwright-qualification-ubuntu-${release.sourceCommit}-${ubuntu.runId}-${ubuntu.runAttempt}`;
	if (ubuntu.reportArtifactName !== expectedName || ubuntu.reportFile !== "qualification-report.json") fail("Ubuntu report artifact binding is invalid");
	assertHash(ubuntu.reportSha256, "Ubuntu reportSha256");
	if (sha256(ubuntuReportBytes) !== ubuntu.reportSha256) fail("Ubuntu qualification report SHA-256 does not match RELEASE.json");
	if (ubuntuRun.repository !== ubuntu.repository || String(ubuntuRun.runId) !== String(ubuntu.runId) || ubuntuRun.runAttempt !== ubuntu.runAttempt) fail("Ubuntu Actions run identity does not match RELEASE.json");
	if (ubuntuRun.headSha !== release.sourceCommit || ubuntuRun.conclusion !== "success" || ubuntuRun.artifactName !== expectedName) fail("Ubuntu Actions run did not successfully qualify the exact source commit");
	if (ubuntuReport.schemaVersion !== 1 || ubuntuReport.repository !== REPOSITORY) fail("Ubuntu qualification report identity is invalid");
	if (String(ubuntuReport.runId) !== String(ubuntu.runId) || ubuntuReport.runAttempt !== ubuntu.runAttempt || ubuntuReport.commit !== release.sourceCommit) fail("Ubuntu qualification report run/source binding is invalid");
	if (ubuntuReport.tree !== release.sourceTreeSha256) fail("Ubuntu qualification report tree does not match sourceTreeSha256");
	if (
		ubuntuReport.toolchain?.node !== NODE_VERSION ||
		ubuntuReport.toolchain?.npm !== NPM_VERSION ||
		ubuntuReport.toolchain?.uv !== UV_VERSION
	) {
		fail("Ubuntu qualification toolchain is not pinned");
	}
	if (ubuntuReport.artifact?.filename !== release.artifactFile || ubuntuReport.artifact?.sha256 !== release.artifactSha256 || ubuntuReport.artifact?.integrity !== release.npmIntegrity) fail("Ubuntu qualification artifact binding is invalid");
	for (const gate of ["build", "checks", "cleanSource", "installSmoke", "pack", "tests", "types"]) {
		const result = ubuntuReport.gates?.[gate];
		if (result?.status !== "passed") fail(`Ubuntu qualification report is missing passed gate ${gate}`);
		assertHash(result.outputSha256, `Ubuntu qualification gate ${gate} outputSha256`);
	}
	if (!Array.isArray(qualification.reviews) || qualification.reviews.length !== REVIEW_ROLES.length) fail("qualification.reviews must contain exactly three reviews");
	qualification.reviews.forEach((review, index) => {
		if (review.role !== REVIEW_ROLES[index]) fail(`qualification.reviews[${index}].role is invalid`);
		if (!["APPROVE", "APPROVE-WITH-NONBLOCKING-NOTES"].includes(review.verdict)) fail(`qualification review ${review.role} is not approved`);
		assertHash(review.reportSha256, `qualification review ${review.role} reportSha256`);
	});
}

function verifyPackageReport(report, release) {
	if (report.schemaVersion !== 1 || report.package?.name !== PRODUCT || report.package?.version !== VERSION) fail("package verifier report identity is invalid");
	if (report.sha256 !== release.artifactSha256 || report.integrity !== release.npmIntegrity) fail("package verifier report artifact digest does not match RELEASE.json");
	if (report.sourceCommit !== release.sourceCommit || report.provenance?.sourceCommit !== release.sourceCommit) fail("package verifier report sourceCommit does not match RELEASE.json");
	if (report.provenance?.millwrightVersion !== VERSION || report.provenance?.packerVersion !== "millwright-release-packer/2") fail("package verifier report provenance version is invalid");
	if (report.provenance?.trackedSourceManifestSha256 !== release.sourceTreeSha256) fail("package verifier tracked-source digest does not match RELEASE.json");
	if (report.provenance?.upstreamPrimeVersion !== UPSTREAM_VERSION || report.provenance?.upstreamPrimeCommit !== UPSTREAM_COMMIT) fail("package verifier upstream provenance does not match RELEASE.json");
	assertHash(report.provenance?.stagedInputManifestSha256, "package provenance stagedInputManifestSha256");
	if (report.installSmoke?.status !== "passed") fail("package verifier install smoke did not pass");
}

function verifyRelease(release) {
	if (release.schemaVersion !== 1) fail("schemaVersion must be 1");
	if (release.product !== PRODUCT) fail(`product must be ${PRODUCT}`);
	if (release.version !== VERSION) fail(`version must be ${VERSION}`);
	assertCommit(release.sourceCommit, "sourceCommit");
	assertHash(release.sourceTreeSha256, "sourceTreeSha256");
	if (release.artifactFile !== ARTIFACT) fail(`artifactFile must be ${ARTIFACT}`);
	assertHash(release.artifactSha256, "artifactSha256");
	if (!/^sha512-[A-Za-z0-9+/]+=*$/u.test(release.npmIntegrity || "")) fail("npmIntegrity is invalid");
	if (release.upstream?.product !== "Prime Agent" || release.upstream?.version !== UPSTREAM_VERSION || release.upstream?.commit !== UPSTREAM_COMMIT) fail("upstream provenance does not match the frozen Prime Agent baseline");
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	assertRegularFile(options.release, "RELEASE.json", true);
	assertRegularFile(options.artifact, "artifact");
	assertRegularFile(options.packageReport, "package verifier report");
	assertRegularFile(options.ubuntuRun, "Ubuntu Actions run fixture");
	assertRegularFile(options.ubuntuReport, "Ubuntu qualification report");
	if (basename(options.artifact) !== ARTIFACT) fail(`artifact filename must be ${ARTIFACT}`);
	const { bytes: releaseBytes, value: release } = parseJson(options.release, "RELEASE.json", true);
	verifyRelease(release);
	if (options.tag !== `v${release.version}`) fail("tag/version binding is invalid");
	const tagCommit = options.preTag
		? verifyPreTag(options.repo, options.release, options.tag, release.sourceCommit)
		: verifyTag(options.repo, options.tag, release.sourceCommit);
	if (tagCommit) {
		const taggedRelease = git(options.repo, ["show", `${tagCommit}:RELEASE.json`], null);
		if (!taggedRelease.equals(releaseBytes)) fail("provided RELEASE.json does not match the annotated tag commit");
	}
	const computedTree = sourceTreeSha256(options.repo, release.sourceCommit);
	if (computedTree !== release.sourceTreeSha256) fail("sourceTreeSha256 does not match the recorded source commit");
	const artifactBytes = readFileSync(options.artifact);
	if (sha256(artifactBytes) !== release.artifactSha256 || npmIntegrity(artifactBytes) !== release.npmIntegrity) fail("rebuilt artifact digest/integrity does not match RELEASE.json");
	const packageReport = parseJson(options.packageReport, "package verifier report").value;
	verifyPackageReport(packageReport, release);
	const ubuntuRun = parseJson(options.ubuntuRun, "Ubuntu Actions run fixture").value;
	const { bytes: ubuntuReportBytes, value: ubuntuReport } = parseJson(options.ubuntuReport, "Ubuntu qualification report", true);
	verifyQualification(release, ubuntuRun, ubuntuReport, ubuntuReportBytes);
	console.log(JSON.stringify(sortJson({
		schemaVersion: 1,
		verified: true,
		mode: options.preTag ? "pre-tag" : "tagged",
		releaseTag: options.tag,
		tagCommit,
		sourceCommit: release.sourceCommit,
		sourceTreeSha256: release.sourceTreeSha256,
		artifactFile: release.artifactFile,
		artifactSha256: release.artifactSha256,
		npmIntegrity: release.npmIntegrity,
	}), null, "\t"));
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
