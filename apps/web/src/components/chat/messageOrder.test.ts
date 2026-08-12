import { describe, expect, it } from "vitest";
import {
  buildEventDedupKey,
  buildPersistedIndex,
  compareMessages,
  isSupersededByPersisted,
  persistedRowId,
  type PersistedIndex,
} from "./messageOrder";
import type { RenderedChatMessage } from "./chatTypes";

function msg(id: string, timestamp: string): RenderedChatMessage {
  return { id, role: "event", content: id, timestamp };
}

const TS = "2026-08-12T10:00:00.000Z";

describe("persistedRowId", () => {
  it("reads the row id of a persisted message", () => {
    expect(persistedRowId("db-42")).toBe(42);
  });

  it("returns undefined for local (uuid) ids", () => {
    expect(persistedRowId("6f1c0e2a-1111-2222-3333-444455556666")).toBeUndefined();
  });
});

describe("compareMessages", () => {
  it("orders by timestamp", () => {
    const sorted = [msg("db-2", "2026-08-12T10:00:05.000Z"), msg("db-1", TS)].sort(compareMessages);
    expect(sorted.map((m) => m.id)).toEqual(["db-1", "db-2"]);
  });

  it("keeps a same-millisecond batch in DB row order rather than sorting the ids as text", () => {
    // The regression: "db-100" < "db-98" lexicographically, so a batch of events emitted
    // within one millisecond used to render scrambled.
    const batch = [
      msg("db-98", TS),
      msg("db-99", TS),
      msg("db-100", TS),
      msg("db-101", TS),
      msg("db-102", TS),
    ];
    const shuffled = [batch[2]!, batch[0]!, batch[4]!, batch[1]!, batch[3]!];

    expect(shuffled.sort(compareMessages).map((m) => m.id)).toEqual([
      "db-98",
      "db-99",
      "db-100",
      "db-101",
      "db-102",
    ]);
  });

  it("places a persisted row before a local one at the same instant", () => {
    const sorted = [msg("local-uuid", TS), msg("db-7", TS)].sort(compareMessages);
    expect(sorted.map((m) => m.id)).toEqual(["db-7", "local-uuid"]);
  });

  it("leaves two local messages in arrival order (stable sort)", () => {
    const sorted = [msg("local-b", TS), msg("local-a", TS)].sort(compareMessages);
    expect(sorted.map((m) => m.id)).toEqual(["local-b", "local-a"]);
  });

  it("puts stored rows before local ones regardless of the clock", () => {
    // A local message is one that is not written yet, so it belongs after everything that is.
    // Timestamps must not override that: they come from different clocks (server emit time,
    // database insert time, previously the browser's own) and disagreeing by a second is normal.
    const sorted = [
      msg("local-x", "2026-08-12T10:00:01.000Z"),
      msg("db-500", "2026-08-12T10:00:09.000Z"),
    ].sort(compareMessages);
    expect(sorted.map((m) => m.id)).toEqual(["db-500", "local-x"]);
  });

  it("follows row id for stored rows even when their timestamps disagree", () => {
    // Row id is the write order; a timestamp that drifted the other way must not reorder them.
    const sorted = [
      msg("db-7", "2026-08-12T10:00:09.000Z"),
      msg("db-6", "2026-08-12T10:00:11.000Z"),
    ].sort(compareMessages);
    expect(sorted.map((m) => m.id)).toEqual(["db-6", "db-7"]);
  });

  it("orders local messages among themselves by timestamp", () => {
    const sorted = [
      msg("local-late", "2026-08-12T10:00:09.000Z"),
      msg("local-early", "2026-08-12T10:00:01.000Z"),
    ].sort(compareMessages);
    expect(sorted.map((m) => m.id)).toEqual(["local-early", "local-late"]);
  });
});

describe("isSupersededByPersisted", () => {
  const TURN = "turn-uuid-1";

  function index(overrides: Partial<PersistedIndex> = {}): PersistedIndex {
    return {
      ids: new Set<string>(),
      eventKeys: new Set<string>(),
      displayIds: new Set<string>(),
      turnIdsByRole: new Map<string, Set<string>>(),
      ...overrides,
    };
  }

  function local(role: RenderedChatMessage["role"], content: string): RenderedChatMessage {
    return {
      id: "local-1",
      role,
      content,
      timestamp: TS,
      metadata: { localMessageId: TURN },
    };
  }

  it("keeps the agent's reply while only the user row and events of that turn are stored", () => {
    // The regression: user rows and event rows are written long before the assistant row, and
    // all of them carry the same turn id. Matching on the turn id alone deleted the reply the
    // moment the turn started persisting, so it flashed up and vanished.
    const persisted = index({
      turnIdsByRole: new Map([
        ["user", new Set([TURN])],
        ["event", new Set([TURN])],
      ]),
    });

    expect(isSupersededByPersisted(local("assistant", "Hier ist das Ergebnis"), persisted)).toBe(false);
  });

  it("drops the agent's reply once the assistant row itself is stored", () => {
    const persisted = index({
      turnIdsByRole: new Map([
        ["user", new Set([TURN])],
        ["assistant", new Set([TURN])],
      ]),
    });

    expect(isSupersededByPersisted(local("assistant", "Hier ist das Ergebnis"), persisted)).toBe(true);
  });

  it("drops the local user message once its own row is stored", () => {
    const persisted = index({ turnIdsByRole: new Map([["user", new Set([TURN])]]) });
    expect(isSupersededByPersisted(local("user", "mach mal"), persisted)).toBe(true);
  });

  it("drops a local message whose rendered db id is already present", () => {
    const persisted = index({ ids: new Set(["db-5"]) });
    const msg: RenderedChatMessage = { id: "db-5", role: "assistant", content: "x", timestamp: TS };
    expect(isSupersededByPersisted(msg, persisted)).toBe(true);
  });

  it("dedups events by type+content+second, not by turn id", () => {
    const key = buildEventDedupKey("tool_result", "read file — OK", TS);
    const persisted = index({
      eventKeys: new Set([key]),
      // An assistant row of the same turn must not affect event dedup.
      turnIdsByRole: new Map([["assistant", new Set([TURN])]]),
    });

    const stored: RenderedChatMessage = {
      id: "local-e1",
      role: "event",
      eventType: "tool_result",
      content: "read file — OK",
      timestamp: TS,
    };
    const fresh: RenderedChatMessage = { ...stored, id: "local-e2", content: "write file — OK" };

    expect(isSupersededByPersisted(stored, persisted)).toBe(true);
    expect(isSupersededByPersisted(fresh, persisted)).toBe(false);
  });
});

