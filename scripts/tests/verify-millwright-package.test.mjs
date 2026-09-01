import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

const root = resolve(new URL("../..", import.meta.url).pathname);
const verifier = join(root, "scripts", "verify-millwright-package.mjs");
const pinnedNpmArgs = ["--yes", "npm@10.9.2"];
const embeddedInternalPackages = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-tui",
];

function runNpm(args, cwd = root) {
	return spawnSync("npx", [...pinnedNpmArgs, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, CI: "1", npm_config_yes: "true" },
	});
}

async function pack(output) {
	const result = runNpm(["run", "pack:release", "--", "--output", output]);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	return join(output, "millwright-agent-0.0.3.tgz");
}

function verify(path, ...extra) {
	return spawnSync(process.execPath, [verifier, path, ...extra], { cwd: root, encoding: "utf8" });
}

function freshOutput() {
	return mkdtempSync(join(tmpdir(), "millwright-b002-verify-"));
}

function tarRecords(path) {
	const compressed = readFileSync(path);
	const tar = gunzipSync(compressed);
	const records = [];
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const clean = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/u, "");
		const name = clean(0, 100);
		const prefix = clean(345, 500);
		const pathName = prefix ? `${prefix}/${name}` : name;
		const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
		const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
		const dataStart = offset + 512;
		const next = dataStart + Math.ceil(size / 512) * 512;
		records.push({ path: pathName, header: Buffer.from(header), data: Buffer.from(tar.subarray(dataStart, dataStart + size)) });
		offset = next;
	}
	return records;
}

function encodeOctal(value, length) {
	const encoded = value.toString(8).padStart(length - 1, "0");
	return `${encoded}\0`;
}

function setTarSize(header, size) {
	header.fill(0x20, 148, 156);
	header.fill(0, 124, 136);
	header.write(encodeOctal(size, 12), 124, 12, "ascii");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.fill(0x20, 148, 156);
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}

function writeMutatedTarball(source, destination, mutate) {
	const records = tarRecords(source);
	const values = new Map(records.map((record) => [record.path, record]));
	mutate(values);
	const output = [];
	const sortedRecords = [...values.values()].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
	for (const record of sortedRecords) {
		setTarSize(record.header, record.data.length);
		output.push(record.header, record.data, Buffer.alloc((512 - (record.data.length % 512)) % 512));
	}
	output.push(Buffer.alloc(1024));
	const compressed = gzipSync(Buffer.concat(output), { level: 9, mtime: 0 });
	compressed.writeUInt32LE(0, 4);
	compressed[9] = 3;
	writeFileSync(destination, compressed);
}

function sortJson(value) {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right))).map(([key, child]) => [key, sortJson(child)]));
	return value;
}

function mutateJson(values, path, callback) {
	const record = values.get(`package/${path}`);
	assert.ok(record, `fixture path exists: ${path}`);
	const value = JSON.parse(record.data.toString("utf8"));
	callback(value);
	record.data = Buffer.from(`${JSON.stringify(sortJson(value))}\n`);
}

