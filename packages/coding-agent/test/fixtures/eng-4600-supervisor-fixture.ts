import { existsSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { APP_NAME } from "../../src/config.js";
import {
	DaemonCatalogClient,
	isDaemonCatalogProcess,
	runDaemonCatalogProcess,
} from "../../src/modes/daemon/daemon-catalog-process.js";
import { DaemonSupervisor } from "../../src/modes/daemon/daemon-supervisor.js";
import { acquireDaemonSupervisorOwnership } from "../../src/modes/daemon/daemon-supervisor-ownership.js";

type ControlMessage = {
	type: "go" | "probe" | "release" | "release_runtime" | "shutdown" | "cleanup" | "catalog_stop";
};

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing ${name}`);
	}
	return value;
}

function send(message: Record<string, unknown>): void {
	process.send?.(message);
}

function waitForControl(type: ControlMessage["type"]): Promise<void> {
	return new Promise((resolve) => {
		const onMessage = (message: unknown) => {
			if (!message || typeof message !== "object" || (message as Partial<ControlMessage>).type !== type) {
				return;
			}
			process.off("message", onMessage);
			resolve();
		};
		process.on("message", onMessage);
	});
}

async function runOwnershipHolder(): Promise<never> {
	const ownership = await acquireDaemonSupervisorOwnership({
		socketPath: requiredEnvironment("ENG_4600_SOCKET_PATH"),
		descriptorDir: requiredEnvironment("ENG_4600_DESCRIPTOR_DIR"),
		agentDir: requiredEnvironment("ENG_4600_AGENT_DIR"),
		generation: requiredEnvironment("ENG_4600_GENERATION"),
		appVersion: "test",
		registryDir: requiredEnvironment("ENG_4600_REGISTRY_DIR"),
	});
	send({ type: "ready", owner: ownership.record });
	await waitForControl("release");
	await ownership.release();
	send({ type: "owner_released" });
	await waitForControl("shutdown");
	process.exit(0);
}

async function runSupervisor(): Promise<never> {
	process.argv[1] = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
	process.title = APP_NAME;
	const socketPath = requiredEnvironment("ENG_4600_SOCKET_PATH");
	const agentDir = requiredEnvironment("ENG_4600_AGENT_DIR");
	const descriptorDir = requiredEnvironment("ENG_4600_DESCRIPTOR_DIR");
	const supervisor = new DaemonSupervisor(socketPath, {
		descriptorDir,
		defaultSessionConfig: {
			agentDir,
			cwd: agentDir,
			noContextFiles: true,
			noExtensions: true,
			noSkills: true,
			noTools: true,
		},
	});
	try {
		await supervisor.start();
		send({ type: "ready" });
		process.on("message", (message: unknown) => {
			if (
				!message ||
				typeof message !== "object" ||
				(message as Partial<ControlMessage>).type !== "release_runtime"
			) {
				return;
			}
			void releaseSupervisorRuntime(supervisor);
		});
		return await new Promise<never>(() => {});
	} catch (error) {
		send({ type: "failed", error: error instanceof Error ? error.message : String(error) });
		process.exit(0);
	}
}

async function releaseSupervisorRuntime(supervisor: DaemonSupervisor): Promise<void> {
	const ownership = Reflect.get(supervisor, "ownership") as { release: () => Promise<void> } | undefined;
	await ownership?.release();
	Reflect.set(supervisor, "ownership", undefined);
	const cleanupSocket = Reflect.get(supervisor, "cleanupSocket");
	if (typeof cleanupSocket === "function") {
		Reflect.apply(cleanupSocket, supervisor, []);
	}
	const lease = Reflect.get(supervisor, "socketLease") as { release: () => Promise<void> } | undefined;
	await lease?.release();
	Reflect.set(supervisor, "socketLease", undefined);
	send({ type: "runtime_released" });
}

async function runCatalogClient(): Promise<never> {
	process.argv[1] = fileURLToPath(import.meta.url);
	const catalog = new DaemonCatalogClient(() => undefined);
	await catalog.start();
	send({ type: "catalog_ready" });
	await waitForControl("catalog_stop");
	const child = Reflect.get(catalog, "child") as
		| { exitCode: number | null; signalCode: NodeJS.Signals | null }
		| undefined;
	await catalog.stop();
	send({
		type: "catalog_stop_resolved",
		exitCode: child?.exitCode ?? null,
		signalCode: child?.signalCode ?? null,
	});
	await waitForControl("shutdown");
	process.exit(0);
}

function isShutdownCatalogRequest(value: unknown): value is { type: "request"; id: string; command: "shutdown" } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const request = value as { type?: unknown; id?: unknown; command?: unknown };
	return request.type === "request" && typeof request.id === "string" && request.command === "shutdown";
}

async function runCatalogLifecycleProcess(): Promise<never> {
	const shutdownAckPath = requiredEnvironment("ENG_4600_CATALOG_SHUTDOWN_ACK_PATH");
	const disconnectPath = requiredEnvironment("ENG_4600_CATALOG_DISCONNECT_PATH");
	const releasePath = requiredEnvironment("ENG_4600_CATALOG_RELEASE_PATH");
	let watcher: ReturnType<typeof watch> | undefined;
	const released = new Promise<void>((resolveRelease) => {
		const release = () => {
			watcher?.close();
			resolveRelease();
		};
		if (existsSync(releasePath)) {
			release();
			return;
		}
		watcher = watch(dirname(releasePath), (_event, filename) => {
			if (filename?.toString() === basename(releasePath) && existsSync(releasePath)) {
				release();
			}
		});
	});
	process.on("disconnect", () => {
		writeFileSync(disconnectPath, "disconnected\n");
		void released.then(() => process.exit(0));
	});
	process.on("message", (value: unknown) => {
		if (!isShutdownCatalogRequest(value)) {
			return;
		}
		writeFileSync(shutdownAckPath, "shutdown acknowledged\n");
		send({ type: "response", id: value.id, success: true });
	});
	send({ type: "ready" });
	return new Promise(() => {});
}

async function runLegacyCleanup(): Promise<never> {
	const socketPath = requiredEnvironment("ENG_4600_SOCKET_PATH");
	send({ type: "ready" });
	await waitForControl("cleanup");
	let skipped = false;
	// This lock/unlink sequence is frozen from the v0.3.0 daemon socket cleanup.
	if (process.platform !== "win32") {
		let releaseLock: (() => void) | undefined;
		try {
			releaseLock = lockfile.lockSync(socketPath, {
				realpath: false,
				stale: 5000,
				update: 1000,
				retries: 0,
			});
		} catch {
			skipped = true;
		}
		if (releaseLock) {
			try {
				if (existsSync(socketPath)) {
					unlinkSync(socketPath);
				}
			} finally {
				releaseLock();
			}
		}
	}
	send({ type: "cleanup_complete", skipped });
	process.exit(0);
}

async function main(): Promise<never> {
	if (isDaemonCatalogProcess()) {
		if (process.env.ENG_4600_CATALOG_LIFECYCLE === "1") {
			return runCatalogLifecycleProcess();
		}
		return runDaemonCatalogProcess();
	}
	send({ type: "booted" });
	process.on("message", (message: unknown) => {
		if (message && typeof message === "object" && (message as Partial<ControlMessage>).type === "probe") {
			send({ type: "probe_ack" });
		}
	});
	const mode = requiredEnvironment("ENG_4600_FIXTURE_MODE");
	if (mode === "legacy_cleanup") {
		return runLegacyCleanup();
	}
	await waitForControl("go");
	if (mode === "owner") {
		return runOwnershipHolder();
	}
	if (mode === "supervisor") {
		return runSupervisor();
	}
	if (mode === "catalog_client") {
		return runCatalogClient();
	}
	throw new Error(`Unknown fixture mode: ${mode}`);
}

void main().catch((error) => {
	send({ type: "failed", error: error instanceof Error ? error.message : String(error) });
	process.exit(1);
});
