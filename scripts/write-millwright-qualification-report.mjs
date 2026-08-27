#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const GATES = ["build", "checks", "cleanSource", "installSmoke", "pack", "tests", "types"];

function fail(message) {
	throw new Error(message);
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
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

function parseJson(path, label) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseArgs(args) {
	const values = {};
	for (let index = 0; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (!["--output", "--pack-report", "--package-report", "--logs-dir"].includes(option) || !value) fail(`Invalid option: ${option || "(missing)"}`);
		values[option.slice(2)] = value;
	}
	for (const key of ["output", "pack-report", "package-report", "logs-dir"]) if (!values[key]) fail(`--${key} is required`);
	for (const [key, value] of Object.entries(values)) if (!isAbsolute(value)) fail(`--${key} must be absolute`);
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, resolve(value)]));
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const repository = process.env.GITHUB_REPOSITORY;
	const runId = process.env.GITHUB_RUN_ID;
	const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
	if (repository !== "tim-osterhus/millwright") fail("GITHUB_REPOSITORY must be tim-osterhus/millwright");
	if (!/^\d+$/u.test(runId || "") || !Number.isInteger(runAttempt) || runAttempt < 1) fail("GitHub run ID/attempt are invalid");
	const pack = parseJson(options["pack-report"], "pack report");
	const verified = parseJson(options["package-report"], "package verifier report");
	if (pack.source?.dirty !== false || pack.source?.status?.length !== 0) fail("pack report source must be clean");
	if (pack.sourceCommit !== verified.sourceCommit) fail("pack and verifier source commits disagree");
	if (pack.artifact?.sha256 !== verified.sha256 || pack.artifact?.integrity !== verified.integrity) fail("pack and verifier artifact digests disagree");
	const gates = {};
	for (const gate of GATES) {
		const path = join(options["logs-dir"], `${gate}.log`);
		const info = lstatSync(path);
		if (!info.isFile() || info.isSymbolicLink()) fail(`gate log is not a regular file: ${gate}`);
		gates[gate] = { status: "passed", outputSha256: sha256(readFileSync(path)) };
	}
	const report = {
		schemaVersion: 1,
		repository,
		runId,
		runAttempt,
		commit: verified.sourceCommit,
		tree: pack.source.trackedSourceManifestSha256,
		toolchain: { node: "22.22.0", npm: "10.9.2" },
		gates,
		artifact: {
			filename: pack.artifact.filename,
			sha256: verified.sha256,
			integrity: verified.integrity,
		},
	};
	writeFileSync(options.output, `${JSON.stringify(sortJson(report), null, "\t")}\n`);
	console.log(JSON.stringify({ output: options.output, sha256: sha256(readFileSync(options.output)) }));
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
