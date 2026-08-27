import { useEffect, useState } from "react";
import { useAppStore } from "../../lib/store";
import { RefreshCw, ExternalLink, Copy, Trash2, Camera, Loader2 } from "lucide-react";

export function BrowserSessionManager() {
  const { browserSessions, refreshBrowserSessions, controlBrowserSession, socket } = useAppStore();
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busySession, setBusySession] = useState<string | null>(null);
  const [screenshots, setScreenshots] = useState<Record<string, string>>({});
  const [gotoInputs, setGotoInputs] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!socket) return;
    void handleRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  const handleRefresh = async () => {
    setLoading(true);
    await refreshBrowserSessions();
    setLoading(false);
  };

  const handleCopyUrl = (tabId: string, url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(tabId);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleScreenshot = async (tabId: string) => {
    setBusySession(tabId);
    setErrors((e) => ({ ...e, [tabId]: "" }));
    // fullPage:false - a full-page capture stitches the page together from multiple scroll
    // positions, which duplicates any fixed/sticky-positioned element (nav bars, banners)
    // once per stitched section. This panel just wants a quick viewport preview.
    const result = await controlBrowserSession(tabId, "screenshot", { fullPage: false });
    setBusySession(null);
    const data = result.data as { screenshot?: string } | undefined;
    if (result.success && data?.screenshot) {
      setScreenshots((s) => ({ ...s, [tabId]: `data:image/jpeg;base64,${data.screenshot}` }));
    } else {
      setErrors((e) => ({ ...e, [tabId]: result.error ?? "Screenshot failed" }));
    }
  };

  const handleGoto = async (tabId: string) => {
    const url = gotoInputs[tabId]?.trim();
    if (!url) return;
    setBusySession(tabId);
    setErrors((e) => ({ ...e, [tabId]: "" }));
    const result = await controlBrowserSession(tabId, "goto", { url });
    setBusySession(null);
    if (!result.success) {
      setErrors((e) => ({ ...e, [tabId]: result.error ?? "Navigation failed" }));
      return;
    }
    await handleRefresh();
  };

  const handleClose = async (tabId: string) => {
    setBusySession(tabId);
    const result = await controlBrowserSession(tabId, "close");
    setBusySession(null);
    if (!result.success) {
      setErrors((e) => ({ ...e, [tabId]: result.error ?? "Close failed" }));
      return;
    }
    setScreenshots((s) => {
      const next = { ...s };
      delete next[tabId];
      return next;
    });
    await handleRefresh();
  };

  return (
    <div className="space-y-2 bg-card/30 rounded-lg p-3 border border-blue-500/20">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-blue-300 flex items-center gap-2">
          🌐 Browser Sessions ({browserSessions.length})
        </h3>
        <button
          onClick={() => void handleRefresh()}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 transition"
          title="Refresh session list"
          disabled={loading}
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Refresh
        </button>
      </div>

      {browserSessions.length === 0 ? (
        <div className="text-xs text-muted-foreground py-2">
          No active browser sessions. Sessions launched by the agent (or via this panel) appear here.
        </div>
      ) : (
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {browserSessions.map((session) => (
            <div
              key={session.tabId}
              className="group rounded-md border border-blue-500/20 bg-blue-500/5 hover:bg-blue-500/10 transition"
            >
              {/* Session Header */}
              <button
                onClick={() => setExpandedSession(expandedSession === session.tabId ? null : session.tabId)}
                className="w-full p-2 flex items-center justify-between hover:bg-blue-500/5"
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="text-xs font-mono text-blue-300 truncate">{session.tabId}</span>
                  {session.isDefault && (
                    <span className="inline-flex px-2 py-0.5 rounded text-xs bg-green-500/20 text-green-300">
                      Shared
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground shrink-0">
                  {new Date(session.lastUsed).toLocaleTimeString()}
                </div>
              </button>

              {/* Session URL Preview */}
              <div className="px-2 py-1 flex items-center gap-1 bg-black/20 text-xs text-foreground/80 truncate">
                <span className="truncate">{session.url}</span>
              </div>

              {/* Expanded Details */}
              {expandedSession === session.tabId && (
                <div className="p-2 space-y-2 border-t border-blue-500/10 bg-black/20">
                  {screenshots[session.tabId] && (
                    <img
                      src={screenshots[session.tabId]}
                      alt="Session screenshot"
                      className="w-full rounded border border-blue-500/20"
                    />
                  )}

                  {errors[session.tabId] && (
                    <div className="text-xs text-red-300">{errors[session.tabId]}</div>
                  )}

                  <div className="flex gap-1">
                    <input
                      type="text"
                      placeholder="https://..."
                      value={gotoInputs[session.tabId] ?? ""}
                      onChange={(e) => setGotoInputs((prev) => ({ ...prev, [session.tabId]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleGoto(session.tabId);
                      }}
                      className="flex-1 min-w-0 rounded bg-black/30 border border-blue-500/20 px-2 py-1 text-xs text-foreground"
                    />
                    <button
                      onClick={() => void handleGoto(session.tabId)}
                      disabled={busySession === session.tabId}
                      className="px-2 py-1 text-xs rounded bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 transition disabled:opacity-50"
                    >
                      Go
                    </button>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex gap-1 pt-2 border-t border-blue-500/10">
                    <button
                      onClick={() => handleCopyUrl(session.tabId, session.url)}
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs rounded bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 transition"
                      title="Copy URL"
                    >
                      <Copy className="w-3 h-3" />
                      {copied === session.tabId ? "Copied!" : "Copy"}
                    </button>

                    <button
                      onClick={() => void handleScreenshot(session.tabId)}
                      disabled={busySession === session.tabId}
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs rounded bg-green-500/20 hover:bg-green-500/30 text-green-300 transition disabled:opacity-50"
                      title="Take screenshot"
                    >
                      {busySession === session.tabId ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Camera className="w-3 h-3" />
                      )}
                      Screenshot
                    </button>

                    <a
                      href={session.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs rounded bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 transition"
                      title="Open URL in a new tab"
                    >
                      <ExternalLink className="w-3 h-3" />
                      Open
                    </a>

                    <button
                      onClick={() => void handleClose(session.tabId)}
                      disabled={busySession === session.tabId}
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs rounded bg-red-500/20 hover:bg-red-500/30 text-red-300 transition disabled:opacity-50"
                      title="Close Session"
                    >
                      <Trash2 className="w-3 h-3" />
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-muted-foreground pt-2 border-t border-blue-500/10">
        💡 Agent can use these persistent sessions to continue research without reopening
      </div>
    </div>
  );
}

