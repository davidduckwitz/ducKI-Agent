import { getApiBaseUrl } from "../../lib/backendUrl";
import { useCallback, useEffect, useState } from "react";

interface SecretSummary { name: string; label: string; hint: string; updatedAt?: number }

const NAME = "HF_TOKEN";

async function errorText(response: Response): Promise<string> {
  try { const body = await response.json(); return body?.error?.message ?? body?.error ?? JSON.stringify(body); }
  catch { return `HTTP ${response.status}`; }
}

/** Hugging Face token - stored encrypted on the server, never sent back in clear text. */
export function SecretsSettings() {
  const [stored, setStored] = useState<SecretSummary>();
  const [loaded, setLoaded] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `${getApiBaseUrl()}/secrets`;

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(base);
      if (!response.ok) throw new Error(await errorText(response));
      const body = await response.json();
      setStored((body.data.secrets as SecretSummary[]).find((secret) => secret.name === NAME));
      setLoaded(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [base]);
  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (task: () => Promise<string | void>) => {
    setBusy(true); setError(""); setNotice("");
    try { const message = await task(); if (message) setNotice(message); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const save = () => run(async () => {
    const response = await fetch(`${base}/${NAME}`, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value, label: "Hugging Face" }) });
    if (!response.ok) throw new Error(await errorText(response));
    setValue("");
    return "Token gespeichert (verschlüsselt). Lokale Modell-Server übernehmen ihn nach einem Neustart.";
  });

  const test = () => run(async () => {
    const response = await fetch(`${base}/${NAME}/test`, { method: "POST" });
    if (!response.ok) throw new Error(await errorText(response));
    const body = await response.json();
    return `Token gültig${body.data.user ? ` (Konto „${body.data.user}“)` : ""}.`;
  });

  const remove = () => run(async () => {
    if (!window.confirm("Hugging-Face-Token löschen?")) return;
    const response = await fetch(`${base}/${NAME}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await errorText(response));
  });

  return <div className="card space-y-3" aria-label="Zugangsdaten">
    <h3 className="text-lg font-semibold">🔑 Zugangsdaten</h3>
    <div className="space-y-2 rounded border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong>Hugging Face</strong>
        {stored && <span className="text-xs text-emerald-600 dark:text-emerald-400">hinterlegt</span>}
        {stored && <span className="text-xs text-muted-foreground font-mono">{stored.hint}{stored.updatedAt ? ` · ${new Date(stored.updatedAt).toLocaleDateString()}` : ""}</span>}
        {stored && <span className="ml-auto flex gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void test()}>Testen</button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void remove()}>Löschen</button>
        </span>}
      </div>
      <p className="text-xs text-muted-foreground">
        Zugriffstoken von <code className="rounded bg-muted px-1">huggingface.co/settings/tokens</code> (Leserechte genügen). Damit lassen sich gesperrte Modelle
        laden (z. B. der Pocket-TTS-Stimmklon, nach Akzeptieren der Modell-Bedingungen) und die Download-Limits steigen. Der Token wird verschlüsselt auf dem Server
        gespeichert, nie im Klartext zurückgegeben und an die lokalen Modell-Server (Chatterbox, Qwen3-TTS, Pocket TTS, Spracherkennung) weitergegeben.
        Nach dem Speichern den jeweiligen Server einmal stoppen und neu starten.
      </p>
      {loaded && <div className="flex flex-wrap gap-2">
        <input type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off"
          placeholder={stored ? "Neuen Token einfügen, um ihn zu ersetzen" : "hf_… Token einfügen"}
          className="min-w-0 flex-1 px-3 py-1.5 rounded border border-border bg-background text-sm font-mono" />
        <button type="button" className="btn-secondary" disabled={busy || !value.trim()} onClick={() => void save()}>
          {stored ? "Ersetzen" : "Speichern"}
        </button>
      </div>}
    </div>
    {notice && <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
  </div>;
}
