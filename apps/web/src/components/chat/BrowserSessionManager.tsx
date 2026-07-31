import { useState } from "react";
import { useAppStore, type BrowserSession } from "../../lib/store";
import { X, RefreshCw, ExternalLink, Copy, Trash2 } from "lucide-react";

interface BrowserSessionManagerProps {
  onSessionSelect?: (session: BrowserSession) => void;
}

export function BrowserSessionManager({ onSessionSelect }: BrowserSessionManagerProps) {
  const { browserSessions, removeBrowserSession, updateBrowserSession } = useAppStore();
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopyUrl = (tabId: string, url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(tabId);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleRefreshSession = (tabId: string, url: string) => {
    updateBrowserSession(tabId, {
      lastUsed: new Date().toISOString(),
      isActive: true,
    });
  };

  if (browserSessions.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 bg-card/30 rounded-lg p-3 border border-blue-500/20">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-blue-300 flex items-center gap-2">
          🌐 Browser Sessions ({browserSessions.length})
        </h3>
      </div>

      <div className="space-y-1 max-h-48 overflow-y-auto">
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
                <span className="text-xs font-mono text-blue-300">Tab {session.tabId}</span>
                <span className={`inline-flex px-2 py-0.5 rounded text-xs ${
                  session.isActive
                    ? "bg-green-500/20 text-green-300"
                    : "bg-muted text-foreground/80"
                }`}>
                  {session.isActive ? "● Active" : "○ Inactive"}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
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
                {/* Cookies */}
                {session.cookies && session.cookies.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-blue-200 mb-1">Cookies ({session.cookies.length}):</div>
                    <div className="max-h-20 overflow-y-auto bg-black/30 rounded p-1 text-xs font-mono text-muted-foreground space-y-0.5">
                      {session.cookies.slice(0, 5).map((cookie, idx) => (
                        <div key={idx} className="truncate">{cookie}</div>
                      ))}
                      {session.cookies.length > 5 && (
                        <div className="text-muted-foreground">+{session.cookies.length - 5} more</div>
                      )}
                    </div>
                  </div>
                )}

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
                    onClick={() => handleRefreshSession(session.tabId, session.url)}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs rounded bg-green-500/20 hover:bg-green-500/30 text-green-300 transition"
                    title="Refresh/Reactivate"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Refresh
                  </button>

                  <button
                    onClick={() => onSessionSelect?.(session)}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs rounded bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 transition"
                    title="Control Session"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Control
                  </button>

                  <button
                    onClick={() => removeBrowserSession(session.tabId)}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs rounded bg-red-500/20 hover:bg-red-500/30 text-red-300 transition"
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

      {/* Info */}
      <div className="text-xs text-muted-foreground pt-2 border-t border-blue-500/10">
        💡 Agent can use these persistent sessions to continue research without reopening
      </div>
    </div>
  );
}
