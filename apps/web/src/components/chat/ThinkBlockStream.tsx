import { useEffect, useRef, useState } from "react";

interface ThinkBlockStreamProps {
  content: string;
  isStreaming: boolean;
  onStreamComplete?: () => void;
}

/**
 * Renders think block content with a smooth streaming animation.
 * Simulates a typewriter effect as content arrives in deltas.
 */
export function ThinkBlockStream({
  content,
  isStreaming,
  onStreamComplete,
}: ThinkBlockStreamProps) {
  const [displayedContent, setDisplayedContent] = useState<string>("");
  const [visibleLength, setVisibleLength] = useState<number>(0);
  const contentRef = useRef<HTMLDivElement>(null);

  // Simulate streaming with content reveal
  useEffect(() => {
    if (!isStreaming) {
      setDisplayedContent(content);
      setVisibleLength(content.length);
      if (onStreamComplete && visibleLength < content.length) {
        onStreamComplete();
      }
      return;
    }

    // In real streaming scenario, this would be driven by actual deltas from WebSocket
    // For now, we simulate gradual reveal
    const targetLength = content.length;
    if (visibleLength < targetLength) {
      const timer = setTimeout(() => {
        // Reveal text in chunks (simulate 30-50 chars per "delta")
        const chunkSize = Math.random() * 20 + 30;
        const newLength = Math.min(visibleLength + chunkSize, targetLength);
        setVisibleLength(newLength);
        setDisplayedContent(content.substring(0, newLength));
      }, 30); // ~30ms between deltas for smooth animation

      return () => clearTimeout(timer);
    } else if (isStreaming && visibleLength === targetLength) {
      // Streaming complete
      if (onStreamComplete) {
        onStreamComplete();
      }
    }
  }, [visibleLength, content, isStreaming, onStreamComplete]);

  // Auto-scroll container to bottom during streaming
  useEffect(() => {
    if (contentRef.current && isStreaming) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [displayedContent, isStreaming]);

  return (
    <div
      ref={contentRef}
      className={`
        text-sm text-amber-100/90 whitespace-pre-wrap break-words leading-relaxed
        font-mono transition-all duration-150
        ${isStreaming ? "opacity-100" : "opacity-95"}
      `}
    >
      {displayedContent}
      {isStreaming && (
        <span className="inline-block w-1.5 h-4 ml-1 bg-amber-300/60 rounded animate-pulse" />
      )}
    </div>
  );
}
