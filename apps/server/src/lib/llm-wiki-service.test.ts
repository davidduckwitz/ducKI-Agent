import { describe, expect, it } from "vitest";
import { aggregateWikiNotes, deriveFolderStructure, parseFrontmatter, parseWikiLinks, type WikiNoteNode } from "./llm-wiki-service.js";
import type { LlmWikiEntrySelect } from "@ducki/database";

describe("parseFrontmatter", () => {
  it("returns the content unchanged when there is no frontmatter block", () => {
    const result = parseFrontmatter("# Just a note\n\nSome content.");
    expect(result.tags).toEqual([]);
    expect(result.body).toBe("# Just a note\n\nSome content.");
  });

  it("parses inline array tags and strips the frontmatter block", () => {
    const result = parseFrontmatter('---\ntags: [project, todo]\n---\n# Note\nBody text.');
    expect(result.tags).toEqual(["project", "todo"]);
    expect(result.body).toBe("# Note\nBody text.");
  });

  it("parses YAML list-style tags", () => {
    const result = parseFrontmatter("---\ntags:\n  - alpha\n  - beta\n---\nBody.");
    expect(result.tags).toEqual(["alpha", "beta"]);
    expect(result.body).toBe("Body.");
  });
});

describe("parseWikiLinks", () => {
  const knownFiles = new Map<string, string>([
    ["foo", "notes/foo.md"],
    ["bar baz", "notes/bar baz.md"],
  ]);

  it("extracts and resolves a simple wikilink", () => {
    const links = parseWikiLinks("See [[Foo]] for details.", knownFiles);
    expect(links).toEqual([{ targetRaw: "Foo", targetFile: "notes/foo.md" }]);
  });

  it("extracts an aliased wikilink and resolves by the target, not the alias", () => {
    const links = parseWikiLinks("See [[Foo|the foo note]].", knownFiles);
    expect(links).toEqual([{ targetRaw: "Foo", targetFile: "notes/foo.md" }]);
  });

  it("marks unresolved links with a null targetFile", () => {
    const links = parseWikiLinks("See [[Nonexistent Note]].", knownFiles);
    expect(links).toEqual([{ targetRaw: "Nonexistent Note", targetFile: null }]);
  });

  it("deduplicates repeated links to the same target", () => {
    const links = parseWikiLinks("[[Foo]] and again [[Foo]].", knownFiles);
    expect(links).toHaveLength(1);
  });

  it("strips a heading anchor before resolving", () => {
    const links = parseWikiLinks("[[Foo#Some Heading]]", knownFiles);
    expect(links).toEqual([{ targetRaw: "Foo", targetFile: "notes/foo.md" }]);
  });
});

function note(id: string): WikiNoteNode {
  return { id, title: id, status: "approved", tags: [], kind: "note" };
}

