/**
 * Erkennt Produktboxen auf Shop-Seiten und generiert CSS fuer eine vom Nutzer gelieferte
 * HTML-Vorlage, die diese optisch angleicht. Projekte (Name, Shop-URL, Analyze-Typ, Template,
 * generiertes style.css) leben als echte Dateien unter data/projects/<id>/ (Wunsch: "im
 * Projektverzeichnis soll die style.css liegen"); die SQLite-DB ist nur der Index fuers UI-Listing.
 *
 * Seitenabruf laeuft ueber DucKIs eigenes Browser-Tool (@ducki/tools, Puppeteer), mit einer
 * dedizierten Session pro Projekt (sessionId = pbs-<projectId>) statt der geteilten Default-
 * Session - das haelt den Analyse-Lauf getrennt von einer laufenden Browsing-Session des Nutzers.
 * Waehrend der Analyse wird ein CDP-Stream gestartet, den das Frontend per action=browser_frame
 * pollt (gleiches Direct-Polling-Muster wie plugins/vision-analyzer/frontend/browser-direct.js) -
 * so sieht der Nutzer live, was das Plugin gerade auf der Shop-Seite tut. Ist Puppeteer/kein
 * Browser installiert, faellt der Heuristic-Pfad automatisch auf einen einfachen ctx.fetch()
 * zurueck (dann ohne Live-Ansicht, ohne JS-Rendering). vision-Modus nutzt fuer den Screenshot
 * ebenfalls die Browser-Session, sofern keiner explizit mitgegeben wird.
 *
 * Heuristic-Modus liest die Basis-Deklarationen zunaechst statisch aus <style>-Bloecken + inline
 * style="" (AUTHORED CSS). Lief eine Browser-Session, werden diese Werte danach per
 * enrichWithComputedStyles() durch echtes getComputedStyle() im Puppeteer-Tab ersetzt - das deckt
 * auch Styling ab, das aus externen Stylesheets kommt (der Normalfall bei echten Shop-Themes, die
 * selten <style>-Bloecke fuer die Hauptgestaltung nutzen). Nur ohne Browser-Session bleibt es beim
 * rein statischen (unvollstaendigeren) AUTHORED-CSS-Ergebnis.
 *
 * Vorlagen-Mapping (welches Template-Element zu welcher Rolle gehoert) versucht zuerst die
 * data-pb-Konvention, dann Tag/Klassen-Heuristiken (guessRoleForNode) und faellt fuer noch offene
 * Rollen auf llmAssistMapping() zurueck - das Modell waehlt aus einer nummerierten Liste realer
 * Template-Elemente, Selektoren werden also nie halluziniert, nur nicht zugeordnet.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHtml, findAll, findFirst, subtreeText, parseCss, declarationsForClasses, inlineStyleDeclarations } from "../runtime/html-lite.js";

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PROJECTS_DIR = join(PLUGIN_DIR, "data", "projects");

const ROLES = ["root", "image", "title", "price", "button", "rating", "badge", "description"];
const PRICE_RE = /(\d+[.,]\d{2}\s?(€|EUR|\$|USD|£|GBP))|((€|\$|£)\s?\d+[.,]?\d*)/;
const CTA_WORDS = /cart|warenkorb|kaufen|buy|add to|bestellen|jetzt/i;

function projectDir(id) { return join(PROJECTS_DIR, id); }
function browserSessionId(projectId) { return `pbs-${projectId}`; }

let browserToolPromise = null;
/** Lazily imports @ducki/tools' browserTool; returns null (rather than throwing) if unavailable
 *  so the plugin degrades to plain fetch() instead of failing entirely. */
function loadBrowserTool() {
  if (!browserToolPromise) {
    browserToolPromise = import("@ducki/tools").then((m) => m.browserTool ?? null).catch(() => null);
  }
  return browserToolPromise;
}

