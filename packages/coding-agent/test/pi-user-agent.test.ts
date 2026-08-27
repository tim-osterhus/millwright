import { describe, expect, it } from "vitest";
import { getPiUserAgent } from "../src/utils/pi-user-agent.js";

describe("getPiUserAgent", () => {
	it("formats the Millwright user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getPiUserAgent("1.2.3");

		expect(userAgent).toBe(`millwright/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^millwright\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
