import { memo, useMemo } from "react";
import { PrismAsyncLight as SyntaxHighlighter } from "react-syntax-highlighter";
import oneDark from "react-syntax-highlighter/dist/esm/styles/prism/one-dark";
import ts from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import js from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";

SyntaxHighlighter.registerLanguage("typescript", ts);
SyntaxHighlighter.registerLanguage("javascript", js);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("markdown", markdown);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("html", markup);
SyntaxHighlighter.registerLanguage("yaml", yaml);

export interface CodePreviewProps {
  code: string;
  language?: string;
  maxHeight?: number;
  fontSize?: number;
}

export const CodePreview = memo(function CodePreview({
  code,
  language = "text",
  maxHeight = 320,
  fontSize = 12,
}: CodePreviewProps) {
  const normalizedLanguage = useMemo(() => {
    if (!language) return "text";
    if (language === "tsx" || language === "ts") return "typescript";
    if (language === "jsx" || language === "js") return "javascript";
    if (language === "yml") return "yaml";
    return language;
  }, [language]);

  return (
    <SyntaxHighlighter
      language={normalizedLanguage}
      style={oneDark}
      customStyle={{ margin: 0, maxHeight: `${maxHeight}px`, overflow: "auto", fontSize: `${fontSize}px` }}
    >
      {code}
    </SyntaxHighlighter>
  );
});
