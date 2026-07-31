import { Copy, Check } from "lucide-react";
import { useState } from "react";

interface CodeBlockRendererProps {
  content: string;
  language?: "json" | "markdown" | "html" | "javascript" | "typescript" | "python" | "bash" | "yaml" | "xml" | "plaintext";
  title?: string;
}

function detectLanguage(content: string): string {
  if (content.trim().startsWith("{") || content.trim().startsWith("[")) {
    try {
      JSON.parse(content);
      return "json";
    } catch {}
  }
  if (content.includes("```") || content.includes("# ") || content.includes("- ")) {
    return "markdown";
  }
  if (content.trim().startsWith("<")) {
    return "html";
  }
  return "plaintext";
}

export function CodeBlockRenderer({ content, language, title }: CodeBlockRendererProps) {
  const [copied, setCopied] = useState(false);
  const detectedLang: string = language || detectLanguage(content);

  const bgColorMap: Record<string, string> = {
    json: "bg-background",
    markdown: "bg-card",
    html: "bg-orange-950",
    javascript: "bg-yellow-950",
    typescript: "bg-blue-950",
    python: "bg-blue-900",
    bash: "bg-background",
    yaml: "bg-background",
    xml: "bg-orange-950",
    plaintext: "bg-background",
  };
  const bgColor = bgColorMap[detectedLang] || "bg-background";

  const borderColorMap: Record<string, string> = {
    json: "border-border",
    markdown: "border-border",
    html: "border-orange-700",
    javascript: "border-yellow-700",
    typescript: "border-blue-700",
    python: "border-blue-700",
    bash: "border-border",
    yaml: "border-border",
    xml: "border-orange-700",
    plaintext: "border-border",
  };
  const borderColor = borderColorMap[detectedLang] || "border-border";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback if clipboard API fails
    }
  };

  return (
    <div className={`border ${borderColor} rounded-lg overflow-hidden ${bgColor}`}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-muted-foreground">{detectedLang.toUpperCase()}</span>
          {title && <span className="text-xs text-muted-foreground">{title}</span>}
        </div>
        <button
          onClick={handleCopy}
          className="text-xs text-muted-foreground hover:text-foreground transition p-1"
          title="Copy to clipboard"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-sm text-foreground font-mono">
        <code>{content}</code>
      </pre>
    </div>
  );
}
