#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKER_VERSION = "millwright-release-packer/1";
const PUBLIC_NAME = "millwright-agent";
const PUBLIC_VERSION = "0.0.2";
const TAR_MTIME = 499162500;
const BUNDLED = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-tui",
];
const BUNDLED_SET = new Set(BUNDLED);
const LEGACY_PACKAGE_NAMES = new Set([
	"@earendil-works/pi-coding-agent",
	"prime-agent",
	"prime-agent-ai",
	"prime-agent-core",
	"prime-agent-tui",
]);

function fail(message) {
	throw new Error(message);
}

function readJsonBytes(data, label) {
	try {
		return JSON.parse(data.toString("utf8"));
	} catch (error) {
		fail(`Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseArgs(args) {
	let tarball;
	let expectedCommit;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--source-commit") {
			expectedCommit = args[++index];
			if (!expectedCommit) fail("--source-commit requires a value");
		} else if (arg === "--help" || arg === "-h") {
			console.log("Usage: node scripts/verify-millwright-package.mjs /absolute/path/millwright-agent-0.0.2.tgz [source-commit]");
			process.exit(0);
		} else if (arg.startsWith("-")) {
			fail(`Unknown argument: ${arg}`);
		} else if (!tarball) {
			tarball = arg;
		} else if (!expectedCommit) {
			expectedCommit = arg;
		} else {
			fail("Expected exactly one tarball path and one optional source commit");
		}
	}
	if (!tarball) fail("A tarball path is required");
	return { tarball: resolve(tarball), expectedCommit };
}

function octal(buffer) {
	const text = buffer.toString("ascii").replace(/\0.*$/u, "").trim();
	return text ? Number.parseInt(text, 8) : 0;
}

function field(buffer) {
	return buffer.toString("utf8").replace(/\0.*$/u, "");
}

function parseArchive(path) {
	const compressed = readFileSync(path);
	if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) fail("Artifact is not a gzip tarball");
	if (compressed.readUInt32LE(4) !== 0) fail("gzip header mtime must be zero");
	let tar;
	try { tar = gunzipSync(compressed); } catch (error) { fail(`Invalid gzip stream: ${error instanceof Error ? error.message : String(error)}`); }
	const entries = [];
	let offset = 0;
	let ended = false;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) {
			ended = true;
			break;
		}
		const name = field(header.subarray(0, 100));
		const prefix = field(header.subarray(345, 500));
		const pathName = prefix ? `${prefix}/${name}` : name;
		const size = octal(header.subarray(124, 136));
		const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
		const dataStart = offset + 512;
		const dataEnd = dataStart + size;
		if (!pathName.startsWith("package/")) fail(`Unexpected archive path: ${pathName}`);
		if (dataEnd > tar.length) fail(`Truncated archive entry: ${pathName}`);
		if (type !== "0" && type !== "5") fail(`Unsupported archive entry type ${type} at ${pathName}`);
		const mode = octal(header.subarray(100, 108));
		const uid = octal(header.subarray(108, 116));
		const gid = octal(header.subarray(116, 124));
		const mtime = octal(header.subarray(136, 148));
		const uname = field(header.subarray(265, 297));
		const gname = field(header.subarray(297, 329));
		if (uid !== 0 || gid !== 0 || uname !== "" || gname !== "") fail(`Archive owner metadata is not normalized at ${pathName}`);
		if (mtime !== TAR_MTIME) fail(`Archive mtime is not npm's fixed value at ${pathName}`);
		const expectedMode = type === "5" || pathName === "package/dist/bundle/cli.js" ? 0o755 : 0o644;
		if (mode !== expectedMode) fail(`Archive mode ${mode.toString(8)} is not normalized at ${pathName}`);
		entries.push({ path: pathName, type, mode, size, data: Buffer.from(tar.subarray(dataStart, dataEnd)) });
		offset = dataStart + Math.ceil(size / 512) * 512;
	}
	if (!ended) fail("Archive has no tar end marker");
	for (let index = offset; index < tar.length; index += 1) if (tar[index] !== 0) fail("Archive has non-zero trailing bytes after tar end marker");
	for (let index = 1; index < entries.length; index += 1) {
		if (Buffer.compare(Buffer.from(entries[index - 1].path), Buffer.from(entries[index].path)) > 0) fail("Archive paths are not sorted by raw UTF-8 bytes");
	}
	const names = new Set();
	for (const entry of entries) {
		if (names.has(entry.path)) fail(`Archive contains duplicate entry: ${entry.path}`);
		if (entry.path.split("/").includes("__pycache__") || /\.py[co]$/u.test(entry.path)) {
			fail(`Archive contains generated Python bytecode: ${entry.path}`);
		}
		names.add(entry.path);
	}
	return { compressed, entries, files: new Map(entries.filter((entry) => entry.type === "0").map((entry) => [entry.path, entry.data])) };
}

function requireFile(files, path) {
	const data = files.get(`package/${path}`);
	if (!data) fail(`Artifact is missing required file: ${path}`);
	return data;
}

function stagedInputManifestSha256(entries) {
	const records = entries
		.filter((entry) => entry.type === "0" && entry.path !== "package/PROVENANCE.json")
		.map((entry) => ({
			mode: entry.mode === 0o755 ? "100755" : "100644",
			digest: createHash("sha256").update(entry.data).digest("hex"),
			path: entry.path.slice("package/".length),
		}))
		.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
	const manifest = records.map(({ mode, digest, path }) => `${mode}\t${digest}\t${path}\n`).join("");
	return createHash("sha256").update(Buffer.from(manifest, "utf8")).digest("hex");
}

function packageVersion(value) {
	const match = String(value).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(left, right) {
	for (let index = 0; index < 3; index += 1) {
		if (left[index] !== right[index]) return left[index] - right[index];
	}
	return 0;
}

function satisfies(versionText, range) {
	const version = packageVersion(versionText);
	if (!version || typeof range !== "string") return false;
	return range.split("||").some((branch) => {
		const tokens = branch.trim().split(/\s+/u).filter(Boolean);
		return tokens.every((rawToken) => {
			const match = rawToken.match(/^(<=|>=|<|>|=|\^|~)?(\d+)(?:\.(\d+))?(?:\.(\d+))?/u);
			if (!match) return rawToken === "*";
			const operator = match[1] || "=";
			const target = [Number(match[2]), Number(match[3] || 0), Number(match[4] || 0)];
			const comparison = compareVersion(version, target);
			if (operator === ">=") return comparison >= 0;
			if (operator === ">") return comparison > 0;
			if (operator === "<=") return comparison <= 0;
			if (operator === "<") return comparison < 0;
			if (operator === "^") {
				const upper = target[0] > 0 ? [target[0] + 1, 0, 0] : target[1] > 0 ? [0, target[1] + 1, 0] : [0, 0, target[2] + 1];
				return comparison >= 0 && compareVersion(version, upper) < 0;
			}
			if (operator === "~") return comparison >= 0 && compareVersion(version, [target[0], target[1] + 1, 0]) < 0;
			return comparison === 0;
		});
	});
}

function checkExportTargets(value, files, location = "exports") {
	if (typeof value === "string") {
		if (!value.startsWith("./") || !files.has(`package/${value.slice(2)}`)) fail(`${location} points to a missing file: ${value}`);
		return;
	}
	if (!value || typeof value !== "object") fail(`${location} must contain package paths`);
	for (const [key, child] of Object.entries(value)) checkExportTargets(child, files, `${location}.${key}`);
}

function rejectUnsafeValue(value, location) {
	if (typeof value === "string") {
		if (/^(?:file:|https?:\/\/(?:localhost|127\.0\.0\.1|::1)(?::|\/)|\.\.?[\\/]|[\\/])/iu.test(value)) fail(`${location} has an unsafe local/loopback specification: ${value}`);
		if (/\b(?:prime-agent-(?:ai|core|tui)|@earendil-works\/pi-coding-agent|millwright-(?:core|runtime|cli))\b/iu.test(value)) fail(`${location} references an unpublished legacy package: ${value}`);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((entry, index) => rejectUnsafeValue(entry, `${location}[${index}]`));
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) rejectUnsafeValue(child, `${location}.${key}`);
	}
}

function assertSortedKeys(value, location) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const keys = Object.keys(value);
	const sorted = [...keys].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
	if (JSON.stringify(keys) !== JSON.stringify(sorted)) fail(`${location} keys are not canonically sorted`);
	for (const [key, child] of Object.entries(value)) assertSortedKeys(child, `${location}.${key}`);
}