/** Opens (or reuses) the project's dedicated browser session, navigates to `url`, starts a live
 *  stream (best effort - frontend polls it via action=browser_frame) and reads the rendered HTML
 *  (+ optionally a screenshot for vision mode). Returns null on any failure so the caller can
 *  fall back to ctx.fetch(). */
async function fetchViaBrowser(ctx, sessionId, url, { wantScreenshot }) {
  const browserTool = await loadBrowserTool();
  if (!browserTool) return null;
  try {
    const launch = await browserTool.execute({ action: "launch", sessionId, url });
    if (!launch.success) { ctx.logger.warn(`[product-box-styler] browser launch failed: ${launch.error}`); return null; }
    await browserTool.execute({ action: "stream_start", sessionId }).catch(() => {});
    const content = await browserTool.execute({ action: "get_content", sessionId });
    if (!content.success) { ctx.logger.warn(`[product-box-styler] browser get_content failed: ${content.error}`); return null; }
    let screenshotBase64 = null;
    let screenshotFormat = "jpeg";
    if (wantScreenshot) {
      const shot = await browserTool.execute({ action: "screenshot", sessionId });
      if (shot.success) { screenshotBase64 = shot.data.screenshot; screenshotFormat = shot.data.metadata?.format || "jpeg"; }
    }
    return { html: content.data.html, screenshotBase64, screenshotFormat, currentUrl: content.data.url };
  } catch (e) {
    ctx.logger.warn(`[product-box-styler] browser flow failed: ${e.message}`);
    return null;
  }
}

