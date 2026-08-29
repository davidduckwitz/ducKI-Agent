import { Check, Copy } from "lucide-react";
import { useState, useMemo } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { splitMarkdownSegments } from "../../lib/markdownSegments";
import { FileLinkChip } from "./FileLinkChip";

/**
 * Minimal markdown renderer for chat messages.
 *
 * Chat bubbles rendered agent output as raw `whitespace-pre-wrap` text, so a coding
 * agent's answer arrived as an undifferentiated wall in which fenced code blocks, their
 * language and their indentation were indistinguishable from prose. This handles the
 * subset that actually shows up in agent replies - fenced code, inline code, headings,
 * bullets and bold - deliberately without pulling in a full markdown/AST dependency.
 */

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-border bg-[#282c34]">
      <div className="flex items-center justify-between border-b border-border px-3 py-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{language}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
          title="Code kopieren"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Kopiert" : "Kopieren"}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{ margin: 0, background: "transparent", fontSize: "12px", padding: "0.75rem" }}
        wrapLongLines={false}
      >
        {code.replace(/\n$/, "")}
      </SyntaxHighlighter>
    </div>
  );
}

// Matches how the agent addresses the shared workspace in its own text (see filesystem.ts'
// "Normal agent" path convention): an optional "./" or leading "/" followed by "shared-workspace/"
// and the path inside it. Captured outside backticks too, since the agent doesn't always wrap
// paths in code spans.
const WORKSPACE_PATH_RE = /^(?:\.\/)?\/?shared-workspace\/([A-Za-z0-9_\-./]+)$/;
const TRAILING_PUNCTUATION_RE = /^(.*?)([.,;:!?)]+)$/;

function parseWorkspacePath(text: string): string | null {
  const match = WORKSPACE_PATH_RE.exec(text);
  return match ? (match[1] ?? null) : null;
}

/** Splits off trailing sentence punctuation (".", "," etc.) so "...index.html." doesn't turn the
 *  closing period into part of the linked path. */
function splitTrailingPunctuation(text: string): [string, string] {
  const match = TRAILING_PUNCTUATION_RE.exec(text);
  return match ? [match[1] ?? "", match[2] ?? ""] : [text, ""];
}

/** Inline formatting: `code`, **bold**, and shared-workspace file paths (rendered as an
 *  actionable chip, see FileLinkChip). Applied per line so a stray marker cannot swallow the
 *  rest of the message. */
function renderInline(text: string, keyPrefix: string) {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|(?:\.\/)?\/?shared-workspace\/[A-Za-z0-9_\-./]+)/g);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      const inner = part.slice(1, -1);
      const relPath = parseWorkspacePath(inner);
      if (relPath) {
        return <FileLinkChip key={key} rawText={inner} relPath={relPath} />;
      }
      return (
        <code key={key} className="rounded bg-black/40 px-1 py-0.5 font-mono text-[0.85em] text-amber-200">
          {inner}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    const [corePart, trailing] = splitTrailingPunctuation(part);
    const relPath = parseWorkspacePath(corePart);
    if (relPath) {
      return (
        <span key={key}>
          <FileLinkChip rawText={corePart} relPath={relPath} />
          {trailing}
        </span>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

function TextSegment({ content, keyPrefix }: { content: string; keyPrefix: string }) {
  const lines = content.replace(/\n{3,}/g, "\n\n").split("\n");

  return (
    <>
      {lines.map((line, index) => {
        const key = `${keyPrefix}-l${index}`;
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
          const level = heading[1]?.length ?? 1;
          return (
            <div
              key={key}
              className={`mt-2 mb-1 font-semibold ${level <= 2 ? "text-[1.05em]" : "text-[0.95em]"}`}
            >
              {renderInline(heading[2] ?? "", key)}
            </div>
          );
        }

        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        if (bullet) {
          return (
            <div key={key} className="flex gap-2 pl-1">
              <span className="select-none text-muted-foreground">•</span>
              <span className="min-w-0 flex-1">{renderInline(bullet[1] ?? "", key)}</span>
            </div>
          );
        }

        const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
        if (numbered) {
          return (
            <div key={key} className="flex gap-2 pl-1">
              <span className="select-none text-muted-foreground">{numbered[1]}.</span>
              <span className="min-w-0 flex-1">{renderInline(numbered[2] ?? "", key)}</span>
            </div>
          );
        }

        if (line.trim().length === 0) return <div key={key} className="h-2" />;
        return <div key={key}>{renderInline(line, key)}</div>;
      })}
    </>
  );
}

export function MarkdownMessage({ content }: { content: string }) {
  // Memoize markdown parsing to prevent re-parsing on every re-render during streaming.
  // This fixes issues where incomplete/unterminated code blocks appear broken until refresh.
  const segments = useMemo(() => splitMarkdownSegments(content), [content]);

  return (
    <div className="min-w-0 break-words">
      {segments.map((segment, index) =>
        segment.type === "code" ? (
          <CodeBlock key={index} code={segment.content} language={segment.language ?? "text"} />
        ) : (
          <TextSegment key={index} content={segment.content} keyPrefix={`s${index}`} />
        )
      )}
    </div>
  );
}
