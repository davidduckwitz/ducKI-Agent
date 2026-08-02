import { useState, useRef } from "react";
import { X, Maximize2, Download, Square, Code2 } from "lucide-react";
import { useAppStore } from "../../lib/store";
import type { RenderedChatMessage } from "./chatTypes";

export interface BrowserPreviewData {
  tabId?: string;
  serverId?: string;
  url?: string;
  screenshot?: string;
  screenshotUrl?: string;
  screenshotStorageUrl?: string;
  screenshotSize?: number;
  htmlContent?: string;
  isStreaming?: boolean;
}

interface BrowserPreviewProps {
  msg: RenderedChatMessage;
}

export function BrowserPreview({ msg }: BrowserPreviewProps) {
  const { setBrowserPreviewModal, controlBrowserSession } = useAppStore();
  const data = msg.eventData as BrowserPreviewData | undefined;
  const containerRef = useRef<HTMLDivElement>(null);

  if (!data) {
    console.warn("[BrowserPreview] No eventData found");
    return null;
  }

  // Debug: Log available data
  const dataKeys = Object.keys(data);
  console.debug("[BrowserPreview] Available data keys:", dataKeys);
  console.debug("[BrowserPreview] Data:", {
    url: data.url,
    screenshotStorageUrl: data.screenshotStorageUrl,
    screenshotUrl: data.screenshotUrl,
    screenshot: data.screenshot ? `${(data.screenshot as string).substring(0, 50)}...` : undefined,
  });

  // Prefer storage URL for large screenshots, fall back to Base64, then fallback to just showing URL
  const screenshotSource = data.screenshotStorageUrl || data.screenshotUrl || data.screenshot;
  if (!screenshotSource && !data.url) {
    console.warn("[BrowserPreview] No screenshot or URL found in data", data);
    return null;
  }

  const screenshotSrc = screenshotSource
    ? screenshotSource.startsWith("data:")
      ? screenshotSource
      : screenshotSource.startsWith("/")
        ? screenshotSource // Storage URL path
        : `data:image/jpeg;base64,${screenshotSource}`
    : undefined;

  const handleExportHtml = async () => {
    let html = data.htmlContent;
    if (!html) {
      if (!data.tabId) {
        alert("No HTML content available to export.");
        return;
      }
      const result = await controlBrowserSession(data.tabId, "get_content");
      const resultData = result.data as { html?: string } | undefined;
      if (!result.success || !resultData?.html) {
        alert(result.error ?? "Failed to fetch page content.");
        return;
      }
      html = resultData.html;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `browser-export-${timestamp}.html`;
    const element = document.createElement("a");
    element.setAttribute(
      "href",
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    );
    element.setAttribute("download", filename);
    element.style.display = "none";
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const handleScreenshot = () => {
    const source = data.screenshotStorageUrl || data.screenshotUrl || data.screenshot;
    if (!source) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `screenshot-${timestamp}.png`;
    const link = document.createElement("a");

    if (source.startsWith("/")) {
      // Storage URL - direct link
      link.href = source;
    } else if (source.startsWith("data:")) {
      link.href = source;
    } else {
      link.href = `data:image/jpeg;base64,${source}`;
    }

    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleStopProcess = async () => {
    if (!data.tabId) return;
    const result = await controlBrowserSession(data.tabId, "close");
    if (!result.success) {
      console.warn("[BrowserPreview] Failed to close session", result.error);
    }
  };

  return (
    <div
      ref={containerRef}
      className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 bg-cyan-500/10 px-3 py-2 border-b border-cyan-500/20">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
          <span className="text-xs font-medium text-cyan-200">
            Browser {data.isStreaming ? "Live" : "Preview"}
          </span>
          {data.url && (
            <span className="text-xs text-cyan-300/70 truncate">{data.url}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleScreenshot}
            className="p-1.5 rounded hover:bg-cyan-500/20 text-cyan-300 transition"
            title="Screenshot"
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={handleExportHtml}
            className="p-1.5 rounded hover:bg-cyan-500/20 text-cyan-300 transition"
            title="Export HTML"
          >
            <Code2 className="w-4 h-4" />
          </button>
          <button
            onClick={handleStopProcess}
            className="p-1.5 rounded hover:bg-red-500/20 text-red-300 transition"
            title="Stop"
          >
            <Square className="w-4 h-4" />
          </button>
          <button
            onClick={() => setBrowserPreviewModal(true, data)}
            className="p-1.5 rounded hover:bg-cyan-500/20 text-cyan-300 transition"
            title="Fullscreen"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Preview */}
      <div className="relative bg-black/40 aspect-video overflow-hidden">
        {screenshotSrc ? (
          <img
            src={screenshotSrc}
            alt="Browser preview"
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <div className="text-sm mb-2">Browser: {data.url || "Loading..."}</div>
              <div className="text-xs text-muted-foreground/70">Screenshot wird geladen...</div>
            </div>
          </div>
        )}
        {data.isStreaming && (
          <div className="absolute inset-0 pointer-events-none border-2 border-cyan-400/50 animate-pulse" />
        )}
      </div>
    </div>
  );
}

interface BrowserPreviewModalProps {
  data: BrowserPreviewData;
  onClose: () => void;
}

export function BrowserPreviewModal({ data, onClose }: BrowserPreviewModalProps) {
  const { controlBrowserSession } = useAppStore();

  const screenshotSource = data.screenshotStorageUrl || data.screenshotUrl || data.screenshot;
  const screenshotSrc = screenshotSource
    ? screenshotSource.startsWith("data:")
      ? screenshotSource
      : screenshotSource.startsWith("/")
        ? screenshotSource
        : `data:image/jpeg;base64,${screenshotSource}`
    : undefined;

  const handleExportHtml = async () => {
    let html = data.htmlContent;
    if (!html) {
      if (!data.tabId) {
        alert("No HTML content available to export.");
        return;
      }
      const result = await controlBrowserSession(data.tabId, "get_content");
      const resultData = result.data as { html?: string } | undefined;
      if (!result.success || !resultData?.html) {
        alert(result.error ?? "Failed to fetch page content.");
        return;
      }
      html = resultData.html;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `browser-export-${timestamp}.html`;
    const element = document.createElement("a");
    element.setAttribute(
      "href",
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    );
    element.setAttribute("download", filename);
    element.style.display = "none";
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const handleScreenshot = () => {
    const source = data.screenshotStorageUrl || data.screenshotUrl || data.screenshot;
    if (!source) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `screenshot-${timestamp}.png`;
    const link = document.createElement("a");

    if (source.startsWith("/")) {
      // Storage URL - direct link
      link.href = source;
    } else if (source.startsWith("data:")) {
      link.href = source;
    } else {
      link.href = `data:image/jpeg;base64,${source}`;
    }

    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleStopProcess = async () => {
    if (data.tabId) {
      const result = await controlBrowserSession(data.tabId, "close");
      if (!result.success) {
        console.warn("[BrowserPreviewModal] Failed to close session", result.error);
      }
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="flex flex-col max-w-6xl max-h-screen w-full mx-4">
        {/* Modal Header */}
        <div className="flex items-center justify-between gap-2 bg-card px-4 py-3 border-b border-border rounded-t-lg">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-3 h-3 rounded-full bg-cyan-400 animate-pulse" />
            <span className="text-sm font-medium text-cyan-200">
              Browser {data.isStreaming ? "Live Stream" : "Preview"}
            </span>
            {data.url && (
              <span className="text-sm text-muted-foreground truncate">{data.url}</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded hover:bg-accent text-muted-foreground transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="flex-1 min-h-0 bg-black/60 overflow-auto">
          {screenshotSrc ? (
            <img
              src={screenshotSrc}
              alt="Browser preview fullscreen"
              className="w-full h-full object-contain"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              No screenshot available
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-2 bg-card px-4 py-3 border-t border-border rounded-b-lg">
          <button
            onClick={handleScreenshot}
            className="flex items-center gap-2 px-3 py-1.5 rounded bg-muted hover:bg-accent text-sm text-foreground transition"
          >
            <Download className="w-4 h-4" />
            Screenshot
          </button>
          <button
            onClick={handleExportHtml}
            className="flex items-center gap-2 px-3 py-1.5 rounded bg-muted hover:bg-accent text-sm text-foreground transition"
          >
            <Code2 className="w-4 h-4" />
            Export HTML
          </button>
          <button
            onClick={handleStopProcess}
            className="flex items-center gap-2 px-3 py-1.5 rounded bg-red-900/30 hover:bg-red-900/50 text-sm text-red-300 transition"
          >
            <Square className="w-4 h-4" />
            Stop
          </button>
          <button
            onClick={onClose}
            className="flex items-center gap-2 px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-700 text-sm text-white transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
