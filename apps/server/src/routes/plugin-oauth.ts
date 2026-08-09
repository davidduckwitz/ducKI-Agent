import { Router, type IRouter, type Request } from "express";
import { randomBytes } from "node:crypto";
import { createApiError, createApiResponse } from "@ducki/shared";
import { loadPlugins, type LoadedPluginInfo, type OAuthConfig } from "@ducki/agent";
import { getPluginRuntimeConfig, setPluginSetting } from "@ducki/database";

/**
 * Generic OAuth2 authorization-code flow for plugin connectors (Phase 2). It is provider-
 * agnostic: a plugin ships a declarative *.oauth.json (authUrl/tokenUrl/scopes + which plugin
 * settings hold the client id/secret and which secret the token is stored under). This router
 * runs the redirect + code->token exchange and writes the resulting token into the plugin's
 * own encrypted settings store, so an authenticated tool just reads `secrets.<storeTokenAs>`.
 *
 * Additive by design: mounted alongside pluginsRouter under /api/plugins, it never touches the
 * core gateway/connector code.
 */
export const pluginOAuthRouter: IRouter = Router();

const SAFE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Short-lived CSRF state store (state -> pending flow). Cleared on use or after TTL. */
const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, { name: string; oauthId: string; at: number }>();

function rememberState(name: string, oauthId: string): string {
  const state = randomBytes(24).toString("hex");
  pendingStates.set(state, { name, oauthId, at: Date.now() });
  // Opportunistic prune.
  for (const [key, val] of pendingStates) {
    if (Date.now() - val.at > STATE_TTL_MS) pendingStates.delete(key);
  }
  return state;
}

function consumeState(state: string): { name: string; oauthId: string } | undefined {
  const entry = pendingStates.get(state);
  if (!entry) return undefined;
  pendingStates.delete(state);
  if (Date.now() - entry.at > STATE_TTL_MS) return undefined;
  return { name: entry.name, oauthId: entry.oauthId };
}

/** Build the public origin, honoring reverse-proxy forwarding headers. */
function getRequestOrigin(req: Request): string {
  const proto = (Array.isArray(req.headers["x-forwarded-proto"]) ? req.headers["x-forwarded-proto"][0] : req.headers["x-forwarded-proto"]) ?? req.protocol ?? "http";
  const host = (Array.isArray(req.headers["x-forwarded-host"]) ? req.headers["x-forwarded-host"][0] : req.headers["x-forwarded-host"]) ?? req.headers.host ?? "localhost:3001";
  return `${proto}://${host}`;
}

function redirectUri(req: Request, name: string, oauthId: string): string {
  return `${getRequestOrigin(req)}/api/plugins/${encodeURIComponent(name)}/oauth/${encodeURIComponent(oauthId)}/callback`;
}

async function findPlugin(name: string): Promise<LoadedPluginInfo | undefined> {
  return (await loadPlugins()).plugins.find((p) => p.name === name);
}

function findOAuth(info: LoadedPluginInfo, oauthId: string): OAuthConfig | undefined {
  return info.oauth.find((c) => c.id === oauthId);
}

function htmlResult(title: string, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto">` +
    `<h2>${title}</h2><p>${message}</p>` +
    `<script>if(window.opener){try{window.opener.postMessage({type:"ducki:oauth",title:${JSON.stringify(title)}},"*")}catch(e){}}</script>` +
    `</body>`;
}

/** GET /:name/oauth/:oauthId/start - redirect the user to the provider's consent screen. */
pluginOAuthRouter.get("/:name/oauth/:oauthId/start", async (req, res, next) => {
  try {
    const name = String(req.params.name ?? "");
    const oauthId = String(req.params.oauthId ?? "");
    if (!SAFE_NAME.test(name)) { res.status(400).json(createApiError("Invalid plugin name")); return; }
    const info = await findPlugin(name);
    if (!info) { res.status(404).json(createApiError("Plugin not found")); return; }
    const cfg = findOAuth(info, oauthId);
    if (!cfg) { res.status(404).json(createApiError("OAuth connector not found")); return; }

    const runtime = await getPluginRuntimeConfig(name, info.settings);
    const clientId = String(runtime.settings[cfg.clientIdSetting] ?? "").trim();
    if (!clientId) {
      res.status(400).json(createApiError(`Set the '${cfg.clientIdSetting}' setting before connecting`));
      return;
    }

    const state = rememberState(name, oauthId);
    const url = new URL(cfg.authUrl);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri(req, name, oauthId));
    url.searchParams.set("response_type", "code");
    if (cfg.scopes.length > 0) url.searchParams.set("scope", cfg.scopes.join(" "));
    url.searchParams.set("state", state);
    for (const [k, v] of Object.entries(cfg.authParams ?? {})) url.searchParams.set(k, v);

    res.redirect(url.toString());
  } catch (error) {
    next(error);
  }
});

