import { X, Download, Square, Code2, Globe2 } from "lucide-react";
import { useAppStore } from "../../lib/store";
import { useUiStore } from "../../lib/uiStore";
import type { RenderedChatMessage } from "./chatTypes";

export interface BrowserPreviewData {
  tabId?: string;
  serverId?: string;
  url?: string;
  screenshot?: string;
  screenshotUrl?: string;
  screenshotStorageUrl?: string;
  screenshotSize?: number;
  /** Actual encoding of `screenshot`'s bytes (BROWSER_SCREENSHOT_FORMAT, default "jpeg").
   *  Must match the data: URI's declared MIME type below - a mismatch (e.g. real bytes are
   *  webp/png but the URI claims jpeg) makes the browser refuse to decode the image at all. */
  format?: "jpeg" | "png" | "webp";
  htmlContent?: string;
  isStreaming?: boolean;
}

function mimeTypeForFormat(format: BrowserPreviewData["format"]): string {
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  return "image/jpeg";
}

/** screenshotStorageUrl/screenshotUrl are always server-provided paths (e.g. "/storage/...")
 *  and screenshot is always raw base64 bytes - never mix these up by sniffing the string's
 *  leading characters. JPEG's raw bytes (FF D8 FF...) base64-encode to a string that itself
 *  starts with "/9j/", so a naive `.startsWith("/")` check misidentifies raw JPEG base64 as a
 *  storage path and serves it unprefixed, which the <img> then fails to decode. */
function resolveScreenshotSrc(data: BrowserPreviewData): string | undefined {
  const storagePath = data.screenshotStorageUrl || data.screenshotUrl;
  if (storagePath) return storagePath;
  if (data.screenshot) {
    return data.screenshot.startsWith("data:")
      ? data.screenshot
      : `data:${mimeTypeForFormat(data.format)};base64,${data.screenshot}`;
  }
  return undefined;
}

interface BrowserPreviewProps {
  msg: RenderedChatMessage;
}

export function BrowserPreview({ msg }: BrowserPreviewProps) {
  const data = msg.eventData as BrowserPreviewData | undefined;
  const openBrowser = useUiStore((s) => s.setAppSidebarTool);
  if (!data || (!data.screenshotStorageUrl && !data.screenshotUrl && !data.screenshot && !data.url)) return null;
  const screenshotSrc = resolveScreenshotSrc(data);
  return (
    <button onClick={() => openBrowser("browser")} className="group flex max-w-sm items-center gap-3 rounded-2xl border border-cyan-500/30 bg-cyan-500/5 p-2 text-left transition hover:bg-cyan-500/10" title="Gemeinsamen Browser öffnen">
      <span className="relative flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black/60">{screenshotSrc ? <img src={screenshotSrc} alt="Browser-Sicht" className="h-full w-full object-cover"/> : <Globe2 className="h-6 w-6 text-cyan-300"/>}<span className="absolute right-1 top-1 h-2 w-2 animate-pulse rounded-full bg-cyan-400"/></span>
      <span className="min-w-0"><span className="block text-sm font-medium text-cyan-100">Das sieht dein Browser</span><span className="block truncate text-xs text-cyan-300/70">{data.url || "Gemeinsame Live-Session"}</span><span className="mt-1 block text-[10px] text-muted-foreground group-hover:text-foreground">Klicken, um ihn gemeinsam zu steuern</span></span>
    </button>
  );
}

interface BrowserPreviewModalProps {
  data: BrowserPreviewData;
  onClose: () => void;
}

export function BrowserPreviewModal({ data, onClose }: BrowserPreviewModalProps) {
  const { controlBrowserSession } = useAppStore();

  const screenshotSrc = resolveScreenshotSrc(data);

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
    const href = resolveScreenshotSrc(data);
    if (!href) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `screenshot-${timestamp}.${data.format ?? "jpg"}`;
    const link = document.createElement("a");
    link.href = href;
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
