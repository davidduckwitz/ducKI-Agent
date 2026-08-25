import { Check, Copy, ExternalLink } from "lucide-react";
import React, { useState } from "react";

function Inline({ text }: { text: string }) {
  const tokens = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<]+)/g);
  return <>{tokens.map((token, index) => {
    if (token.startsWith("`") && token.endsWith("`")) return <code key={index}>{token.slice(1, -1)}</code>;
    if (token.startsWith("**") && token.endsWith("**")) return <strong key={index}>{token.slice(2, -2)}</strong>;
    const markdownLink = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(token);
    if (markdownLink) return <a key={index} href={markdownLink[2]} target="_blank" rel="noreferrer">{markdownLink[1]}<ExternalLink/></a>;
    if (/^https?:\/\//.test(token)) return <a key={index} href={token} target="_blank" rel="noreferrer">{token}<ExternalLink/></a>;
    return <React.Fragment key={index}>{token}</React.Fragment>;
  })}</>;
}

function Code({ value, language }: { value: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1400); };
  return <div className="code-block"><div><span>{language || "text"}</span><button onClick={copy}>{copied ? <Check/> : <Copy/>}{copied ? "Kopiert" : "Kopieren"}</button></div><pre><code>{value.replace(/\n$/, "")}</code></pre></div>;
}

function Text({ value }: { value: string }) {
  const lines = value.replace(/\n{3,}/g, "\n\n").split("\n");
  return <>{lines.map((line, index) => {
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) return <div className={`md-heading h${heading[1].length}`} key={index}><Inline text={heading[2]}/></div>;
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) return <div className="md-list" key={index}><i>•</i><span><Inline text={bullet[1]}/></span></div>;
    const numbered = /^\s*(\d+)\.\s+(.+)$/.exec(line);
    if (numbered) return <div className="md-list" key={index}><i>{numbered[1]}.</i><span><Inline text={numbered[2]}/></span></div>;
    const quote = /^>\s?(.+)$/.exec(line);
    if (quote) return <blockquote key={index}><Inline text={quote[1]}/></blockquote>;
    if (!line.trim()) return <div className="md-space" key={index}/>;
    return <div className="md-line" key={index}><Inline text={line}/></div>;
  })}</>;
}

export function MarkdownMessage({ content }: { content: string }) {
  const parts: Array<{ type: "text" | "code"; value: string; language?: string }> = [];
  const expression = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0; let match: RegExpExecArray | null;
  while ((match = expression.exec(content))) { if (match.index > cursor) parts.push({ type: "text", value: content.slice(cursor, match.index) }); parts.push({ type: "code", language: match[1].trim(), value: match[2] }); cursor = expression.lastIndex; }
  if (cursor < content.length) parts.push({ type: "text", value: content.slice(cursor) });
  if (!parts.length) parts.push({ type: "text", value: content });
  return <div className="markdown-message">{parts.map((part, index) => part.type === "code" ? <Code key={index} value={part.value} language={part.language ?? "text"}/> : <Text key={index} value={part.value}/>)}</div>;
}