describe("deriveFolderStructure", () => {
  it("creates no folder node for a root-level file", () => {
    const { folderNodes, folderEdges } = deriveFolderStructure([note("cats.md")]);
    expect(folderNodes).toEqual([]);
    expect(folderEdges).toEqual([]);
  });

  it("creates one folder node per immediate parent directory, with a membership edge per file", () => {
    const notes = [note("animals/cats.md"), note("animals/dogs.md"), note("plants/oak.md")];
    const { folderNodes, folderEdges } = deriveFolderStructure(notes);

    expect(folderNodes.map((n) => n.id).sort()).toEqual(["folder:animals", "folder:plants"]);
    expect(folderNodes.every((n) => n.kind === "folder")).toBe(true);

    expect(folderEdges).toContainEqual({ source: "animals/cats.md", target: "folder:animals" });
    expect(folderEdges).toContainEqual({ source: "animals/dogs.md", target: "folder:animals" });
    expect(folderEdges).toContainEqual({ source: "plants/oak.md", target: "folder:plants" });
    expect(folderEdges).toHaveLength(3);
  });

  it("creates the full ancestor chain for nested folders, not just the immediate parent", () => {
    const { folderNodes, folderEdges } = deriveFolderStructure([note("a/b/c/deep.md")]);
    expect(folderNodes.map((n) => n.id).sort()).toEqual(["folder:a", "folder:a/b", "folder:a/b/c"]);
    expect(folderEdges).toContainEqual({ source: "a/b/c/deep.md", target: "folder:a/b/c" });
    expect(folderEdges).toContainEqual({ source: "folder:a/b/c", target: "folder:a/b" });
    expect(folderEdges).toContainEqual({ source: "folder:a/b", target: "folder:a" });
    expect(folderEdges).toHaveLength(3);
  });

  it("gives a top-level folder its own node even when it only contains subfolders, not files directly", () => {
    // Regression case: Gesundheit/ has no files of its own, only two subfolders - it
    // must still appear in the graph, not be skipped as if indexing "started" one
    // level too deep.
    const notes = [note("Gesundheit/chs_cannabinoid_hyperemesis_syndrom/review.md"), note("Gesundheit/Bitcoin_and_Crypto/portfolio.md")];
    const { folderNodes, folderEdges } = deriveFolderStructure(notes);

    expect(folderNodes.map((n) => n.id).sort()).toEqual([
      "folder:Gesundheit",
      "folder:Gesundheit/Bitcoin_and_Crypto",
      "folder:Gesundheit/chs_cannabinoid_hyperemesis_syndrom",
    ]);
    expect(folderEdges).toContainEqual({ source: "folder:Gesundheit/chs_cannabinoid_hyperemesis_syndrom", target: "folder:Gesundheit" });
    expect(folderEdges).toContainEqual({ source: "folder:Gesundheit/Bitcoin_and_Crypto", target: "folder:Gesundheit" });
  });

  it("does not duplicate a shared ancestor edge across multiple notes", () => {
    const notes = [note("x/y/a.md"), note("x/y/b.md")];
    const { folderEdges } = deriveFolderStructure(notes);
    const xyToX = folderEdges.filter((e) => e.source === "folder:x/y" && e.target === "folder:x");
    expect(xyToX).toHaveLength(1);
  });

  it("produces a star topology, not pairwise edges, for a large folder (bounded growth)", () => {
    const notes = Array.from({ length: 100 }, (_, i) => note(`bucket/file${i}.md`));
    const { folderNodes, folderEdges } = deriveFolderStructure(notes);
    expect(folderNodes).toHaveLength(1);
    expect(folderEdges).toHaveLength(100); // O(n), never O(n^2)
  });
});

function entry(sourcePath: string, sourceFile: string): LlmWikiEntrySelect {
  return {
    id: sourcePath.length, // unique enough for these tests
    sourcePath,
    title: sourcePath,
    content: "irrelevant",
    contentHash: "hash",
    status: "approved",
    metadata: JSON.stringify({ sourceFile, tags: [] }),
    learnedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("aggregateWikiNotes title disambiguation", () => {
  it("titles a plain note by its basename", () => {
    const [note] = aggregateWikiNotes([entry("Gesundheit/CHS_review.md#chunk-1", "Gesundheit/CHS_review.md")]);
    expect(note?.title).toBe("CHS_review");
  });

  it("keeps the root index.md titled plainly - it is the only one with no parent folder", () => {
    const [note] = aggregateWikiNotes([entry("index.md#chunk-1", "index.md")]);
    expect(note?.title).toBe("index");
  });

  it("prefixes a subfolder's index.md with its parent folder so same-named index notes stay distinguishable", () => {
    const notes = aggregateWikiNotes([
      entry("index.md#chunk-1", "index.md"),
      entry("Gesundheit/index.md#chunk-1", "Gesundheit/index.md"),
      entry("Finanzen/index.md#chunk-1", "Finanzen/index.md"),
      entry("Finanzen/Bitcoin_and_Crypto/index.md#chunk-1", "Finanzen/Bitcoin_and_Crypto/index.md"),
    ]);
    const titles = notes.map((n) => n.title).sort();
    expect(titles).toEqual(["Bitcoin_and_Crypto/index", "Finanzen/index", "Gesundheit/index", "index"]);
    // No two distinct notes ever collide on title, which is the actual bug being fixed here.
    expect(new Set(titles).size).toBe(titles.length);
  });
});
