#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, gunzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKER_VERSION = "millwright-release-packer/1";
const REQUIRED_NODE = "22.22.0";
const REQUIRED_NPM = "10.9.2";
const PUBLIC_NAME = "millwright-agent";
const PUBLIC_VERSION = "0.0.2";
const PUBLIC_COMMAND = "millwright";
const TAR_MTIME = 499162500;
const BUNDLED = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-tui",
];
const WORKSPACES = [
	{ directory: "packages/agent", key: "agent", name: "@earendil-works/pi-agent-core" },
	{ directory: "packages/ai", key: "ai", name: "@earendil-works/pi-ai" },
	{ directory: "packages/coding-agent", key: "coding-agent", name: "@earendil-works/pi-coding-agent" },
	{ directory: "packages/tui", key: "tui", name: "@earendil-works/pi-tui" },
];
const ATTRIBUTION_FILES = ["CHANGELOG.md", "LICENSE", "NOTICE", "README.md", "THIRD_PARTY_NOTICES.md", "UPSTREAM.md", "UPSTREAM.json"];

function fail(message) {
	throw new Error(message);
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`Unable to read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function sortJson(value) {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
				.map(([key, entry]) => [key, sortJson(entry)]),
		);
	}
	return value;
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(sortJson(value), null, "\t")}\n`);
}

function parseArgs(args) {
	let output;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--output") {
			if (output !== undefined) fail("--output may be supplied only once");
			output = args[++index];
			if (!output) fail("--output requires an absolute existing empty directory");
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			console.log("Usage: npm run pack:release -- --output /absolute/empty/output");
			process.exit(0);
		}
		fail(`Unknown argument: ${arg}`);
	}
	if (!output) fail("--output is required");
	if (/[\u0000\t\n\r]/u.test(output) || /(?:^|[\\/])(?:\$\{|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%)/u.test(output)) {
		fail(`Refusing unresolved environment-variable output path: ${output}`);
	}
	if (!isAbsolute(output)) fail(`--output must be absolute: ${output}`);
	return resolve(output);
}