test("verifier reports stable closure, provenance, licenses, and dependency inventory", async () => {
	const output = freshOutput();
	try {
		const tarball = await pack(output);
		const result = verify(tarball);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const report = JSON.parse(result.stdout);
		assert.equal(report.package.name, "millwright-agent");
		assert.equal(report.package.version, "0.0.3");
		assert.equal(report.provenance.schemaVersion, 1);
		assert.equal(report.provenance.packerVersion, "millwright-release-packer/2");
		assert.match(report.provenance.trackedSourceManifestSha256, /^[0-9a-f]{64}$/);
		assert.match(report.provenance.stagedInputManifestSha256, /^[0-9a-f]{64}$/);
		assert.deepEqual(report.embeddedInternalPackages, embeddedInternalPackages);
		assert.equal(report.bundledDependencies, undefined);
		assert.ok(report.dependencies["@agentclientprotocol/sdk"]);
		assert.equal(report.unpackedFiles.some(({ path }) => path.split("/").includes("__pycache__") || /\.py[co]$/u.test(path)), false);
		assert.equal(report.installSmoke.status, "passed");
		assert.equal(report.installSmoke.lifecycleScripts, "enabled");
		assert.equal(report.installSmoke.dependencyTreeClean, true);
		assert.equal(report.publicIdentity.unclassified.length, 0);
		assert.ok(report.publicIdentity.hitCount > 0);
		assert.ok(report.publicIdentity.files.includes("README.md"));
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
});

test("verifier rejects extra tarballs and malformed command inputs", async () => {
	const output = freshOutput();
	try {
		const tarball = await pack(output);
		writeFileSync(join(output, "unexpected.tgz"), "not a package");
		assert.notEqual(verify(tarball).status, 0, "extra tarball must be rejected");
		rmSync(join(output, "unexpected.tgz"));
		assert.notEqual(verify(join(output, "missing.tgz")).status, 0);
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
});

test("verifier rejects missing closure files, metadata, notices, versions, and conflicts", async () => {
	const output = freshOutput();
	try {
		const tarball = await pack(output);
		const cases = [
			["missing embedded package", (values) => values.delete("package/node_modules/@earendil-works/pi-ai/package.json")],
			["recursive bundled dependency metadata", (values) => mutateJson(values, "package.json", (value) => { value.bundledDependencies = [...embeddedInternalPackages]; })],
			["recursive bundle dependency alias", (values) => mutateJson(values, "package.json", (value) => { value.bundleDependencies = [...embeddedInternalPackages]; })],
			["private registry dependency", (values) => mutateJson(values, "package.json", (value) => { value.dependencies["@earendil-works/pi-ai"] = "^0.7.2"; })],
			["missing executable", (values) => values.delete("package/dist/bundle/cli.js")],
			["missing notice", (values) => values.delete("package/NOTICE")],
			["missing provenance", (values) => values.delete("package/PROVENANCE.json")],
			["mismatched staged input digest", (values) => mutateJson(values, "PROVENANCE.json", (value) => { value.stagedInputManifestSha256 = "0".repeat(64); })],
			["inconsistent versions", (values) => mutateJson(values, "node_modules/@earendil-works/pi-ai/package.json", (value) => { value.version = "9.9.9"; })],
			["dependency conflict", (values) => mutateJson(values, "package.json", (value) => { value.optionalDependencies = { ...(value.optionalDependencies || {}), chalk: "^5.6.2" }; })],
			["executable mapping", (values) => mutateJson(values, "package.json", (value) => { value.bin.millwright = "dist/missing.js"; })],
			["unclassified public identity", (values) => {
				const record = values.get("package/README.md");
				assert.ok(record);
				record.data = Buffer.from(`${record.data.toString("utf8")}\nPrime Agent is the current command.\n`);
			}],
			["unclassified generated dist identity", (values) => {
				const record = values.get("package/dist/index.js");
				assert.ok(record);
				record.data = Buffer.from(`${record.data.toString("utf8")}\nPrime Agent is the current command.\n`);
			}],
			["reintroduced model-registry identity", (values) => {
				const record = values.get("package/dist/core/model-registry.js");
				assert.ok(record);
				const text = record.data.toString("utf8");
				record.data = Buffer.from(
					text
						.replace("Millwright's own package version", "Prime Agent's own package version")
						.replace("for Millwright at all", "for Prime Agent at all"),
				);
			}],
			["unclassified branded pi identity", (values) => {
				const record = values.get("package/README.md");
				assert.ok(record);
				record.data = Buffer.from(`${record.data.toString("utf8")}\nRun the pi command.\n`);
			}],
			["unclassified pi command forms", (values) => {
				const record = values.get("package/README.md");
				assert.ok(record);
				record.data = Buffer.from(
					`${record.data.toString("utf8")}\ncommand: "pi"\npi -e ./extension\npi -p "prompt"\npi --flag\n`,
				);
			}],
			["unclassified pi prose forms", (values) => {
				const record = values.get("package/README.md");
				assert.ok(record);
				record.data = Buffer.from(
					`${record.data.toString("utf8")}\nstart pi\nuse pi\ninvoke pi\ninside pi\nexit pi\nPi's default spinner\nPi’s default spinner\n`,
				);
			}],
			["unclassified pi UI label", (values) => {
				const record = values.get("package/README.md");
				assert.ok(record);
				record.data = Buffer.from(`${record.data.toString("utf8")}\nnotify("Pi", "Ready")\n`);
			}],
		];
		for (const [label, mutate] of cases) {
			const caseDir = mkdtempSync(join(output, `${label.replaceAll(" ", "-")}-`));
			try {
				const mutated = join(caseDir, "millwright-agent-0.0.3.tgz");
				writeMutatedTarball(tarball, mutated, mutate);
				const result = verify(mutated);
				assert.notEqual(result.status, 0, `${label} must be rejected`);
			} finally {
				rmSync(caseDir, { recursive: true, force: true });
			}
		}
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
});
