import type { DatabaseService } from "@ducki/database";
import { decryptSecret, encryptSecret } from "@ducki/database";

/**
 * Platform credentials (Hugging Face token, GitHub token, ...) kept AES-256-GCM encrypted in the
 * settings table (same key file as plugin secrets, see packages/database/src/plugin-secrets.ts).
 * Values never leave the server: the API only returns a masked hint, and the plaintext is handed
 * out solely to server-side consumers (e.g. the environment of the local model servers).
 */
const PREFIX = "secret:";
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export interface SecretPreset {
  name: string;
  label: string;
  description: string;
  helpUrl?: string;
}

export const SECRET_PRESETS: SecretPreset[] = [
  {
    name: "HF_TOKEN", label: "Hugging Face",
    description: "Zum Laden gesperrter oder gated Modelle (z. B. Pocket-TTS-Stimmklon) und für höhere Download-Limits. Wird an die lokalen Modell-Server (TTS/STT) weitergegeben.",
    helpUrl: "https://huggingface.co/settings/tokens",
  },
];

export interface SecretSummary {
  name: string;
  label: string;
  hint: string;
  updatedAt?: number;
  preset: boolean;
}

interface Stored { value: string; label?: string; updatedAt: number }

export function assertSecretName(name: string): string {
  if (!NAME.test(name)) throw new Error("Ungültiger Name: Großbuchstaben, Ziffern und _ (z. B. MEIN_SERVICE_KEY).");
  return name;
}

function parse(raw: string | undefined): Stored | undefined {
  if (!raw) return undefined;
  try { const parsed = JSON.parse(raw) as Stored; return typeof parsed.value === "string" ? parsed : undefined; }
  catch { return undefined; }
}

function mask(value: string): string {
  return value.length <= 8 ? "••••" : `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

export async function listSecrets(db: DatabaseService): Promise<SecretSummary[]> {
  const rows = (await db.getAllSettings()).filter((row) => row.key.startsWith(PREFIX));
  const summaries: SecretSummary[] = [];
  for (const row of rows) {
    const stored = parse(row.value);
    if (!stored) continue;
    const name = row.key.slice(PREFIX.length);
    let hint = "••••";
    try { hint = mask(decryptSecret(stored.value)); } catch { hint = "(nicht entschlüsselbar)"; }
    const preset = SECRET_PRESETS.find((candidate) => candidate.name === name);
    summaries.push({ name, label: stored.label || preset?.label || name, hint, updatedAt: stored.updatedAt, preset: !!preset });
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function setSecret(db: DatabaseService, name: string, value: string, label?: string): Promise<void> {
  assertSecretName(name);
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Wert darf nicht leer sein.");
  const stored: Stored = { value: encryptSecret(trimmed), label: label?.trim() || undefined, updatedAt: Date.now() };
  await db.setSetting(`${PREFIX}${name}`, JSON.stringify(stored));
}

export async function deleteSecret(db: DatabaseService, name: string): Promise<void> {
  await db.deleteSetting(`${PREFIX}${assertSecretName(name)}`);
}

/** Plaintext for server-side consumers only. */
export async function getSecret(db: DatabaseService, name: string): Promise<string | undefined> {
  const stored = parse(await db.getSetting(`${PREFIX}${name}`) ?? undefined);
  if (!stored) return undefined;
  try { return decryptSecret(stored.value); } catch { return undefined; }
}

/** Environment for the local model servers (huggingface_hub reads HF_TOKEN / HUGGING_FACE_HUB_TOKEN). */
export async function modelServerEnv(db: DatabaseService): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const hf = await getSecret(db, "HF_TOKEN");
  if (hf) { env["HF_TOKEN"] = hf; env["HUGGING_FACE_HUB_TOKEN"] = hf; }
  return env;
}
