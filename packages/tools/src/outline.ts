import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";

const requireFromHere = createRequire(import.meta.url);

export interface SymbolEntry {
  kind: string;
  name: string;
  line: number;
  children?: SymbolEntry[];
}

export interface OutlineResult {
  symbols: SymbolEntry[];
  totalLines: number;
  source: "typescript" | "heuristic";
}

/**
 * Loads TypeScript lazily and tolerates its absence.
 *
 * The outline is a token-saving convenience, so it must degrade to the regex path rather than
 * fail when a project has no TypeScript installed.
 */
function tryLoadTypeScript(): typeof import("typescript") | undefined {
  try {
    return requireFromHere("typescript") as typeof import("typescript");
  } catch {
    return undefined;
  }
}

const TS_LIKE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

function outlineWithTypeScript(filePath: string, content: string): OutlineResult | undefined {
  const ts = tryLoadTypeScript();
  if (!ts) return undefined;

  try {
    const scriptKind = /\.tsx$/i.test(filePath)
      ? ts.ScriptKind.TSX
      : /\.jsx$/i.test(filePath)
        ? ts.ScriptKind.JSX
        : /\.(js|mjs|cjs)$/i.test(filePath)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;

    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);
    const symbols: SymbolEntry[] = [];

    const lineOf = (node: import("typescript").Node): number =>
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

    const visit = (node: import("typescript").Node, sink: SymbolEntry[]): void => {
      const push = (kind: string, name: string, children?: SymbolEntry[]): void => {
        const entry: SymbolEntry = { kind, name, line: lineOf(node) };
        if (children && children.length > 0) entry.children = children;
        sink.push(entry);
      };

      if (ts.isFunctionDeclaration(node) && node.name) {
        push("function", node.name.text);
        return;
      }
      if (ts.isClassDeclaration(node) && node.name) {
        const members: SymbolEntry[] = [];
        for (const member of node.members) {
          const name = member.name && ts.isIdentifier(member.name) ? member.name.text : undefined;
          if (!name) continue;
          const kind = ts.isMethodDeclaration(member)
            ? "method"
            : ts.isPropertyDeclaration(member)
              ? "property"
              : ts.isGetAccessor(member)
                ? "getter"
                : ts.isSetAccessor(member)
                  ? "setter"
                  : "member";
          members.push({ kind, name, line: sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1 });
        }
        push("class", node.name.text, members);
        return;
      }
      if (ts.isInterfaceDeclaration(node)) {
        push("interface", node.name.text);
        return;
      }
      if (ts.isTypeAliasDeclaration(node)) {
        push("type", node.name.text);
        return;
      }
      if (ts.isEnumDeclaration(node)) {
        push("enum", node.name.text);
        return;
      }
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          const initializer = declaration.initializer;
          const kind =
            initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
              ? "function"
              : "const";
          sink.push({
            kind,
            name: declaration.name.text,
            line: sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1,
          });
        }
        return;
      }

      ts.forEachChild(node, (child) => visit(child, sink));
    };

    ts.forEachChild(sourceFile, (node) => visit(node, symbols));

    return { symbols, totalLines: content.split("\n").length, source: "typescript" };
  } catch {
    return undefined;
  }
}

/**
 * Language-agnostic fallback. Deliberately shallow: it recognises the declaration forms of the
 * common languages and nothing more. It exists so that asking for an outline of a Python or Go
 * file returns something useful instead of an error - not to be a parser.
 */
function outlineHeuristically(content: string): OutlineResult {
  const patterns: Array<{ kind: string; re: RegExp }> = [
    { kind: "class", re: /^\s*(?:export\s+)?(?:public\s+|abstract\s+)?class\s+(\w+)/ },
    { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?def\s+(\w+)/ },
    { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/ },
    { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/ },
    { kind: "function", re: /^\s*(?:pub\s+)?fn\s+(\w+)/ },
    { kind: "struct", re: /^\s*(?:pub\s+)?struct\s+(\w+)/ },
    { kind: "interface", re: /^\s*(?:export\s+)?interface\s+(\w+)/ },
  ];

  const symbols: SymbolEntry[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    for (const { kind, re } of patterns) {
      const match = re.exec(line);
      if (match?.[1]) {
        symbols.push({ kind, name: match[1], line: index + 1 });
        break;
      }
    }
  }

  return { symbols, totalLines: lines.length, source: "heuristic" };
}

export function outlineFile(filePath: string): OutlineResult {
  const content = readFileSync(filePath, "utf8");
  if (TS_LIKE.test(filePath)) {
    const result = outlineWithTypeScript(filePath, content);
    if (result) return result;
  }
  return outlineHeuristically(content);
}

/** One line per symbol, nested one level. Reading a 4000-line file costs ~40k tokens; its
 *  outline costs a few hundred, and is usually all that is needed to decide WHICH lines to read. */
export function renderOutline(filePath: string, result: OutlineResult): string {
  if (result.symbols.length === 0) {
    return `${basename(filePath)}: no top-level symbols recognised (${result.totalLines} lines).`;
  }

  const lines: string[] = [];
  for (const symbol of result.symbols) {
    lines.push(`${symbol.line}: ${symbol.kind} ${symbol.name}`);
    for (const child of symbol.children ?? []) {
      lines.push(`  ${child.line}: ${child.kind} ${child.name}`);
    }
  }
  return lines.join("\n");
}
