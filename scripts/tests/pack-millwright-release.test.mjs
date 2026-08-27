import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const verifier = join(root, "scripts", "verify-millwright-package.mjs");
const pinnedNpmArgs = ["--yes", "npm@10.9.2"];

function runNpm(args, cwd = root) {
	return spawnSync("npx", [...pinnedNpmArgs, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, CI: "1", npm_config_yes: "true" },
	});
}

function gitStatus() {
	const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function makeOutput() {
	return mkdtempSync(join(tmpdir(), "millwright-b002-pack-"));
}

function octal(buffer) {
	const text = buffer.toString("ascii").replace(/\0.*$/u, "").trim();
	return text ? Number.parseInt(text, 8) : 0;
}

async function pack(output) {
	const result = runNpm(["run", "pack:release", "--", "--output", output]);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	const files = readdirSync(output).sort();
	assert.deepEqual(files.filter((file) => file.endsWith(".tgz")), ["millwright-agent-0.0.1.tgz"]);
	assert.deepEqual(files.filter((file) => file.endsWith(".json")), ["pack-report.json"]);
	return join(output, "millwright-agent-0.0.1.tgz");
}

function readTar(tarball) {
	const compressed = readFileSync(tarball);
	assert.equal(compressed.readUInt32LE(4), 0, "gzip mtime must be zero");
	const bytes = gunzipSync(compressed);
	const entries = [];
	for (let offset = 0; offset + 512 <= bytes.length;) {
		const header = bytes.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const text = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/, "").trim();
		const name = text(0, 100);
		const prefix = text(345, 500);
		const path = prefix ? `${prefix}/${name}` : name;
		const size = Number.parseInt(text(124, 136), 8) || 0;
		const mode = Number.parseInt(text(100, 108), 8) || 0;
		const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
		entries.push({
			path,
			mode,
			type,
			uid: octal(header.subarray(108, 116)),
			gid: octal(header.subarray(116, 124)),
			mtime: octal(header.subarray(136, 148)),
			uname: text(265, 297),
			gname: text(297, 329),
			data: bytes.subarray(offset + 512, offset + 512 + size),
		});
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}

function fileMap(tarball) {
	return new Map(readTar(tarball).filter((entry) => entry.type === "0").map((entry) => [entry.path, entry.data]));
}

function runVerifier(tarball, ...extra) {
	return spawnSync(process.execPath, [verifier, tarball, ...extra], { cwd: root, encoding: "utf8" });
}

test("packs one frozen public artifact with closure and deterministic headers", async () => {
	const output = makeOutput();
	const statusBefore = gitStatus();
	try {
		const tarball = await pack(output);
		const statusAfter = gitStatus();
		assert.equal(statusAfter, statusBefore, "packing must not change repository source status");
		assert.equal(
			readdirSync(root).some((entry) => /^\.millwright-.*\.lock$/u.test(entry)),
			false,
			"packing must not create a repository-local lock",
		);
		const packReport = JSON.parse(readFileSync(join(output, "pack-report.json"), "utf8"));
		assert.deepEqual(packReport.source.status, statusBefore.split("\n").filter(Boolean));
		const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		assert.equal(rootManifest.packageManager, "npm@10.9.2");
		assert.equal(readFileSync(join(root, ".node-version"), "utf8").trim(), "22.22.0");
		const entries = readTar(tarball);
		const paths = entries.map((entry) => entry.path);
		assert.equal(paths.some((path) => path.split("/").includes("__pycache__") || /\.py[co]$/u.test(path)), false);
		assert.deepEqual(paths, [...paths].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))));
		for (const entry of entries) {
			assert.equal(entry.type, entry.path.endsWith("/") ? "5" : "0");
			assert.equal(entry.mode, entry.path.endsWith("/") || entry.path === "package/dist/bundle/cli.js" ? 0o755 : 0o644);
			assert.equal(entry.uid, 0);
			assert.equal(entry.gid, 0);
			assert.equal(entry.uname, "");
			assert.equal(entry.gname, "");
			assert.equal(entry.mtime, 499162500);
		}
		const files = fileMap(tarball);
		const manifest = JSON.parse(files.get("package/package.json"));
		assert.equal(manifest.name, "millwright-agent");
		assert.equal(manifest.version, "0.0.1");
		assert.deepEqual(manifest.bin, { millwright: "dist/bundle/cli.js" });
		assert.deepEqual(manifest.bundledDependencies, [
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-tui",
		]);
		assert.equal(manifest.engines.node, ">=22.8.0");
		assert.equal(manifest.private, undefined);
		for (const path of [
			"package/dist/bundle/cli.js",
			"package/dist/index.js",
			"package/dist/postinstall.js",
			"package/skills/agent-message/SKILL.md",
			"package/LICENSE",
			"package/NOTICE",
			"package/THIRD_PARTY_NOTICES.md",
			"package/UPSTREAM.md",
			"package/UPSTREAM.json",
			"package/LICENSES/Prime-Agent-MIT.txt",
			"package/LICENSES/OpenTUI-MIT.txt",
		]) assert.ok(files.has(path), `missing ${path}`);
		for (const name of manifest.bundledDependencies) {
			assert.ok(files.has(`package/node_modules/${name}/package.json`));
			assert.ok([...files.keys()].some((path) => path.startsWith(`package/node_modules/${name}/dist/`)));
		}
		const metadataText = JSON.stringify(manifest) + [...manifest.bundledDependencies].map((name) => files.get(`package/node_modules/${name}/package.json`).toString("utf8")).join("\n");
		assert.doesNotMatch(metadataText, /(?:^|["' ])(?:file:|https?:\/\/(?:localhost|127\.0\.0\.1))/);
		assert.doesNotMatch(JSON.stringify(manifest), /prime-agent-(?:ai|core|tui)|@earendil-works\/pi-coding-agent/);
		const verified = runVerifier(tarball);
		assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
		const report = JSON.parse(verified.stdout);
		assert.match(report.sha256, /^[0-9a-f]{64}$/);
		assert.match(report.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
		assert.ok(Array.isArray(report.unpackedFiles));
		assert.ok(report.dependencies);
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
});

test("two clean packs have identical bytes and npm integrity", async () => {
	const first = makeOutput();
	const second = makeOutput();
	try {
		const a = await pack(first);
		const b = await pack(second);
		const bytesA = readFileSync(a);
		const bytesB = readFileSync(b);
		assert.deepEqual(createHash("sha256").update(bytesA).digest("hex"), createHash("sha256").update(bytesB).digest("hex"));
		assert.deepEqual(createHash("sha512").update(bytesA).digest("base64"), createHash("sha512").update(bytesB).digest("base64"));
	} finally {
		rmSync(first, { recursive: true, force: true });
		rmSync(second, { recursive: true, force: true });
	}
});