describe("buildPersistedIndex", () => {
  const TURN = "turn-uuid-9";

  it("does not register an assistant row that renders as a tool event under 'assistant'", () => {
    // mapPersistedMessage re-maps an assistant row still carrying [TOOL:...] markers into a
    // tool_call event box. Indexing the RAW row registered it as "assistant", which deleted the
    // agent's real reply while nothing rendered in its place.
    const renderedAsEvent: RenderedChatMessage = {
      id: "db-11",
      role: "event",
      eventType: "tool_call",
      content: "[TOOL:filesystem] read",
      timestamp: TS,
      metadata: { localMessageId: TURN },
    };

    const index = buildPersistedIndex([renderedAsEvent]);

    expect(index.turnIdsByRole.get("assistant")).toBeUndefined();
    expect(index.turnIdsByRole.get("event")?.has(TURN)).toBe(true);

    const localReply: RenderedChatMessage = {
      id: "local-reply",
      role: "assistant",
      content: "Fertig, hier das Ergebnis.",
      timestamp: TS,
      metadata: { localMessageId: TURN },
    };
    expect(isSupersededByPersisted(localReply, index)).toBe(false);
  });

  it("registers a real assistant row so its local copy is dropped", () => {
    const index = buildPersistedIndex([
      {
        id: "db-12",
        role: "assistant",
        content: "Fertig, hier das Ergebnis.",
        timestamp: TS,
        metadata: { localMessageId: TURN },
      },
    ]);

    const localReply: RenderedChatMessage = {
      id: "local-reply",
      role: "assistant",
      content: "Fertig, hier das Ergebnis.",
      timestamp: TS,
      metadata: { localMessageId: TURN },
    };
    expect(isSupersededByPersisted(localReply, index)).toBe(true);
  });

  it("collects rendered ids and event dedup keys", () => {
    const index = buildPersistedIndex([
      { id: "db-1", role: "user", content: "hi", timestamp: TS },
      { id: "db-2", role: "event", eventType: "tool_result", content: "read — OK", timestamp: TS },
    ]);

    expect(index.ids.has("db-1")).toBe(true);
    expect(index.eventKeys.has(buildEventDedupKey("tool_result", "read — OK", TS))).toBe(true);
  });
});

describe("agent text display rows", () => {
  const TURN = "turn-uuid-3";

  function textRow(displayMessageId: string, id: string, content: string): RenderedChatMessage {
    return {
      id,
      role: "assistant",
      content,
      timestamp: TS,
      metadata: { localMessageId: TURN, displayMessageId },
    };
  }

  it("matches a block of agent text by its own id, not by the turn it belongs to", () => {
    // A turn produces several blocks of text, all sharing one turn id. Turn-level matching
    // would collapse them into one; the per-block id keeps them distinct.
    const index = buildPersistedIndex([textRow("block-1", "db-20", "Erst schaue ich nach.")]);

    expect(isSupersededByPersisted(textRow("block-1", "local-1", "Erst schaue ich nach."), index)).toBe(true);
    expect(isSupersededByPersisted(textRow("block-2", "local-2", "Und hier das Ergebnis."), index)).toBe(false);
  });

  it("keeps a block that is not stored yet even though the turn already has stored rows", () => {
    const index = buildPersistedIndex([
      { id: "db-21", role: "user", content: "mach mal", timestamp: TS, metadata: { localMessageId: TURN } },
      { id: "db-22", role: "event", eventType: "tool_result", content: "read — OK", timestamp: TS, metadata: { localMessageId: TURN } },
    ]);

    expect(isSupersededByPersisted(textRow("block-9", "local-9", "Fertig."), index)).toBe(false);
  });

  it("interleaves text blocks with tool events in write order", () => {
    // What the whole change is for: text lands between the tool calls it sits between, instead
    // of being collected into one block at the end of the transcript.
    const rows: RenderedChatMessage[] = [
      textRow("b1", "db-31", "Ich schaue in die Datei."),
      { id: "db-32", role: "event", eventType: "tool_call", content: "filesystem read", timestamp: TS },
      { id: "db-33", role: "event", eventType: "tool_result", content: "read — OK", timestamp: TS },
      textRow("b2", "db-34", "Gefunden, jetzt schreibe ich."),
      { id: "db-35", role: "event", eventType: "tool_call", content: "filesystem write", timestamp: TS },
      textRow("b3", "db-36", "Erledigt."),
    ];

    const shuffled = [rows[5]!, rows[1]!, rows[3]!, rows[0]!, rows[4]!, rows[2]!];
    expect(shuffled.sort(compareMessages).map((m) => m.id)).toEqual([
      "db-31",
      "db-32",
      "db-33",
      "db-34",
      "db-35",
      "db-36",
    ]);
  });
});