function pathIsWithin(parent, child) {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertOutputDirectory(output) {
	if (output === sep) fail("Refusing filesystem root as output directory");
	const outputStat = (() => {
		try {
			return lstatSync(output);
		} catch (error) {
			fail(`Output directory must already exist: ${output}`);
		}
	})();
	if (outputStat.isSymbolicLink()) fail(`Output directory must not be a symlink: ${output}`);
	if (!outputStat.isDirectory()) fail(`Output path must be a directory: ${output}`);
	const realOutput = realpathSync(output);
	const realRoot = realpathSync(root);
	const realHome = realpathSync(homedir());
	if (realOutput === realHome) fail(`Refusing home directory as output directory: ${output}`);
	if (realOutput === realRoot || pathIsWithin(realRoot, realOutput)) {
		fail(`Output directory must be outside the repository: ${output}`);
	}
	if (readdirSync(output, { withFileTypes: true }).length !== 0) {
		fail(`Output directory must be empty: ${output}`);
	}
	return realOutput;
}

function npmVersionFromEnvironment() {
	const npmExecPath = process.env.npm_execpath;
	const result = npmExecPath
		? spawnSync(process.execPath, [npmExecPath, "--version"], { encoding: "utf8" })
		: spawnSync("npm", ["--version"], { encoding: "utf8" });
	if (result.status !== 0) fail("Unable to determine npm version");
	const version = result.stdout.trim();
	if (/^\d+\.\d+\.\d+$/u.test(version)) return version;
	const match = process.env.npm_config_user_agent?.match(/(?:^|\s)npm\/(\d+\.\d+\.\d+)(?:\s|$)/u);
	if (match) return match[1];
	fail(`Unable to parse npm version: ${version}`);
}

function assertToolchain() {
	if (process.versions.node !== REQUIRED_NODE) {
		fail(`Release packing requires Node ${REQUIRED_NODE}; found ${process.versions.node}`);
	}
	const npmVersion = npmVersionFromEnvironment();
	if (npmVersion !== REQUIRED_NPM) {
		fail(`Release packing requires npm ${REQUIRED_NPM}; found ${npmVersion}`);
	}
	return npmVersion;
}

function commandEnvironment() {
	return {
		...process.env,
		TZ: "UTC",
		LC_ALL: "C",
		SOURCE_DATE_EPOCH: "0",
		NPM_CONFIG_AUDIT: "false",
		NPM_CONFIG_FUND: "false",
		NPM_CONFIG_UPDATE_NOTIFIER: "false",
	};
}

function run(command, args, cwd, label = `${command} ${args.join(" ")}`, options = {}) {
	const result = spawnSync(command, args, {
		cwd,
		env: commandEnvironment(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (!options.quiet && result.stdout) process.stdout.write(result.stdout);
	if (result.status !== 0) {
		if (result.stderr) process.stderr.write(result.stderr);
		fail(`${label} failed with exit code ${result.status ?? "unknown"}`);
	}
	if (result.stderr) process.stderr.write(result.stderr);
	return result.stdout.trim();
}

function npmInvocation() {
	const npmExecPath = process.env.npm_execpath;
	if (npmExecPath) return { command: process.execPath, prefix: [npmExecPath] };
	return { command: "npm", prefix: [] };
}

function runNpm(args, cwd, label, options = {}) {
	const npm = npmInvocation();
	return run(npm.command, [...npm.prefix, ...args], cwd, label || `npm ${args.join(" ")}`, options);
}

function git(args, options = {}) {
	const result = spawnSync("git", args, {
		cwd: root,
		encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr?.trim() || "unknown error"}`);
	return result.stdout;
}

const BUILD_LOCK = join(
	tmpdir(),
	`millwright-release-build-${createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 24)}.lock`,
);

function acquireBuildLock() {
	const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
	for (let attempt = 0; attempt < 3600; attempt += 1) {
		try {
			mkdirSync(BUILD_LOCK);
			writeFileSync(join(BUILD_LOCK, "owner"), `${process.pid}\n`);
			return;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			let owner;
			try { owner = Number.parseInt(readFileSync(join(BUILD_LOCK, "owner"), "utf8"), 10); } catch { owner = undefined; }
			if (owner === process.pid) fail(`Release build lock is re-entrant: ${BUILD_LOCK}`);
			if (!owner) {
				let ageMs;
				try { ageMs = Date.now() - statSync(BUILD_LOCK).mtimeMs; } catch { ageMs = 0; }
				if (ageMs > 5_000) {
					rmSync(BUILD_LOCK, { recursive: true, force: true });
					continue;
				}
				Atomics.wait(waitBuffer, 0, 0, 100);
				continue;
			}
			try {
				process.kill(owner, 0);
			} catch (probeError) {
				if (probeError.code === "ESRCH") {
					rmSync(BUILD_LOCK, { recursive: true, force: true });
					continue;
				}
			}
			Atomics.wait(waitBuffer, 0, 0, 100);
		}
	}
	fail(`Timed out waiting for release build lock: ${BUILD_LOCK}`);
}

function releaseBuildLock() {
	rmSync(BUILD_LOCK, { recursive: true, force: true });
}

function sourceState() {
	const commit = git(["rev-parse", "HEAD"]).trim();
	const status = git(["status", "--porcelain=v1", "--untracked-files=all"])
		.split("\n")
		.filter(Boolean);
	return { commit, dirty: status.length > 0, status };
}

function gitTrackedManifest() {
	const listing = git(["ls-files", "--stage", "-z"], { encoding: null });
	const records = [];
	let cursor = 0;
	while (cursor < listing.length) {
		const end = listing.indexOf(0, cursor);
		if (end === -1) fail("Malformed git ls-files output");
		const record = listing.subarray(cursor, end);
		cursor = end + 1;
		const tab = record.indexOf(9);
		if (tab === -1) fail("Malformed git ls-files record");
		const metadata = record.subarray(0, tab).toString("ascii").split(" ");
		const mode = metadata[0];
		const pathBytes = record.subarray(tab + 1);
		const path = pathBytes.toString("utf8");
		if (/[\u0009\u000a\u000d]/u.test(path)) fail(`Tracked path contains a forbidden control character: ${path}`);
		if (path === "RELEASE.json") continue;
		let content;
		const localPath = join(root, ...path.split("/"));
		try {
			const info = lstatSync(localPath);
			if (!info.isFile()) fail(`Tracked source path is not a regular file: ${path}`);
			content = readFileSync(localPath);
		} catch (error) {
			// A deleted tracked file still has an index blob. The digest describes the
			// tracked input rather than silently dropping the record.
			const blob = spawnSync("git", ["show", `:${path}`], {
				cwd: root,
				encoding: null,
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (blob.status !== 0) fail(`Unable to read tracked source ${path}`);
			content = blob.stdout;
		}
		const digest = createHash("sha256").update(content).digest("hex");
		records.push({ mode, digest, path, pathBytes });
	}
	records.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
	const manifest = records.map(({ mode, digest, path }) => `${mode}\t${digest}\t${path}\n`).join("");
	return {
		manifest,
		sha256: createHash("sha256").update(Buffer.from(manifest, "utf8")).digest("hex"),
		fileCount: records.length,
	};
}

function assertSourceManifests() {
	const sources = new Map();
	for (const workspace of WORKSPACES) {
		const path = join(root, workspace.directory, "package.json");
		const manifest = readJson(path);
		if (manifest.name !== workspace.name) fail(`Unexpected source package name in ${path}`);
		if (manifest.private !== true) fail(`Source workspace must be private: ${path}`);
		sources.set(workspace.key, { workspace, manifest, path });
	}
	const coding = sources.get("coding-agent").manifest;
	if (coding.version !== "0.7.2") fail(`Unexpected coding-agent source version: ${coding.version}`);
	return sources;
}

function parseVersion(value) {
	const match = String(value).trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/u);
	if (!match) return null;
	return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareVersion(left, right) {
	for (let index = 0; index < 3; index += 1) {
		if (left[index] !== right[index]) return left[index] - right[index];
	}
	return 0;
}

function nextMajor(version) { return [version[0] + 1, 0, 0]; }
function nextMinor(version) { return [version[0], version[1] + 1, 0]; }
function nextPatch(version) { return [version[0], version[1], version[2] + 1]; }

function rangeIntervals(range) {
	if (typeof range !== "string" || range.trim() === "") fail(`Invalid dependency range: ${range}`);
	const branches = range.split("||").map((branch) => branch.trim());
	const intervals = [];
	for (const branch of branches) {
		if (!branch) fail(`Invalid dependency range: ${range}`);
		let lower = { value: [0, 0, 0], inclusive: true };
		let upper = null;
		const tokens = branch.replace(/\s+-\s+/u, " - ").split(/\s+/u).filter(Boolean);
		if (tokens.length === 3 && tokens[1] === "-") {
			const first = parseVersion(tokens[0]);
			const last = parseVersion(tokens[2]);
			if (!first || !last) fail(`Unsupported dependency range: ${range}`);
			lower = { value: first, inclusive: true };
			upper = { value: last, inclusive: true };
		} else {
			for (let token of tokens) {
				let operator = "";
				const opMatch = token.match(/^(<=|>=|<|>|=|\^|~)/u);
				if (opMatch) {
					operator = opMatch[1];
					token = token.slice(operator.length);
				}
				const wildcard = token.match(/^(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/u);
				if (wildcard && !operator && (wildcard[2] === undefined || /[xX*]/u.test(wildcard[2]) || wildcard[3] === undefined || /[xX*]/u.test(wildcard[3]))) {
					if (/^[xX*]$/u.test(wildcard[1])) continue;
					const major = Number(wildcard[1]);
					if (wildcard[2] === undefined || /[xX*]/u.test(wildcard[2])) {
						lower = { value: [major, 0, 0], inclusive: true };
						upper = { value: [major + 1, 0, 0], inclusive: false };
					} else {
						const minor = Number(wildcard[2]);
						lower = { value: [major, minor, 0], inclusive: true };
						upper = { value: [major, minor + 1, 0], inclusive: false };
					}
					continue;
				}
				const version = parseVersion(token);
				if (!version) fail(`Unsupported dependency range: ${range}`);
				if (operator === "^") {
					const next = version[0] > 0 ? nextMajor(version) : version[1] > 0 ? nextMinor(version) : nextPatch(version);
					lower = { value: version, inclusive: true };
					upper = { value: next, inclusive: false };
				} else if (operator === "~") {
					lower = { value: version, inclusive: true };
					upper = { value: nextMinor(version), inclusive: false };
				} else if (operator === ">=") {
					lower = { value: version, inclusive: true };
				} else if (operator === ">") {
					lower = { value: version, inclusive: false };
				} else if (operator === "<=") {
					upper = { value: version, inclusive: true };
				} else if (operator === "<") {
					upper = { value: version, inclusive: false };
				} else {
					lower = { value: version, inclusive: true };
					upper = { value: version, inclusive: true };
				}
			}
		}
		if (upper && (compareVersion(lower.value, upper.value) > 0 || (compareVersion(lower.value, upper.value) === 0 && (!lower.inclusive || !upper.inclusive)))) continue;
		intervals.push({ lower, upper });
	}
	if (intervals.length === 0) fail(`Unsatisfiable dependency range: ${range}`);
	return intervals;
}

function boundMax(left, right) {
	if (!left) return right;
	if (!right) return left;
	const comparison = compareVersion(left.value, right.value);
	if (comparison > 0) return left;
	if (comparison < 0) return right;
	return { value: left.value, inclusive: left.inclusive && right.inclusive };
}

function boundMin(left, right) {
	if (!left) return right;
	if (!right) return left;
	const comparison = compareVersion(left.value, right.value);
	if (comparison < 0) return left;
	if (comparison > 0) return right;
	return { value: left.value, inclusive: left.inclusive && right.inclusive };
}

function intervalContains(outer, inner) {
	const lowerOk = !outer.lower || (inner.lower && (compareVersion(inner.lower.value, outer.lower.value) > 0 || (compareVersion(inner.lower.value, outer.lower.value) === 0 && (outer.lower.inclusive || !inner.lower.inclusive))));
	const upperOk = !outer.upper || (inner.upper && (compareVersion(inner.upper.value, outer.upper.value) < 0 || (compareVersion(inner.upper.value, outer.upper.value) === 0 && (outer.upper.inclusive || !inner.upper.inclusive))));
	return lowerOk && upperOk;
}

function intervalsCover(intervals, candidate) {
	return intervals.some((interval) => intervalContains(interval, candidate));
}

function intersectRanges(ranges) {
	const parsed = ranges.map((entry) => ({ ...entry, intervals: rangeIntervals(entry.range) }));
	for (const candidate of parsed) {
		if (candidate.intervals.every((interval) => parsed.every((other) => intervalsCover(other.intervals, interval)))) return candidate.range;
	}
	const intersections = [];
	for (const left of parsed[0].intervals) {
		let current = left;
		for (const other of parsed.slice(1)) {
			const possible = [];
			for (const right of other.intervals) {
				const lower = boundMax(current.lower, right.lower);
				const upper = boundMin(current.upper, right.upper);
				if (!upper || compareVersion(lower?.value || [0, 0, 0], upper.value) < 0 || (compareVersion(lower?.value || [0, 0, 0], upper.value) === 0 && lower.inclusive && upper.inclusive)) {
					possible.push({ lower, upper });
				}
			}
			if (possible.length === 0) {
				current = null;
				break;
			}
			current = possible[0];
		}
		if (current) intersections.push(current);
	}
	if (intersections.length === 0) return null;
	const interval = intersections[0];
	const format = (bound, isLower) => {
		if (!bound) return "";
		const value = bound.value.join(".");
		if (isLower) return `${bound.inclusive ? ">=" : ">"}${value}`;
		return `${bound.inclusive ? "<=" : "<"}${value}`;
	};
	const result = [format(interval.lower, true), format(interval.upper, false)].filter(Boolean).join(" ");
	return result || "*";
}

function publicDependencies(sources) {
	const entries = new Map();
	for (const { manifest, workspace } of sources.values()) {
		for (const field of ["dependencies", "optionalDependencies"]) {
			for (const [name, range] of Object.entries(manifest[field] || {})) {
				const existing = entries.get(name) || { ranges: [], optional: true };
				existing.ranges.push({ range, source: `${workspace.directory}:${field}` });
				if (field === "dependencies") existing.optional = false;
				entries.set(name, existing);
			}
		}
	}
	const dependencies = {};
	const optionalDependencies = {};
	for (const name of [...entries.keys()].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))) {
		const entry = entries.get(name);
		const range = intersectRanges(entry.ranges);
		if (!range) {
			const details = entry.ranges.map(({ range: value, source }) => `${source}=${value}`).join(", ");
			fail(`Dependency range conflict for ${name}: ${details}`);
		}
		(entry.optional ? optionalDependencies : dependencies)[name] = range;
	}
	return { dependencies, optionalDependencies };
}

function ensureRegularSource(path) {
	const info = lstatSync(path);
	if (info.isSymbolicLink()) fail(`Refusing symlink input: ${path}`);
	if (!info.isFile()) fail(`Expected regular file: ${path}`);
}

function copyTree(source, target) {
	const name = basename(source);
	if ([".DS_Store", ".gitignore", ".npmignore", "__pycache__"].includes(name) || /\.py[co]$/u.test(name)) return;
	const info = lstatSync(source);
	if (info.isSymbolicLink()) fail(`Refusing symlink input: ${source}`);
	if (info.isFile()) {
		ensureRegularSource(source);
		copyFileSync(source, target);
		return;
	}
	if (!info.isDirectory()) fail(`Refusing non-regular input: ${source}`);
	mkdirSyncSafe(target);
	for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))) {
		copyTree(join(source, entry.name), join(target, entry.name));
	}
}

function mkdirSyncSafe(path) {
	mkdirSync(path, { recursive: true });
}

function copyIfPresent(source, target) {
	if (!lstatSafe(source)) return;
	copyTree(source, target);
}

function lstatSafe(path) {
	try { return lstatSync(path); } catch { return null; }
}

function packageFiles(sourceDir, manifest) {
	const entries = new Set(["README.md"]);
	for (const item of manifest.files || []) entries.add(item.split(/[\\/]/u)[0]);
	if (manifest.name === "@earendil-works/pi-coding-agent") entries.add("CHANGELOG.md");
	return [...entries].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function sanitizedInternalManifest(manifest) {
	const result = { ...manifest, private: true };
	delete result.scripts;
	delete result.devDependencies;
	delete result.overrides;
	return result;
}

function createPublicManifest(codingManifest, dependencies) {
	const result = { ...codingManifest };
	result.name = PUBLIC_NAME;
	result.version = PUBLIC_VERSION;
	result.bin = { [PUBLIC_COMMAND]: "dist/bundle/cli.js" };
	result.engines = { ...(result.engines || {}), node: ">=22.8.0" };
	result.dependencies = dependencies.dependencies;
	result.optionalDependencies = dependencies.optionalDependencies;
	result.bundledDependencies = [...BUNDLED];
	result.files = [
		"CHANGELOG.md",
		"LICENSE",
		"LICENSES",
		"NOTICE",
		"THIRD_PARTY_NOTICES.md",
		"UPSTREAM.json",
		"UPSTREAM.md",
		"dist",
		"docs",
		"examples",
		"postinstall.cjs",
		"PROVENANCE.json",
		"skills",
	].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
	result.scripts = result.scripts?.postinstall ? { postinstall: result.scripts.postinstall } : undefined;
	result.license = "Apache-2.0";
	delete result.private;
	delete result.devDependencies;
	delete result.overrides;
	delete result.bundleDependencies;
	return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

function normalizeTree(path, relativePath = "") {
	const info = lstatSync(path);
	if (info.isSymbolicLink()) fail(`Staged tree contains symlink: ${path}`);
	if (info.isDirectory()) {
		chmodSync(path, 0o755);
		for (const entry of readdirSync(path)) normalizeTree(join(path, entry), relativePath ? `${relativePath}/${entry}` : entry);
		return;
	}
	if (!info.isFile()) fail(`Staged tree contains non-regular entry: ${path}`);
	chmodSync(path, relativePath === "dist/bundle/cli.js" ? 0o755 : 0o644);
}

function stagedInputManifest(stage) {
	const records = [];
	function visit(path, relativePath) {
		const info = lstatSync(path);
		if (info.isSymbolicLink()) fail(`Staged input contains symlink: ${relativePath}`);
		if (info.isDirectory()) {
			for (const entry of readdirSync(path)) visit(join(path, entry), relativePath ? `${relativePath}/${entry}` : entry);
			return;
		}
		if (!info.isFile()) fail(`Staged input contains non-regular entry: ${relativePath}`);
		if (relativePath === "PROVENANCE.json") return;
		const mode = relativePath === "dist/bundle/cli.js" ? "100755" : "100644";
		const pathBytes = Buffer.from(relativePath, "utf8");
		if (/[\u0009\u000a\u000d]/u.test(relativePath)) fail(`Staged path contains a forbidden control character: ${relativePath}`);
		records.push({ mode, digest: createHash("sha256").update(readFileSync(path)).digest("hex"), relativePath, pathBytes });
	}
	visit(stage, "");
	records.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
	const manifest = records.map(({ mode, digest, relativePath }) => `${mode}\t${digest}\t${relativePath}\n`).join("");
	return { manifest, sha256: createHash("sha256").update(Buffer.from(manifest, "utf8")).digest("hex"), fileCount: records.length };
}

function deterministicGzip(input) {
	const chunks = [Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x03])];
	let offset = 0;
	do {
		const size = Math.min(0xffff, input.length - offset);
		const block = Buffer.allocUnsafe(5 + size);
		block[0] = offset + size === input.length ? 1 : 0;
		block.writeUInt16LE(size, 1);
		block.writeUInt16LE((~size) & 0xffff, 3);
		input.copy(block, 5, offset, offset + size);
		chunks.push(block);
		offset += size;
	} while (offset < input.length);
	const trailer = Buffer.allocUnsafe(8);
	trailer.writeUInt32LE(crc32(input), 0);
	trailer.writeUInt32LE(input.length >>> 0, 4);
	chunks.push(trailer);
	return Buffer.concat(chunks);
}

function sortNpmArchive(path) {
	const compressed = readFileSync(path);
	const tar = gunzipSync(compressed);
	const entries = [];
	let offset = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = tar.subarray(offset, offset + 100).toString("utf8").replace(/\0.*$/u, "");
		const prefix = tar.subarray(offset + 345, offset + 500).toString("utf8").replace(/\0.*$/u, "");
		const entryPath = prefix ? `${prefix}/${name}` : name;
		const sizeText = tar.subarray(offset + 124, offset + 136).toString("ascii").replace(/\0.*$/u, "").trim();
		const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
		const next = offset + 512 + Math.ceil(size / 512) * 512;
		if (next > tar.length) fail(`Truncated npm archive entry: ${entryPath}`);
		entries.push({ path: entryPath, bytes: Buffer.from(tar.subarray(offset, next)) });
		offset = next;
	}
	entries.sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
	const normalizedTar = Buffer.concat([...entries.map((entry) => entry.bytes), Buffer.alloc(1024)]);
	// Native zlib can choose different DEFLATE matches across platform builds.
	// Stored blocks keep the canonical tar bytes and gzip framing identical.
	const normalizedGzip = deterministicGzip(normalizedTar);
	writeFileSync(path, normalizedGzip);
}

function parseOctal(buffer) {
	const text = buffer.toString("ascii").replace(/\0.*$/u, "").trim();
	return text ? Number.parseInt(text, 8) : 0;
}

function tarText(buffer) {
	return buffer.toString("utf8").replace(/\0.*$/u, "");
}

function inspectArchive(path) {
	const compressed = readFileSync(path);
	if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) fail("npm archive is not gzip");
	if (compressed.readUInt32LE(4) !== 0) fail("gzip mtime is not zero");
	const tar = gunzipSync(compressed);
	const entries = [];
	let offset = 0;
	let sawEnd = false;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) {
			sawEnd = true;
			break;
		}
		const name = tarText(header.subarray(0, 100));
		const prefix = tarText(header.subarray(345, 500));
		const entryPath = prefix ? `${prefix}/${name}` : name;
		const size = parseOctal(header.subarray(124, 136));
		const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
		const dataStart = offset + 512;
		const dataEnd = dataStart + size;
		if (dataEnd > tar.length) fail(`Truncated npm archive entry: ${entryPath}`);
		if (!entryPath.startsWith("package/")) fail(`Unexpected archive path: ${entryPath}`);
		if (type !== "0" && type !== "5") fail(`Archive contains unsupported entry type ${type} at ${entryPath}`);
		const mode = parseOctal(header.subarray(100, 108));
		const uid = parseOctal(header.subarray(108, 116));
		const gid = parseOctal(header.subarray(116, 124));
		const mtime = parseOctal(header.subarray(136, 148));
		const uname = tarText(header.subarray(265, 297));
		const gname = tarText(header.subarray(297, 329));
		if (uid !== 0 || gid !== 0 || uname !== "" || gname !== "") fail(`Archive owner metadata is not normalized at ${entryPath}`);
		if (mtime !== TAR_MTIME) fail(`Archive mtime is not npm's fixed value at ${entryPath}`);
		const expectedMode = type === "5" || entryPath === "package/dist/bundle/cli.js" ? 0o755 : 0o644;
		if (mode !== expectedMode) fail(`Archive mode ${mode.toString(8)} is not normalized at ${entryPath}`);
		entries.push({ path: entryPath, type, mode, size, data: Buffer.from(tar.subarray(dataStart, dataEnd)) });
		offset = dataStart + Math.ceil(size / 512) * 512;
	}
	if (!sawEnd) fail("Archive has no tar end marker");
	for (let index = 1; index < entries.length; index += 1) {
		if (Buffer.compare(Buffer.from(entries[index - 1].path), Buffer.from(entries[index].path)) > 0) fail(`Archive entries are not sorted by raw UTF-8 path bytes: ${entries[index - 1].path} > ${entries[index].path}`);
	}
	return { compressed, entries };
}

function upstreamMetadata() {
	const upstream = readJson(join(root, "UPSTREAM.json"));
	const source = upstream.upstream || {};
	return {
		version: source.release,
		commit: source.declaredCommit,
		repository: source.repository,
	};
}

function main() {
	const outputArg = parseArgs(process.argv.slice(2));
	const output = assertOutputDirectory(outputArg);
	const npmVersion = assertToolchain();
	let stage;
	let buildAttempted = false;
	let buildLockHeld = false;
	let succeeded = false;
	try {
		acquireBuildLock();
		buildLockHeld = true;
		const sources = assertSourceManifests();
		const source = sourceState();
		const tracked = gitTrackedManifest();
		// npm ci is intentionally frozen before any release staging occurs. npm can
		// leave a partially removed directory on macOS after an interrupted pack;
		// one clean retry is safe and still uses the frozen lockfile.
		try {
			runNpm(["ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"], root, "npm ci (frozen lockfile)");
		} catch {
			rmSync(join(root, "node_modules"), { recursive: true, force: true });
			runNpm(["ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"], root, "npm ci (frozen lockfile retry)");
		}
		buildAttempted = true;
		runNpm(["run", "build:release"], root, "npm run build:release");
		for (const { workspace, manifest } of sources.values()) {
			const dist = join(root, workspace.directory, "dist");
			if (!lstatSafe(dist)?.isDirectory()) fail(`Missing built output: ${dist}`);
			if (workspace.key === "coding-agent" && !lstatSafe(join(dist, "bundle", "cli.js"))?.isFile()) fail("Missing built coding-agent bundle dist/bundle/cli.js");
			if (workspace.key !== "coding-agent" && !lstatSafe(join(root, workspace.directory, manifest.main.replace(/^\.\//u, "")))?.isFile()) fail(`Missing built main output for ${manifest.name}`);
		}
		stage = mkdtempSync(join(output, ".millwright-stage-"));
		const codingSource = sources.get("coding-agent");
		const publicManifest = createPublicManifest(codingSource.manifest, publicDependencies(sources));
		const publicStage = stage;
		writeJson(join(publicStage, "package.json"), publicManifest);
		for (const entry of packageFiles(join(root, codingSource.workspace.directory), codingSource.manifest)) {
			copyIfPresent(join(root, codingSource.workspace.directory, entry), join(publicStage, entry));
		}
		for (const workspace of WORKSPACES.filter(({ key }) => key !== "coding-agent")) {
			const sourcePackage = sources.get(workspace.key);
			const packageTarget = join(publicStage, "node_modules", "@earendil-works", workspace.name.split("/")[1]);
			mkdirSyncSafe(packageTarget);
			writeJson(join(packageTarget, "package.json"), sanitizedInternalManifest(sourcePackage.manifest));
			for (const entry of packageFiles(join(root, workspace.directory), sourcePackage.manifest)) {
				copyIfPresent(join(root, workspace.directory, entry), join(packageTarget, entry));
			}
		}
		for (const entry of ATTRIBUTION_FILES) {
			ensureRegularSource(join(root, entry));
			copyFileSync(join(root, entry), join(publicStage, entry));
		}
		copyIfPresent(join(root, "LICENSES"), join(publicStage, "LICENSES"));
		normalizeTree(publicStage);
		const staged = stagedInputManifest(publicStage);
		const upstream = upstreamMetadata();
		writeJson(join(publicStage, "PROVENANCE.json"), {
			schemaVersion: 1,
			packerVersion: PACKER_VERSION,
			millwrightVersion: PUBLIC_VERSION,
			sourceCommit: source.commit,
			upstreamPrimeVersion: upstream.version,
			upstreamPrimeCommit: upstream.commit,
			upstream: { project: "Prime Agent", version: upstream.version, commit: upstream.commit, repository: upstream.repository },
			trackedSourceManifestSha256: tracked.sha256,
			stagedInputManifestSha256: staged.sha256,
		});
		normalizeTree(publicStage);
		const npmOutput = runNpm(["pack", "--json", "--silent", "--ignore-scripts", "--pack-destination", output], publicStage, "npm pack", { quiet: true });
		sortNpmArchive(join(output, `${PUBLIC_NAME}-${PUBLIC_VERSION}.tgz`));
		let npmReport;
		try { npmReport = JSON.parse(npmOutput).at(-1); } catch { fail("npm pack did not return JSON metadata"); }
		const tarballName = npmReport?.filename;
		if (tarballName !== `${PUBLIC_NAME}-${PUBLIC_VERSION}.tgz`) fail(`npm pack emitted unexpected filename: ${tarballName || "(none)"}`);
		const tarballPath = join(output, tarballName);
		const archive = inspectArchive(tarballPath);
		const tarballBytes = archive.compressed;
		const report = {
			schemaVersion: 1,
			packerVersion: PACKER_VERSION,
			toolchain: { node: REQUIRED_NODE, npm: npmVersion },
			source: {
				commit: source.commit,
				dirty: source.dirty,
				status: source.status,
				trackedSourceManifestSha256: tracked.sha256,
				trackedSourceFileCount: tracked.fileCount,
			},
			sourceCommit: source.commit,
			dirty: source.dirty,
			trackedSourceManifestSha256: tracked.sha256,
			stagedInputManifestSha256: staged.sha256,
			stagedInputFileCount: staged.fileCount,
			package: { name: PUBLIC_NAME, version: PUBLIC_VERSION },
			artifact: {
				filename: tarballName,
				sha256: createHash("sha256").update(tarballBytes).digest("hex"),
				integrity: `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`,
				entryCount: archive.entries.length,
				unpackedSize: archive.entries.reduce((sum, entry) => sum + entry.size, 0),
			},
		};
		if (readdirSync(output).filter((entry) => entry.endsWith(".tgz")).length !== 1) fail("Output must contain exactly one tarball");
		writeJson(join(output, "pack-report.json"), report);
		succeeded = true;
		console.log(JSON.stringify({ tarball: tarballPath, sha256: report.artifact.sha256, integrity: report.artifact.integrity }, null, "\t"));
	} finally {
		if (stage) rmSync(stage, { recursive: true, force: true });
		if (buildAttempted) {
			for (const workspace of WORKSPACES) rmSync(join(root, workspace.directory, "dist"), { recursive: true, force: true });
		}
		if (!succeeded) {
			for (const entry of readdirSync(output)) {
				if (entry.endsWith(".tgz") || entry === "pack-report.json") rmSync(join(output, entry), { recursive: true, force: true });
			}
		}
		if (buildLockHeld) releaseBuildLock();
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
