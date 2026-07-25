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
    json: "bg-slate-950",
    markdown: "bg-slate-900",
    html: "bg-orange-950",
    javascript: "bg-yellow-950",
    typescript: "bg-blue-950",
    python: "bg-blue-900",
    bash: "bg-gray-950",
    yaml: "bg-slate-950",
    xml: "bg-orange-950",
    plaintext: "bg-gray-950",
  };
  const bgColor = bgColorMap[detectedLang] || "bg-gray-950";

  const borderColorMap: Record<string, string> = {
    json: "border-slate-700",
    markdown: "border-slate-700",
    html: "border-orange-700",
    javascript: "border-yellow-700",
    typescript: "border-blue-700",
    python: "border-blue-700",
    bash: "border-gray-700",
    yaml: "border-slate-700",
    xml: "border-orange-700",
    plaintext: "border-gray-700",
  };
  const borderColor = borderColorMap[detectedLang] || "border-gray-700";

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
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 bg-gray-900/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-gray-400">{detectedLang.toUpperCase()}</span>
          {title && <span className="text-xs text-gray-500">{title}</span>}
        </div>
        <button
          onClick={handleCopy}
          className="text-xs text-gray-400 hover:text-white transition p-1"
          title="Copy to clipboard"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-sm text-gray-200 font-mono">
        <code>{content}</code>
      </pre>
    </div>
  );
}
