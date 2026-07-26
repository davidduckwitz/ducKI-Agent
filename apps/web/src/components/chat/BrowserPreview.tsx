import { useState, useRef } from "react";
import { X, Maximize2, Download, Square, Code2 } from "lucide-react";
import { useAppStore } from "../../lib/store";
import type { RenderedChatMessage } from "./chatTypes";

export interface BrowserPreviewData {
  tabId?: string;
  serverId?: string;
  url?: string;
  screenshot?: string;
  htmlContent?: string;
  isStreaming?: boolean;
}

interface BrowserPreviewProps {
  msg: RenderedChatMessage;
}

export function BrowserPreview({ msg }: BrowserPreviewProps) {
  const { setBrowserPreviewModal, socket } = useAppStore();
  const data = msg.eventData as BrowserPreviewData | undefined;
  const containerRef = useRef<HTMLDivElement>(null);

  if (!data || !data.screenshot) {
    return null;
  }

  const screenshotSrc = data.screenshot.startsWith("data:")
    ? data.screenshot
    : `data:image/webp;base64,${data.screenshot}`;

  const handleExportHtml = () => {
    if (!data.htmlContent) {
      alert("No HTML content available to export.");
      return;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `browser-export-${timestamp}.html`;
    const element = document.createElement("a");
    element.setAttribute(
      "href",
      `data:text/html;charset=utf-8,${encodeURIComponent(data.htmlContent)}`
    );
    element.setAttribute("download", filename);
    element.style.display = "none";
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const handleScreenshot = () => {
    if (!data.screenshot) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `screenshot-${timestamp}.webp`;
    const link = document.createElement("a");
    link.href = data.screenshot.startsWith("data:")
      ? data.screenshot
      : `data:image/webp;base64,${data.screenshot}`;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleStopProcess = () => {
    if (socket && data.serverId) {
      socket.emit("browser:stop", { serverId: data.serverId });
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
        <img
          src={screenshotSrc}
          alt="Browser preview"
          className="w-full h-full object-contain"
        />
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
  const { socket } = useAppStore();

  const screenshotSrc = data.screenshot?.startsWith("data:")
    ? data.screenshot
    : `data:image/webp;base64,${data.screenshot}`;

  const handleExportHtml = () => {
    if (!data.htmlContent) {
      alert("No HTML content available to export.");
      return;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `browser-export-${timestamp}.html`;
    const element = document.createElement("a");
    element.setAttribute(
      "href",
      `data:text/html;charset=utf-8,${encodeURIComponent(data.htmlContent)}`
    );
    element.setAttribute("download", filename);
    element.style.display = "none";
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const handleScreenshot = () => {
    if (!data.screenshot) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `screenshot-${timestamp}.webp`;
    const link = document.createElement("a");
    link.href = data.screenshot.startsWith("data:")
      ? data.screenshot
      : `data:image/webp;base64,${data.screenshot}`;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleStopProcess = () => {
    if (socket && data.serverId) {
      socket.emit("browser:stop", { serverId: data.serverId });
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="flex flex-col max-w-6xl max-h-screen w-full mx-4">
        {/* Modal Header */}
        <div className="flex items-center justify-between gap-2 bg-gray-900 px-4 py-3 border-b border-gray-800 rounded-t-lg">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-3 h-3 rounded-full bg-cyan-400 animate-pulse" />
            <span className="text-sm font-medium text-cyan-200">
              Browser {data.isStreaming ? "Live Stream" : "Preview"}
            </span>
            {data.url && (
              <span className="text-sm text-gray-400 truncate">{data.url}</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded hover:bg-gray-800 text-gray-400 transition"
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
            <div className="flex items-center justify-center h-full text-gray-500">
              No screenshot available
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-2 bg-gray-900 px-4 py-3 border-t border-gray-800 rounded-b-lg">
          <button
            onClick={handleScreenshot}
            className="flex items-center gap-2 px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-sm text-gray-200 transition"
          >
            <Download className="w-4 h-4" />
            Screenshot
          </button>
          <button
            onClick={handleExportHtml}
            className="flex items-center gap-2 px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-sm text-gray-200 transition"
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
