/**
 * Minimal HTML/CSS parsing without a DOM dependency (none exists in this workspace - see
 * apps/server/package.json). Good enough for well-formed shop markup; not a spec-compliant
 * HTML parser. Mismatched/unknown tags are tolerated rather than rejected.
 */

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const SKIP_TAGS = new Set(["script", "style", "noscript"]);

/** @typedef {{ tag: string, attrs: Record<string,string>, classes: string[], children: Node[], parent: Node|null, text: string }} Node */

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€", pound: "£", copy: "©", mdash: "—", ndash: "–" };
function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[ent] ?? m;
  });
}

function parseAttrs(attrStr) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+))?/g;
  let m;
  while ((m = re.exec(attrStr))) {
    const key = m[1].toLowerCase();
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[2] !== undefined ? m[2] : "";
    attrs[key] = value;
  }
  return attrs;
}

/** Parses html into a tree rooted at a synthetic "root" node. Strips <style>/<script> content out (returned separately). */
export function parseHtml(html) {
  const styleBlocks = [];
  const src = String(html || "").replace(/<!--[\s\S]*?-->/g, "");
  const root = { tag: "root", attrs: {}, classes: [], children: [], parent: null, text: "" };
  const stack = [root];
  const tokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^<>]*?)(\/?)>|([^<]+)/g;
  let m;
  let skipUntil = null; // tag name we're skipping content for (script/style/noscript)
  let skipBuffer = "";
  while ((m = tokenRe.exec(src))) {
    const [, closing, tagRaw, attrStr, selfClose, text] = m;
    if (skipUntil) {
      if (text !== undefined) { skipBuffer += text; continue; }
      const tag = tagRaw.toLowerCase();
      if (closing && tag === skipUntil) {
        if (skipUntil === "style") styleBlocks.push(skipBuffer);
        skipUntil = null; skipBuffer = "";
      } else {
        skipBuffer += m[0];
      }
      continue;
    }
    if (text !== undefined) {
      const top = stack[stack.length - 1];
      top.text += decodeEntities(text);
      continue;
    }
    const tag = tagRaw.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    if (SKIP_TAGS.has(tag)) { skipUntil = tag; skipBuffer = ""; continue; }
    const attrs = parseAttrs(attrStr || "");
    const classes = (attrs["class"] || "").split(/\s+/).filter(Boolean);
    const node = { tag, attrs, classes, children: [], parent: stack[stack.length - 1], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!VOID_TAGS.has(tag) && !selfClose) stack.push(node);
  }
  return { root, styleBlocks };
}

export function walk(node, fn) {
  fn(node);
  for (const c of node.children) walk(c, fn);
}

export function subtreeText(node) {
  let out = node.text || "";
  for (const c of node.children) out += " " + subtreeText(c);
  return out.replace(/\s+/g, " ").trim();
}

export function findAll(node, pred) {
  const out = [];
  walk(node, (n) => { if (n !== node && pred(n)) out.push(n); });
  return out;
}

export function findFirst(node, pred) {
  let found = null;
  walk(node, (n) => { if (!found && n !== node && pred(n)) found = n; });
  return found;
}

/** Very small CSS parser: flat list of top-level rules (ignores @media/@supports nesting for simplicity). */
export function parseCss(cssText) {
  const rules = [];
  const text = String(cssText || "").replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const selector = m[1].trim();
    if (!selector || selector.startsWith("@")) continue;
    const declarations = [];
    for (const part of m[2].split(";")) {
      const idx = part.indexOf(":");
      if (idx <= 0) continue;
      const prop = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (prop && value) declarations.push([prop, value]);
    }
    if (declarations.length) rules.push({ selector, declarations });
  }
  return rules;
}

/** Given a node's class list, collect declarations from parsed CSS rules whose selector is exactly one of
 *  `.class` (simple class selectors only - descendant/pseudo selectors are not resolved without full cascade). */
export function declarationsForClasses(rules, classes) {
  const wanted = new Set(classes.map((c) => "." + c));
  const merged = new Map();
  for (const rule of rules) {
    const selectors = rule.selector.split(",").map((s) => s.trim());
    if (!selectors.some((s) => wanted.has(s))) continue;
    for (const [prop, value] of rule.declarations) merged.set(prop, value);
  }
  return Array.from(merged.entries());
}

export function inlineStyleDeclarations(node) {
  const style = node.attrs && node.attrs["style"];
  if (!style) return [];
  const decls = [];
  for (const part of style.split(";")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    decls.push([part.slice(0, idx).trim(), part.slice(idx + 1).trim()]);
  }
  return decls;
}