/** GET /:name/oauth/:oauthId/callback - exchange the code for a token and store it encrypted. */
pluginOAuthRouter.get("/:name/oauth/:oauthId/callback", async (req, res, next) => {
  try {
    const name = String(req.params.name ?? "");
    const oauthId = String(req.params.oauthId ?? "");
    const code = String(req.query.code ?? "").trim();
    const state = String(req.query.state ?? "").trim();
    if (!SAFE_NAME.test(name)) { res.status(400).send(htmlResult("Fehler", "Invalid plugin name")); return; }

    const pending = consumeState(state);
    if (!pending || pending.name !== name || pending.oauthId !== oauthId) {
      res.status(400).send(htmlResult("Fehler", "Invalid or expired OAuth state. Bitte erneut starten."));
      return;
    }
    if (!code) { res.status(400).send(htmlResult("Fehler", "Kein Authorization-Code erhalten.")); return; }

    const info = await findPlugin(name);
    if (!info) { res.status(404).send(htmlResult("Fehler", "Plugin not found")); return; }
    const cfg = findOAuth(info, oauthId);
    if (!cfg) { res.status(404).send(htmlResult("Fehler", "OAuth connector not found")); return; }

    const runtime = await getPluginRuntimeConfig(name, info.settings);
    const clientId = String(runtime.settings[cfg.clientIdSetting] ?? "").trim();
    const clientSecret = String(runtime.secrets[cfg.clientSecretSetting] ?? "").trim();
    if (!clientId || !clientSecret) {
      res.status(400).send(htmlResult("Fehler", "Client-ID/-Secret fehlen in den Plugin-Einstellungen."));
      return;
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(req, name, oauthId),
      client_id: clientId,
      client_secret: clientSecret,
    });
    const tokenRes = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    });
    const payload = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
    if (!tokenRes.ok || !payload.access_token) {
      const reason = payload.error_description || payload.error || `HTTP ${tokenRes.status}`;
      res.status(400).send(htmlResult("Fehler", `Token-Austausch fehlgeschlagen: ${reason}`));
      return;
    }

    await setPluginSetting(name, cfg.storeTokenAs, payload.access_token, info.settings);
    if (cfg.storeRefreshTokenAs && payload.refresh_token) {
      await setPluginSetting(name, cfg.storeRefreshTokenAs, payload.refresh_token, info.settings);
    }

    const mgr = req.app.locals["pluginManager"] as { requestReload?: () => unknown } | undefined;
    mgr?.requestReload?.();

    res.send(htmlResult("Verbunden", `${name} ist jetzt mit '${oauthId}' verbunden. Du kannst dieses Fenster schließen.`));
  } catch (error) {
    next(error);
  }
});

/** POST /:name/oauth/:oauthId/disconnect - clear the stored token(s). */
pluginOAuthRouter.post("/:name/oauth/:oauthId/disconnect", async (req, res, next) => {
  try {
    const name = String(req.params.name ?? "");
    const oauthId = String(req.params.oauthId ?? "");
    if (!SAFE_NAME.test(name)) { res.status(400).json(createApiError("Invalid plugin name")); return; }
    const info = await findPlugin(name);
    if (!info) { res.status(404).json(createApiError("Plugin not found")); return; }
    const cfg = findOAuth(info, oauthId);
    if (!cfg) { res.status(404).json(createApiError("OAuth connector not found")); return; }

    await setPluginSetting(name, cfg.storeTokenAs, "", info.settings);
    if (cfg.storeRefreshTokenAs) await setPluginSetting(name, cfg.storeRefreshTokenAs, "", info.settings);
    const mgr = req.app.locals["pluginManager"] as { requestReload?: () => unknown } | undefined;
    mgr?.requestReload?.();

    res.json(createApiResponse({ name, oauthId, disconnected: true }));
  } catch (error) {
    next(error);
  }
});