async function ensureSchema(storage) {
  await storage.exec(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    shop_url TEXT,
    analyze_type TEXT NOT NULL DEFAULT 'heuristic',
    status TEXT NOT NULL DEFAULT 'draft',
    mapping_report TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

function readProjectFile(id, name) {
  const p = join(projectDir(id), name);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
function writeProjectFile(id, name, content) {
  mkdirSync(projectDir(id), { recursive: true });
  writeFileSync(join(projectDir(id), name), content ?? "", "utf8");
}

async function getRow(storage, id) {
  const rows = await storage.query("SELECT * FROM projects WHERE id = ?", [id]);
  return rows[0] || null;
}

function toProjectPayload(row, { includeFiles = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id, name: row.name, shopUrl: row.shop_url, analyzeType: row.analyze_type,
    status: row.status, errorMessage: row.error_message || null,
    mappingReport: row.mapping_report ? JSON.parse(row.mapping_report) : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (includeFiles) {
    out.templateHtml = readProjectFile(row.id, "template.html");
    out.styleCss = readProjectFile(row.id, "style.css");
  }
  return out;
}

// ---------- heuristic detection ----------

function classSignature(node) { return node.classes.slice().sort().join(" "); }

function scoreCandidate(node) {
  const text = subtreeText(node);
  const hasImg = !!findFirst(node, (n) => n.tag === "img");
  const hasPrice = PRICE_RE.test(text);
  const hasCta = !!findFirst(node, (n) => (n.tag === "button" || n.tag === "a") && CTA_WORDS.test(subtreeText(n) + " " + (n.attrs["class"] || "")));
  const reasonableSize = text.length > 15 && text.length < 800;
  let score = 0;
  if (hasImg) score += 2;
  if (hasPrice) score += 2;
  if (hasCta) score += 1;
  if (reasonableSize) score += 1;
  return { score, hasImg, hasPrice, hasCta };
}

function findProductBoxCandidates(root) {
  const groups = new Map(); // signature -> nodes[]
  findAll(root, (n) => n.classes.length > 0).forEach((n) => {
    const sig = classSignature(n);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(n);
  });
  const scored = [];
  for (const [sig, nodes] of groups) {
    if (nodes.length < 2) continue; // product boxes repeat
    const s = scoreCandidate(nodes[0]);
    if (s.score <= 0) continue;
    scored.push({ signature: sig, nodes, ...s, repeatCount: nodes.length });
  }
  scored.sort((a, b) => (b.score + Math.min(b.repeatCount, 5) * 0.1) - (a.score + Math.min(a.repeatCount, 5) * 0.1));
  return scored;
}

function detectRoles(boxNode) {
  const roles = {};
  roles.root = boxNode;
  roles.image = findFirst(boxNode, (n) => n.tag === "img");
  roles.button = findFirst(boxNode, (n) => (n.tag === "button" || n.tag === "a") && CTA_WORDS.test(subtreeText(n) + " " + (n.attrs["class"] || "")))
    || findFirst(boxNode, (n) => n.tag === "button");
  roles.price = findFirst(boxNode, (n) => n.children.length === 0 && PRICE_RE.test(n.text || ""))
    || findFirst(boxNode, (n) => PRICE_RE.test(n.text || "") && subtreeText(n).length < 40);
  roles.rating = findFirst(boxNode, (n) => /rating|stars|bewertung|sterne/i.test((n.attrs["class"] || "")));
  roles.badge = findFirst(boxNode, (n) => /badge|sale|new|tag|label/i.test((n.attrs["class"] || "")));
  roles.title = findFirst(boxNode, (n) => /^h[1-6]$/.test(n.tag))
    || findFirst(boxNode, (n) => n !== roles.button && n.tag === "a" && subtreeText(n).length >= 3 && subtreeText(n).length <= 100 && !PRICE_RE.test(subtreeText(n)));
  roles.description = findFirst(boxNode, (n) => /desc|summary|excerpt/i.test((n.attrs["class"] || "")));
  return roles;
}

function styleForNode(node, cssRules) {
  if (!node) return null;
  const fromClasses = declarationsForClasses(cssRules, node.classes);
  const inline = inlineStyleDeclarations(node);
  const merged = new Map(fromClasses);
  for (const [p, v] of inline) merged.set(p, v);
  return {
    tag: node.tag,
    classes: node.classes,
    declarations: Array.from(merged.entries()),
  };
}

const COMPUTED_PROPS = ["backgroundColor", "color", "fontSize", "fontWeight", "fontFamily", "borderRadius", "boxShadow", "padding", "margin", "textDecorationLine", "border", "gap"];
const COMPUTED_SKIP_IF = {
  backgroundColor: (v) => /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(v),
  boxShadow: (v) => v === "none",
  textDecorationLine: (v) => v === "none",
  border: (v) => /^0px\s+none/.test(v),
};
function kebabCase(s) { return s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()); }

/** Replaces authored declarations with real getComputedStyle() values read live from the
 *  browser session - covers styling that comes from external stylesheets (the norm for real
 *  shop themes), which the static <style>-block/inline parser in analyzeHeuristic() can't see.
 *  Best effort: leaves a role's authored declarations untouched if no browser session is open,
 *  the matching element can't be relocated live, or evaluate fails/times out. */
async function enrichWithComputedStyles(ctx, sessionId, styleSpec) {
  const browserTool = await loadBrowserTool();
  if (!browserTool) return;
  for (const role of Object.keys(styleSpec.roles || {})) {
    const info = styleSpec.roles[role];
    if (!info.classes || info.classes.length === 0) continue;
    const script = `(() => {
      const wanted = ${JSON.stringify(info.classes)};
      const all = document.querySelectorAll("${info.tag}");
      for (const el of all) {
        if (wanted.every((c) => el.classList.contains(c))) {
          const cs = getComputedStyle(el);
          const props = ${JSON.stringify(COMPUTED_PROPS)};
          const out = {};
          for (const p of props) out[p] = cs[p];
          return out;
        }
      }
      return null;
    })()`;
    try {
      const res = await browserTool.execute({ action: "evaluate", sessionId, script, timeoutMs: 8000 });
      if (!res.success || !res.data?.result) continue;
      const computed = res.data.result;
      const declarations = [];
      for (const prop of COMPUTED_PROPS) {
        const value = computed[prop];
        if (!value) continue;
        const skip = COMPUTED_SKIP_IF[prop];
        if (skip && skip(value)) continue;
        declarations.push([kebabCase(prop), value]);
      }
      if (declarations.length > 0) info.declarations = declarations;
    } catch {
      // keep the authored declarations from the static parse as fallback
    }
  }
}

async function analyzeHeuristic(html) {
  const { root, styleBlocks } = parseHtml(html);
  const cssRules = styleBlocks.flatMap((block) => parseCss(block));
  const candidates = findProductBoxCandidates(root);
  if (candidates.length === 0) {
    return { confidence: 0, roles: {}, notes: "Keine wiederkehrende Produktbox-Struktur im HTML gefunden (evtl. wird die Seite per JS gerendert - dann gerenderte HTML statt URL uebergeben)." };
  }
  const best = candidates[0];
  const roleNodes = detectRoles(best.nodes[0]);
  const roles = {};
  let found = 0;
  for (const role of ROLES) {
    const styled = styleForNode(roleNodes[role], cssRules);
    if (styled) { roles[role] = styled; found++; }
  }
  const confidence = Math.min(1, (found / ROLES.length) * 0.7 + Math.min(best.repeatCount, 5) / 5 * 0.3);
  return { confidence, roles, repeatCount: best.repeatCount, notes: null };
}

async function analyzeVision(ctx, screenshotBase64, mimeType = "image/png") {
  if (!ctx.agent) return { error: "Vision-Analyse steht in diesem Kontext nicht zur Verfuegung (kein Agent-Zugriff)." };
  const instruction =
    "Du siehst den Screenshot einer Shop-Seite. Beschreibe die auffaelligste Produktbox (Produktkarte) knapp: " +
    "Hintergrundfarbe, Textfarben, ungefaehre Schriftgroessen, Eckenradius, Schatten, Abstaende, Anordnung von Bild/Titel/Preis/Button. " +
    "Antworte als kurze Stichpunktliste, keine Prosa.";
  const description = await ctx.agent.analyzeImage([{ base64: screenshotBase64, mimeType }], instruction);
  return { visionNotes: description };
}

// ---------- template mapping + CSS generation ----------

function guessRoleForNode(node) {
  const cls = (node.attrs["class"] || "").toLowerCase();
  if (node.attrs["data-pb"]) return node.attrs["data-pb"];
  if (node.tag === "img") return "image";
  if (/^h[1-6]$/.test(node.tag)) return "title";
  if (/price/.test(cls)) return "price";
  if ((node.tag === "button" || node.tag === "a") && (CTA_WORDS.test(cls) || /button|btn|cta/.test(cls))) return "button";
  if (/rating|stars/.test(cls)) return "rating";
  if (/badge|sale|tag|label/.test(cls)) return "badge";
  if (/desc|summary|excerpt/.test(cls)) return "description";
  if (/product|card|box/.test(cls)) return "root";
  return null;
}

const UTILITY_CLASS_RE = /^(d-flex|flex-|is-desktop|is-mobile|align-|justify-|position-|overflow-|w-\d|h-\d|m[tblr]?-\d|p[tblr]?-\d|col-|row|container|text-(left|right|center)|d-(none|block|inline))/;

function selectorForNode(node, role) {
  if (node.attrs["data-pb"]) return `[data-pb="${node.attrs["data-pb"]}"]`;
  if (node.classes.length) {
    const distinctive = node.classes.find((c) => !UTILITY_CLASS_RE.test(c));
    return "." + (distinctive || node.classes[0]);
  }
  return node.tag;
}

function mapTemplate(templateHtml) {
  const { root } = parseHtml(templateHtml);
  const allNodes = findAll(root, () => true);
  const mapped = {};
  for (const node of allNodes) {
    const role = guessRoleForNode(node);
    if (role && ROLES.includes(role) && !mapped[role]) {
      mapped[role] = { node, selector: selectorForNode(node, role), matchedBy: node.attrs["data-pb"] ? "data-pb" : "heuristic" };
    }
  }
  return mapped;
}

/** Fallback for real-world templates that use neither data-pb nor recognizable class-name
 *  keywords (e.g. Shopware/Bootstrap-style utility classes like ".text-sw-color-brand-tertiary").
 *  Shows the LLM a NUMBERED list of candidate elements and asks it to pick indices per role -
 *  indices are bounds-checked against real parsed nodes, so a hallucinated answer can only fail
 *  to map a role, never produce a selector that targets the wrong/nonexistent element. */
async function llmAssistMapping(ctx, templateHtml, alreadyMapped) {
  if (!ctx.agent) return {};
  const missingRoles = ROLES.filter((r) => r !== "root" && !alreadyMapped[r]);
  if (missingRoles.length === 0) return {};
  const { root } = parseHtml(templateHtml);
  const candidates = findAll(root, (n) => n.classes.length > 0 || /^h[1-6]$/.test(n.tag) || n.tag === "img" || n.tag === "button" || n.tag === "a").slice(0, 40);
  if (candidates.length === 0) return {};
  const listing = candidates.map((n, i) => {
    const txt = subtreeText(n).slice(0, 60);
    const cls = n.classes.length ? ` class="${n.classes.join(" ")}"` : "";
    return `${i}: <${n.tag}${cls}> ${txt}`;
  }).join("\n");
  const instruction =
    `Das ist eine nummerierte Liste von HTML-Elementen aus einer Produktkarten-Vorlage. Ordne jeder dieser Rollen die passende Element-Nummer zu, falls ein Element dafuer existiert: ${missingRoles.join(", ")}. ` +
    `Jede Nummer darf nur EINER Rolle zugeordnet werden - nie derselbe Index fuer zwei Rollen. ` +
    `Antworte NUR mit kompaktem JSON (Rolle -> Nummer), z.B. {"title": 3, "price": 5}. Lasse eine Rolle weg, wenn kein passendes Element existiert. Keine Erklaerung, kein Markdown, kein Codeblock.`;
  let raw;
  try { raw = await ctx.agent.analyzeText(listing, instruction); } catch { return {}; }
  const match = String(raw || "").match(/\{[\s\S]*\}/);
  if (!match) return {};
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return {}; }
  const result = {};
  const usedIndices = new Set();
  for (const role of missingRoles) {
    const idx = Number(parsed[role]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) continue;
    if (usedIndices.has(idx)) continue; // model reused an index across roles - first role wins, rest stay unmatched
    usedIndices.add(idx);
    const node = candidates[idx];
    result[role] = { node, selector: selectorForNode(node, role), matchedBy: "llm" };
  }
  return result;
}

async function generateCss(ctx, templateHtml, styleSpec) {
  const heuristicMapped = mapTemplate(templateHtml);
  const llmMapped = await llmAssistMapping(ctx, templateHtml, heuristicMapped);
  const mapped = { ...heuristicMapped, ...llmMapped };
  // Guard against two roles landing on the identical template node (e.g. heuristic and llm
  // mapping disagreeing, or a duplicate slipping past llmAssistMapping's own index dedup) -
  // whichever role reaches it first in ROLES order keeps it, the other is left unmatched
  // rather than silently emitting two CSS rules for the same selector.
  const usedNodes = new Set();
  for (const role of ROLES) {
    const m = mapped[role];
    if (!m) continue;
    if (usedNodes.has(m.node)) { delete mapped[role]; continue; }
    usedNodes.add(m.node);
  }
  const rootSelector = mapped.root ? mapped.root.selector : null;
  const lines = [];
  const report = [];
  for (const role of ROLES) {
    const specRole = styleSpec.roles && styleSpec.roles[role];
    const mappedRole = mapped[role];
    if (!mappedRole) { report.push({ role, status: "unmatched_in_template" }); continue; }
    if (!specRole || !specRole.declarations || specRole.declarations.length === 0) { report.push({ role, status: "no_style_detected", selector: mappedRole.selector }); continue; }
    const selector = role === "root" ? mappedRole.selector : (rootSelector ? `${rootSelector} ${mappedRole.selector}` : mappedRole.selector);
    lines.push(`/* ${role} */`);
    lines.push(`${selector} {`);
    for (const [prop, value] of specRole.declarations) lines.push(`  ${prop}: ${value};`);
    lines.push("}", "");
    report.push({ role, status: "mapped", selector, matchedBy: mappedRole.matchedBy, properties: specRole.declarations.length });
  }
  if (styleSpec.visionNotes) {
    lines.unshift(`/* Vision-Hinweise (nicht automatisch in CSS-Werte umgesetzt):`, ...styleSpec.visionNotes.split("\n").map((l) => ` * ${l}`), " */", "");
  }
  return { css: lines.join("\n"), report };
}

// ---------- actions ----------

async function createProject(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  await ensureSchema(storage);
  const name = String(input.name || "").trim();
  if (!name) return { error: "name is required" };
  const analyzeType = ["heuristic", "vision", "combo"].includes(input.analyzeType) ? input.analyzeType : "heuristic";
  const id = randomUUID();
  const now = new Date().toISOString();
  await storage.exec(
    "INSERT INTO projects (id, name, shop_url, analyze_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
    [id, name, String(input.shopUrl || ""), analyzeType, now, now],
  );
  writeProjectFile(id, "template.html", "");
  writeProjectFile(id, "style.css", "");
  return { project: toProjectPayload(await getRow(storage, id)) };
}

async function listProjects(_input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  await ensureSchema(storage);
  const rows = await storage.query("SELECT * FROM projects ORDER BY updated_at DESC");
  return { projects: rows.map((r) => toProjectPayload(r)) };
}

async function getProject(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  const row = await getRow(storage, String(input.id || ""));
  if (!row) return { error: "project not found" };
  return { project: toProjectPayload(row, { includeFiles: true }) };
}

async function updateProjectMeta(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  const row = await getRow(storage, String(input.id || ""));
  if (!row) return { error: "project not found" };
  const name = input.name !== undefined ? String(input.name) : row.name;
  const shopUrl = input.shopUrl !== undefined ? String(input.shopUrl) : row.shop_url;
  const analyzeType = input.analyzeType !== undefined && ["heuristic", "vision", "combo"].includes(input.analyzeType) ? input.analyzeType : row.analyze_type;
  await storage.exec("UPDATE projects SET name = ?, shop_url = ?, analyze_type = ?, updated_at = ? WHERE id = ?", [name, shopUrl, analyzeType, new Date().toISOString(), row.id]);
  return { project: toProjectPayload(await getRow(storage, row.id)) };
}

async function deleteProject(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  const id = String(input.id || "");
  await storage.exec("DELETE FROM projects WHERE id = ?", [id]);
  try { rmSync(projectDir(id), { recursive: true, force: true }); } catch { /* best effort */ }
  return { deleted: true, id };
}

async function uploadTemplate(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  const row = await getRow(storage, String(input.id || ""));
  if (!row) return { error: "project not found" };
  const templateHtml = String(input.templateHtml || "");
  writeProjectFile(row.id, "template.html", templateHtml);
  const { root } = parseHtml(templateHtml);
  const mapped = mapTemplate(templateHtml);
  const detectedClasses = Array.from(new Set(findAll(root, (n) => n.classes.length > 0).flatMap((n) => n.classes)));
  await storage.exec("UPDATE projects SET updated_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);
  return {
    saved: true,
    detectedClasses,
    roleMapping: Object.fromEntries(Object.entries(mapped).map(([role, m]) => [role, { selector: m.selector, matchedBy: m.matchedBy }])),
  };
}

async function runAnalysis(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  const row = await getRow(storage, String(input.id || ""));
  if (!row) return { error: "project not found" };
  const templateHtml = readProjectFile(row.id, "template.html");
  if (!templateHtml.trim()) return { error: "Bitte zuerst ein HTML-Template hochladen (upload_template)." };

  let pageHtml = String(input.pageHtml || "");
  let autoScreenshotBase64 = null;
  let autoScreenshotFormat = "jpeg";
  let usedBrowser = false;
  const sessionId = browserSessionId(row.id);
  const wantScreenshot = row.analyze_type === "vision" || row.analyze_type === "combo";
  if (!pageHtml && row.shop_url) {
    const viaBrowser = await fetchViaBrowser(ctx, sessionId, row.shop_url, { wantScreenshot });
    if (viaBrowser) {
      pageHtml = viaBrowser.html;
      autoScreenshotBase64 = viaBrowser.screenshotBase64;
      autoScreenshotFormat = viaBrowser.screenshotFormat;
      usedBrowser = true;
    } else {
      try {
        const res = await ctx.fetch(row.shop_url);
        pageHtml = await res.text();
      } catch (e) {
        await storage.exec("UPDATE projects SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?", [`Laden fehlgeschlagen: ${e.message}`, new Date().toISOString(), row.id]);
        return { error: `Shop-URL konnte nicht geladen werden (weder Browser noch fetch): ${e.message}. Alternativ gerendertes HTML als 'pageHtml' mitgeben.` };
      }
    }
  }
  if (!pageHtml) return { error: "Weder shopUrl noch pageHtml verfuegbar." };

  let styleSpec = { confidence: 0, roles: {} };
  if (row.analyze_type === "heuristic" || row.analyze_type === "combo") {
    styleSpec = await analyzeHeuristic(pageHtml);
    if (usedBrowser && Object.keys(styleSpec.roles).length > 0) {
      await enrichWithComputedStyles(ctx, sessionId, styleSpec);
    }
  }
  if (row.analyze_type === "vision" || (row.analyze_type === "combo" && styleSpec.confidence < 0.5)) {
    const screenshotBase64 = input.screenshotBase64 || autoScreenshotBase64;
    if (screenshotBase64) {
      const mimeType = input.screenshotBase64 ? "image/png" : `image/${autoScreenshotFormat}`;
      const vision = await analyzeVision(ctx, screenshotBase64, mimeType);
      if (vision.error && row.analyze_type === "vision") return { error: vision.error };
      if (vision.visionNotes) styleSpec.visionNotes = vision.visionNotes;
    } else if (row.analyze_type === "vision") {
      return { error: "analyzeType=vision benoetigt einen Screenshot - weder die Browser-Session noch ein mitgegebenes screenshotBase64 war verfuegbar (evtl. ist Puppeteer/Chrome nicht installiert)." };
    }
  }

  const { css, report } = await generateCss(ctx, templateHtml, styleSpec);
  writeProjectFile(row.id, "style.css", css);
  const status = styleSpec.confidence > 0 || styleSpec.visionNotes ? "analyzed" : "error";
  await storage.exec(
    "UPDATE projects SET status = ?, mapping_report = ?, error_message = ?, updated_at = ? WHERE id = ?",
    [status, JSON.stringify({ confidence: styleSpec.confidence, notes: styleSpec.notes, roles: report }), styleSpec.notes || null, new Date().toISOString(), row.id],
  );
  return { project: toProjectPayload(await getRow(storage, row.id), { includeFiles: true }) };
}

async function saveCss(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  const row = await getRow(storage, String(input.id || ""));
  if (!row) return { error: "project not found" };
  writeProjectFile(row.id, "style.css", String(input.css ?? ""));
  await storage.exec("UPDATE projects SET updated_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);
  return { saved: true };
}

async function getBrowserFrame(input, ctx) {
  if (!ctx.agent?.browser) return { error: "Browser-Live-Ansicht nicht verfuegbar (Permission 'browser.frames' fehlt oder kein Agent-Kontext)." };
  const id = String(input.id || "");
  if (!id) return { error: "id is required" };
  const frame = await ctx.agent.browser.getFrame(browserSessionId(id));
  if (!frame) return { frame: null };
  return { frame: { data: frame.data, format: frame.format === "png" ? "png" : "jpeg", timestamp: frame.timestamp ?? new Date().toISOString(), width: frame.width, height: frame.height } };
}

async function stopBrowserStream(input, ctx) {
  const id = String(input.id || "");
  if (!id) return { error: "id is required" };
  const browserTool = await loadBrowserTool();
  if (!browserTool) return { stopped: false };
  const res = await browserTool.execute({ action: "stream_stop", sessionId: browserSessionId(id) }).catch(() => null);
  return { stopped: Boolean(res?.success) };
}

export const definition = {
  name: "product_box_styler",
  description:
    "Verwaltet Projekte, die die Produktbox einer Shop-Seite erkennen und daraus CSS fuer eine eigene HTML-Vorlage generieren. " +
    "action=create_project (name, shopUrl?, analyzeType: heuristic|vision|combo). " +
    "action=list_projects. action=get_project (id) liefert auch templateHtml/styleCss. action=update_project (id, name?, shopUrl?, analyzeType?). action=delete_project (id). " +
    "action=upload_template (id, templateHtml) speichert die Vorlage und meldet erkannte Klassen + data-pb-Rollen-Mapping. " +
    "action=analyze (id, pageHtml?, screenshotBase64?) oeffnet dafuer eine eigene Browser-Session (per DucKIs Browser-Tool), erkennt die Produktbox und schreibt style.css ins Projekt. " +
    "action=browser_frame (id) liefert das aktuellste Live-Frame der laufenden Analyse-Browser-Session (zum Pollen aus einer UI). action=browser_stop (id) beendet deren Stream. " +
    "Vorlagen-Konvention: Elemente mit data-pb=\"root|image|title|price|button|rating|badge|description\" markieren - ohne diese Attribute wird per Tag/Klassen-Heuristik gemappt (unsicherer).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create_project", "list_projects", "get_project", "update_project", "delete_project", "upload_template", "analyze", "save_css", "browser_frame", "browser_stop"] },
      id: { type: "string" },
      name: { type: "string" },
      shopUrl: { type: "string" },
      analyzeType: { type: "string", enum: ["heuristic", "vision", "combo"] },
      templateHtml: { type: "string" },
      css: { type: "string", description: "Manuell bearbeiteter CSS-Inhalt fuer action=save_css" },
      pageHtml: { type: "string", description: "Bereits gerendertes HTML der Shop-Seite (statt eigener Browser-Session/shopUrl zu nutzen)" },
      screenshotBase64: { type: "string", description: "Screenshot der Shop-Seite als Base64 (optional fuer analyzeType=vision/combo, sonst nimmt die Browser-Session automatisch einen auf)" },
    },
    required: ["action"],
  },
};

export async function execute(input, ctx) {
  switch (input.action) {
    case "create_project": return createProject(input, ctx);
    case "list_projects": return listProjects(input, ctx);
    case "get_project": return getProject(input, ctx);
    case "update_project": return updateProjectMeta(input, ctx);
    case "delete_project": return deleteProject(input, ctx);
    case "upload_template": return uploadTemplate(input, ctx);
    case "analyze": return runAnalysis(input, ctx);
    case "save_css": return saveCss(input, ctx);
    case "browser_frame": return getBrowserFrame(input, ctx);
    case "browser_stop": return stopBrowserStream(input, ctx);
    default: return { error: `Unbekannte action: ${input.action}` };
  }
}
