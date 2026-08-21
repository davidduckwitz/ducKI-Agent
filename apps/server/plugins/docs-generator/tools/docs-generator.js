/**
 * Document generator module tool (trust: "node"). Markdown templates with {{placeholder}}
 * tokens and generated documents live in the plugin's own SQLite. No external PDF library or
 * service - a generated document renders as clean HTML the plugin's frontend page prints via
 * the browser's native print dialog ("Print -> Save as PDF"), same approach as invoicing.
 * The markdown->HTML conversion below is a small self-contained subset (headings, bold,
 * italic, links, lists, paragraphs) - enough for offer/contract/report templates without
 * pulling in a markdown dependency.
 */

export const definition = {
  name: "docs_generator",
  description:
    "Dokumentvorlagen und generierte Dokumente. action=add_template (name, type, body_markdown mit {{platzhaltern}})/list_templates/get_template/delete_template. " +
    "action=generate_document (template_id, name, data: {platzhalter: wert}) füllt die Vorlage und rendert sie zu HTML. action=list_documents/get_document/delete_document.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add_template", "list_templates", "get_template", "delete_template", "generate_document", "list_documents", "get_document", "delete_document"] },
      id: { type: "number", description: "Ziel-ID" },
      name: { type: "string", description: "Vorlagenname (add_template) oder Dokumentname (generate_document)" },
      type: { type: "string", description: "Vorlagentyp, z. B. Angebot, Vertrag, Report (add_template)" },
      body_markdown: { type: "string", description: "Vorlagentext in Markdown mit {{platzhaltern}} (add_template)" },
      template_id: { type: "number", description: "Vorlage für generate_document" },
      data: { type: "object", description: "Platzhalter-Werte als { platzhalter: wert } (generate_document)" },
    },
    required: ["action"],
  },
};

async function ensureSchema(storage) {
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT, body_markdown TEXT NOT NULL, created_at TEXT NOT NULL)"
  );
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, rendered_html TEXT NOT NULL, created_at TEXT NOT NULL)"
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Minimal markdown -> HTML: headings, bold, italic, links, unordered/ordered lists, paragraphs. */
function markdownToHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let listType = null; // "ul" | "ol" | null
  let paragraph = [];

  function inline(text) {
    let t = escapeHtml(text);
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    return t;
  }
  function flushParagraph() {
    if (paragraph.length) { out.push("<p>" + paragraph.join(" ") + "</p>"); paragraph = []; }
  }
  function closeList() {
    if (listType) { out.push(listType === "ul" ? "</ul>" : "</ol>"); listType = null; }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { flushParagraph(); closeList(); continue; }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const ulItem = /^[-*]\s+(.*)$/.exec(line);
    if (ulItem) {
      flushParagraph();
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push("<li>" + inline(ulItem[1]) + "</li>");
      continue;
    }
    const olItem = /^\d+\.\s+(.*)$/.exec(line);
    if (olItem) {
      flushParagraph();
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push("<li>" + inline(olItem[1]) + "</li>");
      continue;
    }
    closeList();
    paragraph.push(inline(line));
  }
  flushParagraph();
  closeList();
  return out.join("\n");
}

function fillPlaceholders(template, data) {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) => (data && data[key] != null ? String(data[key]) : match));
}

export async function execute(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  await ensureSchema(storage);

  if (input.action === "add_template") {
    if (!input.name || !input.body_markdown) return { error: "name und body_markdown sind erforderlich" };
    const res = await storage.query("INSERT INTO templates (name, type, body_markdown, created_at) VALUES (?, ?, ?, ?) RETURNING *", [
      input.name, input.type ?? null, input.body_markdown, new Date().toISOString(),
    ]);
    return { added: true, template: res[0] };
  }

  if (input.action === "list_templates") {
    const rows = await storage.query("SELECT * FROM templates ORDER BY name ASC");
    return { count: rows.length, templates: rows };
  }

  if (input.action === "get_template") {
    if (input.id == null) return { error: "id ist erforderlich" };
    const rows = await storage.query("SELECT * FROM templates WHERE id = ?", [input.id]);
    if (!rows[0]) return { error: "Vorlage nicht gefunden" };
    return rows[0];
  }

  if (input.action === "delete_template") {
    if (input.id == null) return { error: "id ist erforderlich" };
    await storage.exec("DELETE FROM templates WHERE id = ?", [input.id]);
    return { ok: true };
  }

  if (input.action === "generate_document") {
    if (input.template_id == null) return { error: "template_id ist erforderlich" };
    const rows = await storage.query("SELECT * FROM templates WHERE id = ?", [input.template_id]);
    if (!rows[0]) return { error: "Vorlage nicht gefunden" };
    const filled = fillPlaceholders(rows[0].body_markdown, input.data || {});
    const html = markdownToHtml(filled);
    const res = await storage.query(
      "INSERT INTO documents (template_id, name, data, rendered_html, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
      [input.template_id, input.name || rows[0].name, JSON.stringify(input.data || {}), html, new Date().toISOString()]
    );
    return { generated: true, document: { ...res[0], data: input.data || {} } };
  }

  if (input.action === "list_documents") {
    const rows = await storage.query("SELECT id, template_id, name, created_at FROM documents ORDER BY created_at DESC");
    return { count: rows.length, documents: rows };
  }

  if (input.action === "get_document") {
    if (input.id == null) return { error: "id ist erforderlich" };
    const rows = await storage.query("SELECT * FROM documents WHERE id = ?", [input.id]);
    if (!rows[0]) return { error: "Dokument nicht gefunden" };
    let data = {};
    try { data = JSON.parse(rows[0].data || "{}"); } catch { data = {}; }
    return { ...rows[0], data };
  }

  if (input.action === "delete_document") {
    if (input.id == null) return { error: "id ist erforderlich" };
    await storage.exec("DELETE FROM documents WHERE id = ?", [input.id]);
    return { ok: true };
  }

  return { error: `Unbekannte action: ${input.action}` };
}
