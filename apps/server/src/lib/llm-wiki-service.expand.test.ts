import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseService } from "@ducki/database";
import { SHARED_WORKSPACE_ROOT } from "@ducki/tools";
import { LlmWikiService } from "./llm-wiki-service.js";

/** End-to-end check that LlmWikiService.expand() is correctly wired to real ingested data. */
describe("LlmWikiService.expand (integration)", () => {
  let dbDir: string;
  let db: DatabaseService;
  let vaultRelName: string;
  let vaultAbsPath: string;
  let previousSourcePathEnv: string | undefined;
  let service: LlmWikiService;

  beforeEach(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "ducki-wiki-expand-db-"));
    db = new DatabaseService(join(dbDir, "test.db"));
    await db.initialize();

    vaultRelName = `llm-wiki-expand-test-${Math.random().toString(36).slice(2, 8)}`;
    vaultAbsPath = resolve(SHARED_WORKSPACE_ROOT, vaultRelName);
    mkdirSync(vaultAbsPath, { recursive: true });

    previousSourcePathEnv = process.env["WIKI_SHARED_SOURCE_PATH"];
    process.env["WIKI_SHARED_SOURCE_PATH"] = vaultRelName;

    await db.setSetting("WIKI_ENABLED", "true");
    await db.setSetting("WIKI_AUTO_APPROVE", "true");
    await db.setSetting("WIKI_SHARED_SOURCE_AUTO_MEMORY", "false");

    writeFileSync(join(vaultAbsPath, "cats.md"), "# Cats\nCats are small domestic felines. See [[Dogs]] for comparison.", "utf8");
    writeFileSync(join(vaultAbsPath, "dogs.md"), "# Dogs\nDogs are loyal domestic canines. See [[Cats]] and [[Vets]].", "utf8");
    writeFileSync(join(vaultAbsPath, "vets.md"), "# Vets\nVeterinarians are animal doctors for many kinds of pets.", "utf8");
    writeFileSync(join(vaultAbsPath, "taxes.md"), "# Taxes\nCompletely unrelated topic about income tax filing.", "utf8");

    service = new LlmWikiService(db, { info: () => {}, warn: () => {} } as never);
    await service.ingestNow();
  });

  afterEach(() => {
    (db as unknown as { client?: { close?: () => void } }).client?.close?.();
    if (previousSourcePathEnv === undefined) delete process.env["WIKI_SHARED_SOURCE_PATH"];
    else process.env["WIKI_SHARED_SOURCE_PATH"] = previousSourcePathEnv;
    try {
      rmSync(dbDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    try {
      rmSync(vaultAbsPath, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("seeds from a query and spreads into linked, topically-related notes but not the unrelated one", async () => {
    const nodes = await service.expand({ query: "cats", maxHops: 2, maxNodes: 10 });
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain("cats.md");
    expect(ids).toContain("dogs.md");
    expect(ids).toContain("vets.md");
    expect(ids).not.toContain("taxes.md");

    const cats = nodes.find((n) => n.id === "cats.md")!;
    const dogs = nodes.find((n) => n.id === "dogs.md")!;
    const vets = nodes.find((n) => n.id === "vets.md")!;
    expect(cats.matchedSeed).toBe(true);
    expect(cats.hopDistance).toBe(0);
    expect(dogs.hopDistance).toBe(1);
    expect(vets.hopDistance).toBe(2);
    expect(cats.activation).toBeGreaterThan(dogs.activation);
    expect(dogs.activation).toBeGreaterThan(vets.activation);
  });

  it("seeds from explicit seedIds instead of a query", async () => {
    const nodes = await service.expand({ seedIds: ["vets.md"], maxHops: 1, maxNodes: 10 });
    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["dogs.md", "vets.md"]);
  });

  it("returns an empty array for a query that matches nothing", async () => {
    const nodes = await service.expand({ query: "xyzzy-nonexistent-topic" });
    expect(nodes).toEqual([]);
  });

  it("reaches two unlinked sibling files in the same folder via the folder hub", async () => {
    mkdirSync(join(vaultAbsPath, "pets"), { recursive: true });
    writeFileSync(join(vaultAbsPath, "pets", "hamster.md"), "# Hamster\nA small rodent kept as a pet.", "utf8");
    writeFileSync(join(vaultAbsPath, "pets", "goldfish.md"), "# Goldfish\nA small pet fish, no links to anything else here.", "utf8");
    await service.ingestNow();

    // Direct query search alone would never connect these two (no [[links]] between
    // them) - only the folder-hub edge makes goldfish reachable from a hamster seed.
    const nodes = await service.expand({ seedIds: ["pets/hamster.md"], maxHops: 2, maxNodes: 10 });
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain("folder:pets");
    expect(ids).toContain("pets/goldfish.md");
    const goldfish = nodes.find((n) => n.id === "pets/goldfish.md")!;
    expect(goldfish.hopDistance).toBe(2);
  });

  it("connects two files in different subfolders through their shared top-level folder (2-level nesting)", async () => {
    // Mirrors the real reported layout: Gesundheit/<condition>/file.md, two levels deep,
    // with no files directly inside Gesundheit/ itself.
    mkdirSync(join(vaultAbsPath, "Gesundheit", "chs_cannabinoid_hyperemesis_syndrom"), { recursive: true });
    mkdirSync(join(vaultAbsPath, "Gesundheit", "Bitcoin_and_Crypto"), { recursive: true });
    writeFileSync(join(vaultAbsPath, "Gesundheit", "chs_cannabinoid_hyperemesis_syndrom", "review.md"), "# CHS Review\nMedical notes.", "utf8");
    writeFileSync(join(vaultAbsPath, "Gesundheit", "Bitcoin_and_Crypto", "portfolio.md"), "# Portfolio\nUnrelated finance notes.", "utf8");
    await service.ingestNow();

    // Path from the seed file to its sibling subfolder's file is 4 hops (file -> its
    // folder -> Gesundheit -> sibling folder -> sibling file), past the hard cap of 3 -
    // that file itself is intentionally out of reach in one expand call, but the
    // folder structure up to the cap must still be fully visible.
    const nodes = await service.expand({ seedIds: ["Gesundheit/chs_cannabinoid_hyperemesis_syndrom/review.md"], maxHops: 3, maxNodes: 15 });
    const ids = nodes.map((n) => n.id);
    // The top-level "Gesundheit" folder must appear as its own node - it has no files
    // of its own, only two subfolders, so it must not be skipped.
    expect(ids).toContain("folder:Gesundheit");
    expect(ids).toContain("folder:Gesundheit/chs_cannabinoid_hyperemesis_syndrom");
    expect(ids).toContain("folder:Gesundheit/Bitcoin_and_Crypto");

    // From the sibling folder, one more expand step (seeded from that folder node)
    // reaches the actual file - confirming the structure is navigable end to end,
    // just not all in a single bounded call.
    const nextHop = await service.expand({ seedIds: ["folder:Gesundheit/Bitcoin_and_Crypto"], maxHops: 1, maxNodes: 15 });
    expect(nextHop.map((n) => n.id)).toContain("Gesundheit/Bitcoin_and_Crypto/portfolio.md");
  });

  it("clamps maxNodes/maxHops to the hard caps even if a caller asks for more", async () => {
    const nodes = await service.expand({ query: "cats", maxHops: 999, maxNodes: 999 });
    expect(nodes.length).toBeLessThanOrEqual(25);
    expect(nodes.every((n) => n.hopDistance <= 3)).toBe(true);
  });
});
