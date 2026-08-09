/**
 * GitHub connector module tool (trust: "node"). Demonstrates the Phase 1-3 plumbing end to end:
 * it reads the encrypted access token from ctx.secrets and calls the GitHub API through the
 * host-guarded ctx.fetch (limited to api.github.com by the manifest's allowedHosts).
 */

const API = "https://api.github.com";

export const definition = {
  name: "github",
  description:
    "GitHub-Connector. action=whoami (eigenes Profil), action=list_repos (eigene Repos, neueste zuerst), " +
    "action=search_repos (q=Suchbegriff). Nutzt den in den Plugin-Einstellungen hinterlegten Token.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["whoami", "list_repos", "search_repos"], description: "Welche Abfrage ausgeführt wird" },
      q: { type: "string", description: "Suchbegriff (nur für action=search_repos)" },
      limit: { type: "number", description: "Maximale Ergebnisanzahl (1-50, Standard 10)" },
    },
    required: ["action"],
  },
};

export async function execute(input, ctx) {
  const token = ctx.secrets.access_token;
  if (!token) {
    return { error: "Kein GitHub-Token konfiguriert. Bitte in den Plugin-Einstellungen setzen oder via OAuth verbinden." };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "ducki-github-connector",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 50);

  const call = async (path) => {
    const res = await ctx.fetch(`${API}${path}`, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  };

  try {
    if (input.action === "whoami") {
      const u = await call("/user");
      return { login: u.login, name: u.name, public_repos: u.public_repos, followers: u.followers, html_url: u.html_url };
    }
    if (input.action === "list_repos") {
      const repos = await call(`/user/repos?per_page=${limit}&sort=updated`);
      return {
        count: repos.length,
        repos: repos.map((r) => ({ full_name: r.full_name, private: r.private, stars: r.stargazers_count, url: r.html_url })),
      };
    }
    if (input.action === "search_repos") {
      const q = String(input.q || "").trim();
      if (!q) return { error: "q ist erforderlich für action=search_repos" };
      const data = await call(`/search/repositories?q=${encodeURIComponent(q)}&per_page=${limit}`);
      return {
        total: data.total_count,
        repos: (data.items || []).map((r) => ({ full_name: r.full_name, stars: r.stargazers_count, url: r.html_url })),
      };
    }
    return { error: `Unbekannte action: ${input.action}` };
  } catch (error) {
    ctx.logger?.warn?.("github connector call failed", { error: error instanceof Error ? error.message : String(error) });
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
