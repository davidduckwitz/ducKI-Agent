import { beforeAll, describe, expect, it } from "vitest";
import type { DatabaseService } from "@ducki/database";
import { deleteSecret, listSecrets, modelServerEnv, setSecret, getSecret } from "./secrets-store.js";

// Never touch the real plugins/.secret-key: use a fixed throwaway key.
beforeAll(() => {
  process.env["DUCKI_SECRET_KEY"] = Buffer.alloc(32, 7).toString("hex");
});

function fakeDb() {
  const rows = new Map<string, string>();
  const db = {
    getSetting: async (key: string) => rows.get(key),
    setSetting: async (key: string, value: string) => { rows.set(key, value); },
    deleteSetting: async (key: string) => { rows.delete(key); },
    getAllSettings: async () => [...rows].map(([key, value]) => ({ key, value })),
  };
  return { db: db as unknown as DatabaseService, rows };
}

describe("secrets store", () => {
  it("stores encrypted, lists masked, and hands plaintext only to server-side readers", async () => {
    const { db, rows } = fakeDb();
    await setSecret(db, "HF_TOKEN", "hf_abcdefghijklmnop1234");
    expect(rows.get("secret:HF_TOKEN")).not.toContain("hf_abcdefghijklmnop1234");

    const [summary] = await listSecrets(db);
    expect(summary).toMatchObject({ name: "HF_TOKEN", label: "Hugging Face", preset: true });
    expect(summary!.hint).toBe("hf_••••1234");
    expect(JSON.stringify(summary)).not.toContain("abcdefghijklmnop");

    expect(await getSecret(db, "HF_TOKEN")).toBe("hf_abcdefghijklmnop1234");
    expect(await modelServerEnv(db)).toEqual({ HF_TOKEN: "hf_abcdefghijklmnop1234", HUGGING_FACE_HUB_TOKEN: "hf_abcdefghijklmnop1234" });
  });

  it("only forwards the Hugging Face token to model servers, and removes secrets", async () => {
    const { db } = fakeDb();
    await setSecret(db, "OTHER_TOKEN", "ghp_secret_value_123");
    expect(await modelServerEnv(db)).toEqual({});
    await deleteSecret(db, "OTHER_TOKEN");
    expect(await listSecrets(db)).toEqual([]);
  });

  it("rejects invalid names and empty values", async () => {
    const { db } = fakeDb();
    await expect(setSecret(db, "bad name", "x")).rejects.toThrow(/Ungültiger Name/);
    await expect(setSecret(db, "OK_NAME", "   ")).rejects.toThrow(/leer/);
  });
});
