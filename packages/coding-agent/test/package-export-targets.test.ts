import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type ExportTarget = {
	location: string;
	target: string;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRootRealPath = realpathSync(packageRoot);
const packageManifestPath = join(packageRoot, "package.json");

function collectStringTargets(value: unknown, location: string): ExportTarget[] {
	if (typeof value === "string") {
		return [{ location, target: value }];
	}

	if (Array.isArray(value)) {
		return value.flatMap((entry, index) => collectStringTargets(entry, `${location}[${index}]`));
	}

	if (value !== null && typeof value === "object") {
		return Object.entries(value).flatMap(([key, entry]) => collectStringTargets(entry, `${location}.${key}`));
	}

	return [];
}

function isWithinPackage(targetPath: string): boolean {
	const lexicalPath = relative(packageRoot, targetPath);
	if (lexicalPath === ".." || lexicalPath.startsWith(`..${sep}`) || isAbsolute(lexicalPath)) {
		return false;
	}

	try {
		const parentRealPath = realpathSync(dirname(targetPath));
		const parentRelativePath = relative(packageRootRealPath, parentRealPath);
		if (parentRelativePath === ".." || parentRelativePath.startsWith(`..${sep}`) || isAbsolute(parentRelativePath)) {
			return false;
		}

		const targetRealPath = realpathSync(targetPath);
		const physicalRelativePath = relative(packageRootRealPath, targetRealPath);
		return (
			physicalRelativePath !== "" &&
			physicalRelativePath !== ".." &&
			!physicalRelativePath.startsWith(`..${sep}`) &&
			!isAbsolute(physicalRelativePath)
		);
	} catch {
		// A missing target is reported by the caller; an existing ancestor must
		// still resolve inside the source build root.
		return true;
	}
}

function packageRelativePath(targetPath: string): string {
	return `./${relative(packageRoot, targetPath).split(sep).join("/")}`;
}

describe("coding-agent package exports", () => {
	it("points every import/types target at a regular built file", () => {
		const manifest = JSON.parse(readFileSync(packageManifestPath, "utf8")) as {
			exports?: unknown;
		};
		const targets = collectStringTargets(manifest.exports, "exports");
		const invalidTargets: string[] = [];
		const invalidFiles: string[] = [];

		for (const { location, target } of targets) {
			if (!target.startsWith("./")) {
				invalidTargets.push(`${location}: ${target} (must start with ./)`);
				continue;
			}

			const targetPath = resolve(packageRoot, target);
			if (!isWithinPackage(targetPath)) {
				invalidTargets.push(`${location}: ${target} (resolves outside coding-agent package)`);
				continue;
			}

			let stats: ReturnType<typeof lstatSync> | undefined;
			try {
				stats = lstatSync(targetPath);
			} catch {
				invalidFiles.push(`${location}: ${packageRelativePath(targetPath)} (missing)`);
				continue;
			}

			if (!stats.isFile() || stats.isSymbolicLink()) {
				invalidFiles.push(`${location}: ${packageRelativePath(targetPath)} (not a regular non-symlink file)`);
			}
		}

		expect(targets.length, "package.json exports must contain string targets").toBeGreaterThan(0);
		expect([...invalidTargets].sort(), "Invalid package export targets").toEqual([]);
		expect([...invalidFiles].sort(), `Invalid built export files:\n${invalidFiles.sort().join("\n")}`).toEqual([]);
	});
});
