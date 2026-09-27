import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { DESKTOP_SHUTDOWN_HEADER, DESKTOP_SHUTDOWN_TOKEN_ENV, registerDesktopShutdownRoute } from "./desktop-shutdown.js";

async function withServer(app: express.Express, run: (base: string) => Promise<void>): Promise<void> {
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	try {
		await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("desktop shutdown route", () => {
	afterEach(() => {
		delete process.env[DESKTOP_SHUTDOWN_TOKEN_ENV];
	});

	it("is not registered without a token", () => {
		expect(registerDesktopShutdownRoute(express(), vi.fn())).toBe(false);
	});

	it("rejects a wrong token and accepts the right one", async () => {
		process.env[DESKTOP_SHUTDOWN_TOKEN_ENV] = "secret-token";
		const app = express();
		const shutdown = vi.fn();
		expect(registerDesktopShutdownRoute(app, shutdown)).toBe(true);

		await withServer(app, async (base) => {
			const denied = await fetch(`${base}/api/desktop/shutdown`, { method: "POST", headers: { [DESKTOP_SHUTDOWN_HEADER]: "nope" } });
			expect(denied.status).toBe(403);
			const missing = await fetch(`${base}/api/desktop/shutdown`, { method: "POST" });
			expect(missing.status).toBe(403);

			const ok = await fetch(`${base}/api/desktop/shutdown`, { method: "POST", headers: { [DESKTOP_SHUTDOWN_HEADER]: "secret-token" } });
			expect(ok.status).toBe(200);
			await new Promise((resolve) => setImmediate(resolve));
		});
		expect(shutdown).toHaveBeenCalledTimes(1);
	});
});
