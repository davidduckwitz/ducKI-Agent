import { timingSafeEqual } from "node:crypto";
import type { Express } from "express";

export const DESKTOP_SHUTDOWN_TOKEN_ENV = "DUCKI_DESKTOP_SHUTDOWN_TOKEN";
export const DESKTOP_SHUTDOWN_HEADER = "x-ducki-shutdown-token";

function tokensMatch(expected: string, received: string | undefined): boolean {
	if (!received) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(received);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The desktop shell (apps/tauri-desktop) cannot deliver SIGTERM to its Node sidecar on Windows -
 * killing the process skips every cleanup handler (STT/TTS servers, shell-tool background
 * processes, MCP clients, open SQLite handles). Instead it asks for a graceful shutdown over
 * loopback, authenticated with a per-launch random token it passed in via the environment.
 * Without that env var the route does not exist at all.
 */
export function registerDesktopShutdownRoute(app: Express, requestShutdown: () => void): boolean {
	const token = process.env[DESKTOP_SHUTDOWN_TOKEN_ENV]?.trim();
	if (!token) return false;
	app.post("/api/desktop/shutdown", (req, res) => {
		if (!tokensMatch(token, req.get(DESKTOP_SHUTDOWN_HEADER))) {
			res.status(403).json({ ok: false });
			return;
		}
		res.json({ ok: true });
		setImmediate(requestShutdown);
	});
	return true;
}