const PUBLIC_IDENTITY_TEXT_EXTENSIONS = /\.(?:cjs|css|d\.ts|html|js|json|md|mjs|py|pyi|sh|toml|ts|tsx|txt|yaml|yml)$/iu;

function isCurrentProductPi(line) {
	return /\bcommand\s*:\s*["']pi["']|\bpi\s+-[A-Za-z]\b|\bpi\s+--[A-Za-z][A-Za-z0-9-]*\b|\b(?:start|use|invoke|inside|exit)\s+(?:the\s+)?pi\b|\bpi(?:['’]s|s')\s+(?:default|current|active|primary|main)\b|\b(?:notify|setTitle|setLabel)\s*\(\s*["']Pi["']/iu.test(
		line,
	);
}

function hasBrandedPi(line) {
	return (
		isCurrentProductPi(line) ||
		/@earendil-works\/pi-|\bpi-(?:mono|skills|package|agent|coding-agent|ai|tui)\b|(?:^|[\s`'"(])(?:~\/)?\.pi(?:[\s`'"/.)]|$)|["']pi["']\s*[:=]|\bpi\s+(?:CLI|command|package|manifest|API|product|agent|is\b)|\bpi\.(?:on|ui|register|send|get|set|exec|append|events|prompts|skills|themes)[A-Za-z0-9_]*\b|\b(?:use|run|invoke)\s+(?:the\s+)?pi\b/iu.test(
			line,
		)
	);
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

function isGeneratedVendorContext(path, line) {
	return path.startsWith("dist/bundle/") || path.startsWith("dist/core/export-html/vendor/") || /sourceMappingURL=/.test(line);
}

function classifyIdentity(path, line, token) {
	const lower = `${path}\n${line}`.toLowerCase();
	const generatedVendor = isGeneratedVendorContext(path, line);
	if (path.startsWith("skills/prime-intellect/") || (generatedVendor && path.startsWith("dist/skills/prime-intellect/"))) {
		return { classification: "provider", reason: "Prime Intellect public skill identity" };
	}
	if (/prime agent traces|prime agent trace|prime-agent-traces|agent-traces|x-prime-team-id/.test(lower) || (token === "prime" && path.includes("telemetry"))) {
		return { classification: "provider", reason: "Prime Agent Traces provider identity" };
	}
	if (/\.prime|\.millrace-cli/.test(lower)) {
		return { classification: "private-internal", reason: "retained legacy-root rejection marker" };
	}
	if (/prime-agent-runtime|prime-agent-skill-|application\/vnd\.prime-agent|ai\.primeintellect\.prime-agent|prime-agent\.sh|prime-agent\.(?:refinement|daemon|worker_|update_)|daemon worker|daemon supervisor|currenttheme/.test(lower)) {
		return { classification: "private-internal", reason: "retained runtime, skill, protocol, or source-launcher identifier" };
	}
	if (token === "Prime Agent" || token === "prime-agent") {
		if (/upstream|provenance|attribution|fork|imported|lineage|license|notice|snapshot|derived|github.com\/primeintellect-ai\/prime-agent/.test(lower)) {
			return { classification: "provenance", reason: "retained upstream Prime Agent provenance" };
		}
		return { classification: "unclassified", reason: "current product identity must use Millwright" };
	}
	if ((token === "Prime" || token === "prime") && /\b(?:current|default)\s+(?:application|command|product|agent|name)\b|\b(?:Pi|pi|Prime|prime)\s+is\s+(?:the\s+)?(?:current|default)\b/.test(lower)) {
		return { classification: "unclassified", reason: "current product identity must use Millwright" };
	}
	if (/^prime_agent_traces_|\bprime_agent_traces_/.test(token.toLowerCase())) {
		return { classification: "provider", reason: "Prime Agent Traces provider configuration" };
	}
	if (/^pi_(?:tui_write_log|timing)$/i.test(token)) {
		return { classification: "private-internal", reason: "retained upstream TUI debugging variable" };
	}
	if (/^PI_[A-Z][A-Z0-9_]*$/.test(token) && (!generatedVendor || /\b(?:env(?:ironment)?|config(?:uration)?|state|setting|current|millwright)\b/.test(lower))) {
		return { classification: "unclassified", reason: "current product identity must use Millwright" };
	}
	if (/prime-butterfly|assets\/brand|prime-logo|prime brand/.test(lower)) {
		return { classification: "attribution", reason: "Prime Intellect brand asset attribution" };
	}
	if (/(?:^|\/)prime-(?:team-selector|onboarding-splash)|(?:^|\/)theme(?:\/|\.|$)/.test(lower)) {
		return { classification: "private-internal", reason: "retained private package, manifest, callback, or API identifier" };
	}
	if (/@earendil-works\/pi-|\bpi-(?:mono|skills|package|agent|coding-agent|ai|tui)\b|\bpi\.(?:on|ui|register|send|get|set|exec|append|events|prompts|skills|themes)\b|\b(?:Pi|pi)\b/.test(token)) {
		if (/upstream|provenance|attribution|fork|imported|lineage|license|notice|pi-mono|pi skills|snapshot/.test(lower)) {
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
		if (/@earendil-works\/pi-|\bpi-(?:mono|skills|package|agent|coding-agent|ai|tui)\b|\bpi\s+packages?\b|\bpi\s+manifest\b|\bpi\.(?:on|ui|register|send|get|set|exec|append|events|prompts|skills|themes)[A-Za-z0-9_]*\b|(?:^|[\s`'"(])(?:~\/)?\.pi(?:[\s`'"/.)]|$)|["']pi["']\s*[:=]/.test(lower)) {
			return { classification: "private-internal", reason: "retained private package, manifest, callback, or API identifier" };
		}
		if (generatedVendor) {
			return { classification: "generated/vendor", reason: "generated bundled or vendored application output" };
		}
		return { classification: "unclassified", reason: "current product identity must use Millwright" };
	}
	if (/prime inference|prime-inference|prime api|primeintellect\.ai|prime intellect|prime-intellect|prime cli|prime-rl|prime team|prime provider/.test(lower)) {
		return { classification: "provider", reason: "Prime Inference or Prime Intellect provider/skill identity" };
	}
	if (/upstream|provenance|attribution|fork|imported|lineage|license|notice|snapshot|derived|github.com\/primeintellect-ai\/prime-agent/.test(lower)) {
		return { classification: "provenance", reason: "retained upstream provenance or attribution" };
	}
	if (generatedVendor) {
		return { classification: "generated/vendor", reason: "generated bundled or vendored application output" };
	}
	return { classification: "unclassified", reason: "not an allowed provider, provenance, attribution, generated/vendor, or private-internal identity" };
}

function scanPublicIdentity(files) {
	const hits = [];
	for (const [archivePath, data] of files) {
		const path = archivePath.slice("package/".length);
		if (!(path === "README.md" || path.startsWith("docs/") || path.startsWith("examples/") || path.startsWith("skills/") || path.startsWith("dist/"))) continue;
		if (!PUBLIC_IDENTITY_TEXT_EXTENSIONS.test(path)) continue;
		const text = data.toString("utf8");
		for (const [index, line] of text.split(/\r?\n/u).entries()) {
			for (const token of identityTokens(line)) {
				const result = classifyIdentity(path, line, token);
				hits.push({ path, line: index + 1, token, ...result });
			}
		}
	}
	return hits;
}

function verifyPublicIdentity(files) {
	const hits = scanPublicIdentity(files);
	const unclassified = hits.filter((hit) => hit.classification === "unclassified");
	if (unclassified.length > 0) fail(`Unclassified public identity hits:\n${JSON.stringify(unclassified, null, 2)}`);
	return {
		schemaVersion: 1,
		files: [...new Set(hits.map((hit) => hit.path))].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
		hitCount: hits.length,
		classificationCounts: Object.fromEntries([...new Set(hits.map((hit) => hit.classification))].sort().map((classification) => [classification, hits.filter((hit) => hit.classification === classification).length])),
		hits,
		unclassified,
	};
}

function verifyPublicManifest(manifest, files) {
	assertSortedKeys(manifest, "public package.json");
	if (manifest.name !== PUBLIC_NAME) fail(`Unexpected public package name: ${manifest.name}`);
	if (manifest.version !== PUBLIC_VERSION) fail(`Unexpected public package version: ${manifest.version}`);
	if (Object.hasOwn(manifest, "private")) fail("Public manifest must not be private");
	if (JSON.stringify(manifest.bin) !== JSON.stringify({ millwright: "dist/bundle/cli.js" })) fail("Public executable mapping is not frozen");
	if (manifest.engines?.node !== ">=22.8.0") fail("Public Node engine floor is not >=22.8.0");
	if (!Array.isArray(manifest.bundledDependencies) || JSON.stringify(manifest.bundledDependencies) !== JSON.stringify(BUNDLED)) fail("Bundled dependency closure is not frozen");
	if (!Array.isArray(manifest.files)) fail("Public manifest must declare files");
	if (JSON.stringify(manifest.files) !== JSON.stringify([...manifest.files].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))))) fail("Public files list is not sorted");
	for (const path of ["dist", "docs", "examples", "skills", "postinstall.cjs", "CHANGELOG.md", "LICENSE", "LICENSES", "NOTICE", "THIRD_PARTY_NOTICES.md", "UPSTREAM.md", "UPSTREAM.json", "PROVENANCE.json"]) {
		if (!manifest.files.includes(path)) fail(`Public manifest does not declare ${path}`);
	}
	if (!files.has("package/dist/bundle/cli.js") || !files.has("package/dist/index.js")) fail("Required built application paths are missing");
	if (!files.has("package/dist/postinstall.js")) fail("Runtime postinstall support is missing");
	if (manifest.exports !== undefined) checkExportTargets(manifest.exports, files);
	if (manifest.main !== undefined) checkExportTargets(manifest.main, files, "main");
	if (manifest.scripts) {
		for (const [name, command] of Object.entries(manifest.scripts)) {
			if (["prepare", "prepublish", "prepublishOnly", "publish", "install"].includes(name)) fail(`Public lifecycle script is not allowed: ${name}`);
			if (typeof command !== "string" || /(?:npm\s+(?:publish|install|pack)|(?:curl|wget)\s|file:|prime-agent|@earendil-works\/pi-)/iu.test(command)) fail(`Unsafe public lifecycle script: ${name}`);
		}
	}
	for (const fieldName of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		const field = manifest[fieldName] || {};
		for (const [name, range] of Object.entries(field)) {
			if (LEGACY_PACKAGE_NAMES.has(name)) fail(`Internal package is not bundled exclusively: ${name}`);
			if (typeof range !== "string" || range.length === 0) fail(`Invalid public dependency range for ${name}`);
		}
	}
	const dependencyNames = new Set(Object.keys(manifest.dependencies || {}));
	for (const name of Object.keys(manifest.optionalDependencies || {})) if (dependencyNames.has(name)) fail(`Dependency conflict between normal and optional closure: ${name}`);
	rejectUnsafeValue({ dependencies: manifest.dependencies, optionalDependencies: manifest.optionalDependencies, peerDependencies: manifest.peerDependencies, scripts: manifest.scripts }, "public manifest");
	if (/prime-agent-(?:ai|core|tui)|@earendil-works\/pi-coding-agent/iu.test(JSON.stringify(manifest))) fail("Public manifest contains a legacy product alias");
}

function verifyInternalPackages(files, manifest) {
	const versions = new Set();
	for (const name of BUNDLED) {
		const prefix = `package/node_modules/${name}/`;
		const internalManifestData = files.get(`${prefix}package.json`);
		if (!internalManifestData) fail(`Missing bundled package manifest: ${name}`);
		const internalManifest = readJsonBytes(internalManifestData, `${name}/package.json`);
		if (internalManifest.name !== name) fail(`Bundled package manifest name mismatch: ${name}`);
		if (!packageVersion(internalManifest.version)) fail(`Bundled package has invalid version: ${name}`);
		versions.add(internalManifest.version);
		const main = typeof internalManifest.main === "string" ? internalManifest.main.replace(/^\.\//u, "") : "dist/index.js";
		if (!files.has(`${prefix}${main}`)) fail(`Bundled package main output is missing: ${name}/${main}`);
		if (![...files.keys()].some((path) => path.startsWith(`${prefix}dist/`))) fail(`Bundled package build output is missing: ${name}`);
		for (const fieldName of ["dependencies", "optionalDependencies", "peerDependencies"]) {
			for (const [dependency, range] of Object.entries(internalManifest[fieldName] || {})) {
				if (dependency.startsWith("@earendil-works/")) {
					if (!BUNDLED_SET.has(dependency)) fail(`Bundled package ${name} references unpublished package ${dependency}`);
					const dependencyData = files.get(`package/node_modules/${dependency}/package.json`);
					const dependencyManifest = dependencyData && readJsonBytes(dependencyData, `${dependency}/package.json`);
					if (!dependencyManifest || !satisfies(dependencyManifest.version, range)) fail(`Bundled dependency range conflict: ${name} requires ${dependency}@${range}`);
				}
			}
		}
	}
	if (versions.size !== 1) fail(`Bundled package versions are inconsistent: ${[...versions].join(", ")}`);
	for (const [path, data] of files) {
		if (!/\.(?:[cm]?js)$/u.test(path)) continue;
		const text = data.toString("utf8");
		const importMetadata = /(?:\bimport\s*(?:[^;]*?\sfrom\s*)?|\bexport\s+(?:[^;]*?\sfrom\s*)?|\brequire\s*\(|\bimport\s*\(|\bimport\.meta\.resolve\s*\()\s*["'`](@earendil-works\/[A-Za-z0-9._-]+)/gu;
		for (const match of text.matchAll(importMetadata)) {
			const name = match[1];
			if (!BUNDLED_SET.has(name)) fail(`JavaScript import references unpublished package ${name} in ${path}`);
			if (!files.has(`package/node_modules/${name}/package.json`)) fail(`JavaScript import cannot resolve bundled package ${name}`);
		}
	}
	for (const name of BUNDLED) {
		if (manifest.dependencies?.[name] === undefined) fail(`Bundled package is absent from the public dependency closure: ${name}`);
	}
}

function sourceCommitFromProvenance(provenance, expected) {
	if (provenance.schemaVersion !== 1) fail("Unsupported provenance schema version");
	if (provenance.packerVersion !== PACKER_VERSION) fail("Unexpected release packer version");
	if (provenance.millwrightVersion !== PUBLIC_VERSION) fail("Provenance Millwright version mismatch");
	if (!/^[0-9a-f]{40}$/u.test(provenance.sourceCommit || "")) fail("Provenance source commit is invalid");
	if (expected && provenance.sourceCommit !== expected) fail(`Artifact source commit ${provenance.sourceCommit} does not match expected ${expected}`);
	if (typeof provenance.upstreamPrimeVersion !== "string" || !provenance.upstreamPrimeVersion) fail("Provenance upstream Prime version is missing");
	if (!/^[0-9a-f]{40}$/u.test(provenance.upstreamPrimeCommit || "")) fail("Provenance upstream Prime commit is invalid");
	if (!/^[0-9a-f]{64}$/u.test(provenance.trackedSourceManifestSha256 || "")) fail("Provenance tracked source digest is invalid");
	if (!/^[0-9a-f]{64}$/u.test(provenance.stagedInputManifestSha256 || "")) fail("Provenance staged input digest is invalid");
	if (Object.keys(provenance).some((key) => /(?:tarball|artifact).*(?:sha|digest)|^(?:sha256|integrity)$/iu.test(key))) fail("Provenance must not contain an outer tarball digest");
	if (provenance.upstream && (provenance.upstream.version !== provenance.upstreamPrimeVersion || provenance.upstream.commit !== provenance.upstreamPrimeCommit)) fail("Provenance upstream fields disagree");
	return provenance.sourceCommit;
}

function npmInvocation() {
	const npmExecPath = process.env.npm_execpath;
	return npmExecPath ? { command: process.execPath, prefix: [npmExecPath] } : { command: "npm", prefix: [] };
}

function runNpm(args, cwd, env) {
	const npm = npmInvocation();
	return spawnSync(npm.command, [...npm.prefix, ...args], {
		cwd,
		env: { ...process.env, ...env, TZ: "UTC", LC_ALL: "C", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function installSmoke(tarball, manifest) {
	const smokeRoot = mkdtempSync(join(tmpdir(), "millwright-package-smoke-"));
	const home = join(smokeRoot, "home");
	const cache = join(smokeRoot, "npm-cache");
	const project = join(smokeRoot, "project");
	mkdirSync(home, { recursive: true });
	mkdirSync(cache, { recursive: true });
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "millwright-smoke-project", version: "1.0.0", private: true })}\n`);
	try {
		const env = { HOME: home, USERPROFILE: home, npm_config_cache: cache, MILLWRIGHT_OFFLINE: "1" };
		const install = runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarball], project, env);
		const installLog = `${install.stdout || ""}\n${install.stderr || ""}`;
		if (install.status !== 0) fail(`Isolated npm install failed: ${installLog.trim()}`);
		if (/(?:prime-agent-(?:ai|core|tui)|@earendil-works\/pi-coding-agent)/iu.test(installLog)) fail("Isolated install attempted an unpublished branded package");
		const installed = join(project, "node_modules", PUBLIC_NAME);
		if (!lstatSync(installed).isDirectory()) fail("Installed public package is missing");
		for (const name of BUNDLED) {
			const bundledPath = join(installed, "node_modules", ...name.split("/"));
			if (!lstatSync(bundledPath).isDirectory()) fail(`Installed bundled package is missing: ${name}`);
		}
		const executable = join(project, "node_modules", ".bin", "millwright");
		const help = spawnSync(executable, ["--help"], { cwd: project, env: { ...process.env, ...env, MILLWRIGHT_OFFLINE: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		if (help.status !== 0) fail(`Installed millwright --help failed: ${help.stderr || help.stdout}`);
		const version = spawnSync(executable, ["--version"], { cwd: project, env: { ...process.env, ...env, MILLWRIGHT_OFFLINE: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		if (version.status !== 0) fail(`Installed millwright --version failed: ${version.stderr || version.stdout}`);
		const helpText = `${help.stdout || ""}\n${help.stderr || ""}`.toLowerCase();
		if (!helpText.includes("millwright")) fail(`Installed help output is not Millwright-branded: ${help.stdout || help.stderr}`);
		if (!`${version.stdout || ""}\n${version.stderr || ""}`.includes(PUBLIC_VERSION)) fail(`Installed version output does not contain ${PUBLIC_VERSION}: ${version.stdout || version.stderr}`);
		return {
			status: "passed",
			project: "synthetic",
			package: manifest.name,
			installExitCode: install.status,
			unpublishedBrandedFetch: false,
			helpContainsMillwright: helpText.includes("millwright"),
			helpContainsCommand: helpText.includes("millwright"),
			versionOutput: (version.stdout || version.stderr).trim().split(/\r?\n/u)[0],
		};
	} finally {
		rmSync(smokeRoot, { recursive: true, force: true });
	}
}

async function main() {
	const { tarball, expectedCommit } = parseArgs(process.argv.slice(2));
	if (!tarball.endsWith(`${PUBLIC_NAME}-${PUBLIC_VERSION}.tgz`)) fail(`Unexpected artifact filename: ${tarball}`);
	const info = lstatSync(tarball);
	if (!info.isFile() || info.isSymbolicLink()) fail("Tarball must be a regular file");
	const parent = dirname(tarball);
	const siblings = readdirSync(parent).filter((entry) => entry.endsWith(".tgz"));
	if (siblings.length !== 1 || siblings[0] !== `${PUBLIC_NAME}-${PUBLIC_VERSION}.tgz`) fail("Verifier requires exactly one public tarball in its output directory");
	const archive = parseArchive(tarball);
	const files = archive.files;
	const manifest = readJsonBytes(requireFile(files, "package.json"), "package/package.json");
	verifyPublicManifest(manifest, files);
	verifyInternalPackages(files, manifest);
	const publicIdentity = verifyPublicIdentity(files);
	for (const required of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "UPSTREAM.md", "UPSTREAM.json", "LICENSES/Prime-Agent-MIT.txt", "LICENSES/OpenTUI-MIT.txt", "PROVENANCE.json"]) requireFile(files, required);
	if (!/Apache License/iu.test(requireFile(files, "LICENSE").toString("utf8"))) fail("Apache license text is missing");
	if (!/MIT License/iu.test(requireFile(files, "LICENSES/Prime-Agent-MIT.txt").toString("utf8"))) fail("Upstream MIT license text is missing");
	const openTuiLicense = requireFile(files, "LICENSES/OpenTUI-MIT.txt").toString("utf8");
	if (!/MIT License/iu.test(openTuiLicense) || !/Copyright \(c\) 2025 opentui/iu.test(openTuiLicense)) fail("OpenTUI MIT attribution is missing");
	const noticeText = requireFile(files, "NOTICE").toString("utf8");
	const thirdPartyText = requireFile(files, "THIRD_PARTY_NOTICES.md").toString("utf8");
	const upstreamText = requireFile(files, "UPSTREAM.md").toString("utf8");
	if (!/Millwright/iu.test(noticeText) || !/Prime Agent/iu.test(noticeText) || !/Prime-Agent-MIT\.txt/iu.test(noticeText)) fail("NOTICE does not preserve required attribution");
	if (!/Prime Agent/iu.test(thirdPartyText) || !/OpenTUI/iu.test(thirdPartyText) || !/MIT/iu.test(thirdPartyText)) fail("Third-party notice does not preserve required attribution");
	if (!/Prime Agent/iu.test(upstreamText) || !/9f9501146e869466acaca66dac49cff857b7b4f9/iu.test(upstreamText)) fail("UPSTREAM.md does not identify the imported revision");
	const upstreamManifest = readJsonBytes(requireFile(files, "UPSTREAM.json"), "package/UPSTREAM.json");
	if (upstreamManifest.upstream?.release !== "0.7.2" || upstreamManifest.upstream?.declaredCommit !== "9f9501146e869466acaca66dac49cff857b7b4f9") fail("UPSTREAM.json does not identify the imported revision");
	const provenance = readJsonBytes(requireFile(files, "PROVENANCE.json"), "package/PROVENANCE.json");
	assertSortedKeys(provenance, "PROVENANCE.json");
	const sourceCommit = sourceCommitFromProvenance(provenance, expectedCommit);
	const stagedInputSha256 = stagedInputManifestSha256(archive.entries);
	if (provenance.stagedInputManifestSha256 !== stagedInputSha256) fail("Provenance staged input digest does not match artifact contents");
	const unpackedFiles = archive.entries.filter((entry) => entry.type === "0").map((entry) => ({
		path: entry.path.slice("package/".length),
		mode: entry.mode.toString(8).padStart(6, "0"),
		size: entry.size,
		sha256: createHash("sha256").update(entry.data).digest("hex"),
	}));
	const dependencies = Object.fromEntries(Object.entries(manifest.dependencies || {}).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right))));
	const optionalDependencies = Object.fromEntries(Object.entries(manifest.optionalDependencies || {}).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right))));
	const externalDependencies = Object.fromEntries(Object.entries(dependencies).filter(([name]) => !BUNDLED_SET.has(name)));
	const dependencyInventory = [
		...Object.entries(dependencies).map(([name, range]) => ({ name, range, optional: false })),
		...Object.entries(optionalDependencies).map(([name, range]) => ({ name, range, optional: true })),
	].sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
	const bytes = archive.compressed;
	const result = {
		schemaVersion: 1,
		publicIdentity,
		package: {
			name: manifest.name,
			version: manifest.version,
			bin: manifest.bin,
			engines: manifest.engines,
			exports: manifest.exports,
			files: manifest.files,
		},
		sha256: createHash("sha256").update(bytes).digest("hex"),
		integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
		archive: { entryCount: archive.entries.length, unpackedSize: archive.entries.reduce((sum, entry) => sum + entry.size, 0) },
		bundledDependencies: [...manifest.bundledDependencies],
		dependencies,
		externalDependencies,
		optionalDependencies,
		dependencyInventory,
		unpackedFiles,
		provenance,
		installSmoke: process.env.MILLWRIGHT_SKIP_INSTALL_SMOKE === "1" ? { status: "skipped" } : await installSmoke(tarball, manifest),
		sourceCommit,
	};
	console.log(JSON.stringify(result, null, "\t"));
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
