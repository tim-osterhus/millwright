#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const GATES = ["build", "checks", "cleanSource", "installSmoke", "pack", "tests", "types"];
const INSTALLED_RECORD_IDS = ["help", "version", "tui", "configState", "sessionState", "skillDiscovery", "kernelDiscovery", "daemonLifecycle", "legacyState", "refinementSafety", "identity", "cleanup"];
const DAEMON_CASE_IDS = ["clean-stop", "sigterm", "launcher-parent-exit", "startup-validation-failure"];
const IDENTITY_SURFACE_IDS = ["commandTuiOutput", "updaterText", "daemonDiagnostics", "telemetryAcpMetadata", "installedSkills", "packageMetadata", "shippedDocsExamples", "settingsRefinementDefaults", "observedStateTrees", "kernelRuntimeDiscovery"];
const CLASSIFICATION_KEYS = ["public-millwright-identity", "retained-internal-compatibility-identity", "provider-specific-prime-identity", "required-attribution-or-provenance", "forbidden-accidental-identity"];
const LEGACY_SENTINEL_LOCATIONS = ["home/.prime", "home/.millrace-cli", "project/.prime", "project/.millrace-cli"];

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
	const allowed = new Set(["--output", "--pack-report", "--package-report", "--logs-dir", "--installed-report", "--installed-report-sha256"]);
	if (args.length !== allowed.size * 2) fail("Expected all qualification writer options exactly once");
	for (let index = 0; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (!allowed.has(option) || !value || Object.hasOwn(values, option.slice(2))) fail(`Invalid option: ${option || "(missing)"}`);
		values[option.slice(2)] = value;
	}
	for (const key of ["output", "pack-report", "package-report", "logs-dir", "installed-report", "installed-report-sha256"]) if (!values[key]) fail(`--${key} is required`);
	for (const key of ["output", "pack-report", "package-report", "logs-dir", "installed-report"]) if (!isAbsolute(values[key])) fail(`--${key} must be absolute`);
	if (!/^[0-9a-f]{64}$/u.test(values["installed-report-sha256"])) fail("--installed-report-sha256 must be lowercase 64-hex");
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, key === "installed-report-sha256" ? value : resolve(value)]));
}

function assertSha256(value, label) {
	if (!/^[0-9a-f]{64}$/u.test(value || "")) fail(`${label} must be lowercase 64-hex`);
}

function assertEmptyArray(value, label) {
	if (!Array.isArray(value) || value.length !== 0) fail(`${label} must be empty`);
}

function assertObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertExactKeys(value, keys, label) {
	assertObject(value, label);
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} fields are invalid`);
}

function assertExactArray(value, expected, label) {
	if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) fail(`${label} is invalid`);
}

function assertProcessIdentity(value, label) {
	assertExactKeys(value, ["pid", "processGroup", "startId"], label);
	if (!Number.isInteger(value.pid) || value.pid < 1 || !Number.isInteger(value.processGroup) || value.processGroup < 1 || typeof value.startId !== "string" || !value.startId) fail(`${label} is invalid`);
}

function assertClassificationCounts(value, label) {
	assertExactKeys(value, CLASSIFICATION_KEYS, label);
	for (const key of CLASSIFICATION_KEYS) if (!Number.isInteger(value[key]) || value[key] < 0) fail(`${label}.${key} is invalid`);
}

function assertRecordDetails(id, details) {
	if (id === "help") {
		assertExactKeys(details, ["product"], "help details");
		if (details.product !== "Millwright") fail("installed help identity is invalid");
		return;
	}
	if (id === "version") {
		assertExactKeys(details, ["product", "version"], "version details");
		if (details.product !== "Millwright" || details.version !== "0.0.2") fail("installed version identity is invalid");
		return;
	}
	if (id === "tui") {
		assertExactKeys(details, ["initialized", "legacyUnchanged", "noSession", "offline", "readiness", "realPty", "startupBenchmark", "timingEnabled"], "TUI details");
		if (details.realPty !== true || details.timingEnabled !== true || details.initialized !== true || details.readiness !== "interactiveMode.init" || details.startupBenchmark !== true || details.offline !== true || details.noSession !== true || details.legacyUnchanged !== true) fail("installed TUI proof is invalid");
		return;
	}
	if (id === "configState") {
		assertExactKeys(details, ["agentRootMatches", "command", "entrypoints", "freshAutoRefine", "legacyUnchanged", "packageName", "product"], "config details");
		if (details.agentRootMatches !== true || details.product !== "Millwright" || details.packageName !== "millwright-agent" || details.command !== "millwright" || details.freshAutoRefine !== false || details.legacyUnchanged !== true) fail("installed config state is invalid");
		assertExactArray(details.entrypoints, ["dist/config.js", "dist/core/settings-manager.js"], "config entrypoints");
		return;
	}
	if (id === "sessionState") {
		assertExactKeys(details, ["entries", "entrypoints", "legacyUnchanged", "persisted", "sessionRootMatches"], "session details");
		if (details.persisted !== true || details.sessionRootMatches !== true || !Number.isInteger(details.entries) || details.entries < 1 || details.legacyUnchanged !== true) fail("installed session state is invalid");
		assertExactArray(details.entrypoints, ["dist/core/session-manager.js"], "session entrypoints");
		return;
	}
	if (id === "skillDiscovery") {
		assertExactKeys(details, ["diagnostics", "entrypoints", "legacyUnchanged", "names"], "skill details");
		if (details.diagnostics !== 0 || details.legacyUnchanged !== true) fail("installed skill diagnostics are invalid");
		assertExactArray(details.names, ["installed-fixture"], "installed skill names");
		assertExactArray(details.entrypoints, ["dist/core/skills.js"], "skill entrypoints");
		return;
	}
	if (id === "kernelDiscovery") {
		assertExactKeys(details, ["bootstrap", "importBelowInstalledRuntime", "runtime", "sourcePythonPath"], "kernel details");
		if (details.bootstrap !== "dist/core/kernel/bootstrap.js" || details.runtime !== "dist/prime-agent-runtime" || details.importBelowInstalledRuntime !== true || details.sourcePythonPath !== false) fail("installed kernel discovery is invalid");
		return;
	}
	if (id === "legacyState") {
		assertExactKeys(details, ["byteUnchanged", "sentinelCount", "sentinelLocations"], "legacy details");
		if (details.byteUnchanged !== true || details.sentinelCount !== 32) fail("installed legacy state proof is invalid");
		assertExactArray(details.sentinelLocations, LEGACY_SENTINEL_LOCATIONS, "legacy sentinel locations");
		return;
	}
	if (id === "refinementSafety") {
		assertExactKeys(details, ["commandPresent", "deterministicPlannerCalls", "explicitEnabled", "fauxCalls", "freshEnabled", "legacyUnchanged", "persisted", "promptPath", "providerCalls"], "refinement details");
		if (details.freshEnabled !== false || details.explicitEnabled !== true || details.commandPresent !== true || details.promptPath !== true || details.persisted !== true || details.fauxCalls !== 1 || details.providerCalls !== 0 || details.deterministicPlannerCalls !== 1 || details.legacyUnchanged !== true) fail("installed refinement proof is invalid");
		return;
	}
	if (id === "identity") {
		assertExactKeys(details, ["classificationCounts", "forbiddenHits", "surfaces", "unclassifiedHits"], "identity details");
		if (!Array.isArray(details.surfaces) || details.surfaces.length !== IDENTITY_SURFACE_IDS.length) fail("installed identity surfaces are invalid");
		const totals = Object.fromEntries(CLASSIFICATION_KEYS.map((key) => [key, 0]));
		for (const [index, surface] of details.surfaces.entries()) {
			assertExactKeys(surface, ["classificationCounts", "hitCount", "id", "sha256"], `identity surface ${IDENTITY_SURFACE_IDS[index]}`);
			if (surface.id !== IDENTITY_SURFACE_IDS[index] || !Number.isInteger(surface.hitCount) || surface.hitCount < 0) fail(`installed identity surface is invalid: ${IDENTITY_SURFACE_IDS[index]}`);
			assertSha256(surface.sha256, `${surface.id} sha256`);
			assertClassificationCounts(surface.classificationCounts, `${surface.id} classificationCounts`);
			const surfaceHits = CLASSIFICATION_KEYS.reduce((sum, key) => sum + surface.classificationCounts[key], 0);
			if (surfaceHits !== surface.hitCount) fail(`installed identity hit count disagrees: ${surface.id}`);
			for (const key of CLASSIFICATION_KEYS) totals[key] += surface.classificationCounts[key];
		}
		assertClassificationCounts(details.classificationCounts, "identity classificationCounts");
		for (const key of CLASSIFICATION_KEYS) if (details.classificationCounts[key] !== totals[key]) fail(`installed identity aggregate disagrees: ${key}`);
		if (details.forbiddenHits !== 0 || details.unclassifiedHits !== 0 || details.forbiddenHits !== details.classificationCounts["forbidden-accidental-identity"]) fail("installed identity evidence is not clean");
		return;
	}
	if (id === "cleanup") {
		assertExactKeys(details, ["reclaimedBytes", "removedRoots", "residualPids", "residualSockets", "temporaryRootRemoved"], "cleanup details");
		if (details.temporaryRootRemoved !== true || !Number.isInteger(details.reclaimedBytes) || details.reclaimedBytes < 0) fail("installed driver cleanup summary is invalid");
		assertExactArray(details.removedRoots, ["$TEMP"], "installed driver removed roots");
		assertEmptyArray(details.residualPids, "installed driver residual PIDs");
		assertEmptyArray(details.residualSockets, "installed driver residual sockets");
		return;
	}
	if (id !== "daemonLifecycle") fail(`Unknown installed behavior: ${id}`);
}

function validateDaemonDetails(details) {
	assertExactKeys(details, ["cases"], "daemon details");
	if (!Array.isArray(details.cases) || details.cases.length !== DAEMON_CASE_IDS.length) fail("installed report must contain exactly four daemon cases");
	for (const [index, id] of DAEMON_CASE_IDS.entries()) {
		const current = details.cases[index];
		assertExactKeys(current, ["cleanup", "daemon", "descendantIdentitiesAfter", "descendantIdentitiesBefore", "id", "launcher", "observedExit", "observedSignal", "processGroup", "socketPath", "socketStateAfter", "socketStateBefore"], `daemon case ${id}`);
		if (current.id !== id) fail(`installed daemon case order mismatch at ${id}`);
		assertProcessIdentity(current.launcher, `${id} launcher`);
		if (!Array.isArray(current.descendantIdentitiesBefore)) fail(`installed daemon descendants-before are invalid: ${id}`);
		for (const [descendantIndex, descendant] of current.descendantIdentitiesBefore.entries()) assertProcessIdentity(descendant, `${id} descendant ${descendantIndex}`);
		assertEmptyArray(current.descendantIdentitiesAfter, `${id} descendants-after`);
		if (id === "startup-validation-failure") {
			if (current.daemon !== null || current.processGroup !== null || !Number.isInteger(current.observedExit) || current.observedExit === 0 || current.observedSignal !== null) fail("startup-validation-failure observation is invalid");
		} else {
			assertProcessIdentity(current.daemon, `${id} daemon`);
			if (current.processGroup !== current.daemon.processGroup) fail(`installed daemon process group is invalid: ${id}`);
			if (id === "sigterm") {
				const signalled = (Number.isInteger(current.observedExit) && current.observedExit !== 0 && current.observedSignal === null) || (current.observedExit === null && current.observedSignal === "SIGTERM");
				if (!signalled) fail("sigterm observation is invalid");
			} else if (current.observedExit !== 0 || current.observedSignal !== null) fail(`installed daemon exit observation is invalid: ${id}`);
		}
		if (typeof current.socketPath !== "string" || !/^\$TEMP\/[a-z0-9.-]+$/u.test(current.socketPath) || current.socketStateBefore !== false || current.socketStateAfter !== false) fail(`installed daemon socket cleanup is invalid: ${id}`);
		assertExactKeys(current.cleanup, ["legacyUnchanged", "residualPids", "residualSockets"], `${id} cleanup`);
		if (current.cleanup.legacyUnchanged !== true) fail(`installed daemon legacy state changed: ${id}`);
		assertEmptyArray(current.cleanup.residualPids, `${id} residual PIDs`);
		assertEmptyArray(current.cleanup.residualSockets, `${id} residual sockets`);
	}
}

function validateInstalledQualification(installed, verified, expectedSha256) {
	if (!installed || typeof installed !== "object" || Array.isArray(installed)) fail("installed report must be an object");
	if (installed.schemaVersion !== 1) fail("installed report schemaVersion must be 1");
	if (installed.sourceCommit !== verified.sourceCommit) fail("installed report source commit disagrees with verifier");
	if (installed.artifact?.filename !== "millwright-agent-0.0.2.tgz" || installed.artifact?.sha256 !== verified.sha256 || installed.artifact?.integrity !== verified.integrity) fail("installed report artifact disagrees with verifier");
	if (installed.platform?.os !== "linux" || typeof installed.platform?.release !== "string" || !installed.platform.release || typeof installed.platform?.arch !== "string" || !installed.platform.arch) fail("installed report platform must be bounded Ubuntu identity");
	if (installed.toolchain?.node !== "22.22.0" || installed.toolchain?.npm !== "10.9.2") fail("installed report toolchain is not frozen");
	if (!Array.isArray(installed.records) || installed.records.length !== INSTALLED_RECORD_IDS.length) fail("installed report must contain exactly twelve records");
	for (const [index, id] of INSTALLED_RECORD_IDS.entries()) {
		const current = installed.records[index];
		if (!current || current.id !== id) fail(`installed report record order mismatch at ${id}`);
		assertExactKeys(current, ["details", "durationMs", "exitCode", "id", "status", "stderrSha256", "stdoutSha256"], `installed behavior ${id}`);
		if (current.status !== "passed") fail(`installed behavior failed: ${id}`);
		if (!Number.isInteger(current.durationMs) || current.durationMs < 0) fail(`installed behavior duration is invalid: ${id}`);
		const expectedExit = ["legacyState", "identity", "cleanup"].includes(id) ? null : 0;
		if (current.exitCode !== expectedExit) fail(`installed behavior exitCode is invalid: ${id}`);
		assertSha256(current.stdoutSha256, `${id} stdoutSha256`);
		assertSha256(current.stderrSha256, `${id} stderrSha256`);
		assertRecordDetails(id, current.details);
	}
	const daemon = installed.records[INSTALLED_RECORD_IDS.indexOf("daemonLifecycle")];
	validateDaemonDetails(daemon.details);
	return {
		reportSha256: expectedSha256,
		sourceCommit: installed.sourceCommit,
		artifactSha256: installed.artifact.sha256,
		platform: installed.platform,
		toolchain: installed.toolchain,
		behaviors: installed.records.map(({ id, status, stdoutSha256, stderrSha256 }) => ({ id, status, stdoutSha256, stderrSha256 })),
	};
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
	const installedInfo = lstatSync(options["installed-report"]);
	if (!installedInfo.isFile() || installedInfo.isSymbolicLink()) fail("installed report must be a regular file");
	const installedBytes = readFileSync(options["installed-report"]);
	if (sha256(installedBytes) !== options["installed-report-sha256"]) fail("installed report SHA-256 mismatch");
	const installed = parseJson(options["installed-report"], "installed report");
	if (pack.source?.dirty !== false || pack.source?.status?.length !== 0) fail("pack report source must be clean");
	if (pack.sourceCommit !== verified.sourceCommit) fail("pack and verifier source commits disagree");
	if (pack.artifact?.sha256 !== verified.sha256 || pack.artifact?.integrity !== verified.integrity) fail("pack and verifier artifact digests disagree");
	const installedQualification = validateInstalledQualification(installed, verified, options["installed-report-sha256"]);
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
		toolchain: { node: "22.22.0", npm: "10.9.2", uv: "0.12.6" },
		gates,
		artifact: {
			filename: pack.artifact.filename,
			sha256: verified.sha256,
			integrity: verified.integrity,
		},
		installedQualification,
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
