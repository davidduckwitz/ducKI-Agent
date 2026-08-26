import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppWindow, ArrowLeft, ArrowRight, Bug, ChevronRight, Circle, Clipboard, Download, Globe2, History, Loader2, PanelRightClose, Play, RefreshCw, RotateCw, TerminalSquare, Trash2 } from "lucide-react";
import { usePlugins, frontendPlugins } from "../../lib/usePlugins";
import { useAppStore } from "../../lib/store";
import { useUiStore, type AppSidebarTool } from "../../lib/uiStore";
import { SplitHandle } from "../ui/split-handle";
import { ErrorBoundary } from "../chat/ErrorBoundary";
import { useBrowserActivityStore, type BrowserActivity } from "../../lib/browserActivityStore";

function AppsList() {
  const navigate = useNavigate();
  const { data } = usePlugins();
  const setTool = useUiStore((s) => s.setAppSidebarTool);
  const tools = [
    { id: "browser" as const, name: "Browser", description: "Interner Browser mit gemeinsamer Agent-Session", icon: Globe2 },
    { id: "terminal" as const, name: "Terminal", description: "Shell und Prozesse im gemeinsamen Agent-Kontext", icon: TerminalSquare },
  ];
  return <div className="space-y-2 p-3">
    {tools.map(({ id, name, description, icon: Icon }) => <button key={id} onClick={() => setTool(id)} className="flex w-full items-center gap-3 rounded-lg border border-border bg-card/60 p-3 text-left transition hover:bg-accent">
      <Icon className="h-6 w-6 shrink-0 text-primary" /><span className="min-w-0"><span className="block text-sm font-medium">{name}</span><span className="block text-xs text-muted-foreground">{description}</span></span><ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
    </button>)}
    {frontendPlugins(data).map((plugin) => <button key={plugin.name} onClick={() => navigate(`/plugin/${encodeURIComponent(plugin.name)}`)} className="flex w-full items-center gap-3 rounded-lg border border-border bg-card/60 p-3 text-left transition hover:bg-accent">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center text-xl">{plugin.icon ?? "🧩"}</span><span className="min-w-0"><span className="block truncate text-sm font-medium">{plugin.name}</span><span className="block text-xs text-muted-foreground">{plugin.description || "Plugin-App öffnen"}</span></span><ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
    </button>)}
  </div>;
}

function BrowserTool() {
  const { socket, browserSessions, refreshBrowserSessions, controlBrowserSession } = useAppStore();
  const navigationRequest = useUiStore((s) => s.browserNavigationRequest);
  const [selected, setSelected] = useState("");
  const [url, setUrl] = useState("https://");
  const [frame, setFrame] = useState<{ data: string; format: string; width?: number; height?: number }>();
  const [busy, setBusy] = useState(false);
  const [showTimeline, setShowTimeline] = useState(true);
  const [showConsole, setShowConsole] = useState(false);
  const [consoleBusy, setConsoleBusy] = useState(false);
  const [consoleData, setConsoleData] = useState<{
    pageErrors: Array<{ type: string; text: string; url: string; timestamp: string }>;
    networkErrors: Array<{ url: string; method: string; error: string; timestamp: string }>;
  }>({ pageErrors: [], networkErrors: [] });
  const pointerStart = useRef<{ x: number; y: number }>();
  const handledNavigationNonce = useRef(0);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const activities = useBrowserActivityStore((s) => s.activities);
  const clearActivities = useBrowserActivityStore((s) => s.clearActivities);
  const recordingEnabled = useBrowserActivityStore((s) => s.recordingEnabled);
  const setRecordingEnabled = useBrowserActivityStore((s) => s.setRecordingEnabled);
  const sessionId = selected === "__new__" ? "" : selected || browserSessions[0]?.tabId || "";
  const timeline = activities.filter((item) => !sessionId || item.sessionId === sessionId);
  useEffect(() => { void refreshBrowserSessions(); }, [socket, refreshBrowserSessions]);
  useEffect(() => {
    if (!navigationRequest || navigationRequest.nonce === handledNavigationNonce.current) return;
    handledNavigationNonce.current = navigationRequest.nonce;
    let cancelled = false;
    void (async () => {
      setBusy(true);
      setUrl(navigationRequest.url);
      await refreshBrowserSessions();
      if (cancelled) return;
      const sessions = useAppStore.getState().browserSessions;
      const preferredId = selected && selected !== "__new__" ? selected : sessions[0]?.tabId ?? "";
      if (preferredId) {
        await controlBrowserSession(preferredId, "goto", { url: navigationRequest.url });
        if (!cancelled) setSelected(preferredId);
      } else {
        const result = await controlBrowserSession("default", "launch", { url: navigationRequest.url });
        const id = String((result.data as { sessionId?: string } | undefined)?.sessionId ?? "");
        if (!cancelled && id) setSelected(id);
      }
      await refreshBrowserSessions();
      if (!cancelled) setBusy(false);
    })().catch(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [navigationRequest, selected, refreshBrowserSessions, controlBrowserSession]);
  useEffect(() => {
    if (!socket || !sessionId) return;
    const onFrame = (next: { sessionId: string; data: string; format: string; width?: number; height?: number }) => { if (next.sessionId === sessionId) setFrame(next); };
    socket.on("browser:frame", onFrame); socket.emit("browser:stream:join", { sessionId }); void controlBrowserSession(sessionId, "set_default"); void controlBrowserSession(sessionId, "stream_start");
    return () => { socket.off("browser:frame", onFrame); socket.emit("browser:stream:leave", { sessionId }); void controlBrowserSession(sessionId, "stream_stop"); };
  }, [socket, sessionId, controlBrowserSession]);
  const go = async () => {
    const target = url.trim() || "about:blank"; setBusy(true);
    if (!sessionId) {
      const result = await controlBrowserSession("default", "launch", { url: target });
      const id = String((result.data as { sessionId?: string } | undefined)?.sessionId ?? ""); if (id) setSelected(id);
    } else await controlBrowserSession(sessionId, "goto", { url: target });
    await refreshBrowserSessions(); setBusy(false);
  };
  const current = browserSessions.find((s) => s.tabId === sessionId);
  useEffect(() => { if (current?.url) setUrl(current.url); }, [current?.url]);

  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const sourceAspect = (frame?.width ?? 1280) / (frame?.height ?? 720);
    const boxAspect = rect.width / rect.height;
    const shownWidth = boxAspect > sourceAspect ? rect.height * sourceAspect : rect.width;
    const shownHeight = boxAspect > sourceAspect ? rect.height : rect.width / sourceAspect;
    const left = rect.left + (rect.width - shownWidth) / 2;
    const top = rect.top + (rect.height - shownHeight) / 2;
    return { x: Math.max(0, Math.min(1, (event.clientX - left) / shownWidth)), y: Math.max(0, Math.min(1, (event.clientY - top) / shownHeight)) };
  };
  const browserAction = async (action: string, params: Record<string, unknown> = {}) => {
    if (!sessionId) return;
    const result = await controlBrowserSession(sessionId, action, params);
    if (["history_back", "history_forward", "reload"].includes(action)) await refreshBrowserSessions();
    return result;
  };
  // Pulls the same error buffer (console errors, page errors, failed requests) the coding
  // agent reads via its browser tool's get_page_errors action - same session, so what the
  // agent sees while testing and what this panel shows are identical.
  const fetchConsole = async () => {
    if (!sessionId) return;
    setConsoleBusy(true);
    const result = await browserAction("get_page_errors", {});
    const data = result?.data as typeof consoleData | undefined;
    if (data) setConsoleData({ pageErrors: data.pageErrors ?? [], networkErrors: data.networkErrors ?? [] });
    setConsoleBusy(false);
  };
  const toggleConsole = () => {
    const next = !showConsole;
    setShowConsole(next);
    if (next) void fetchConsole();
  };
  const consoleErrorCount = consoleData.pageErrors.length + consoleData.networkErrors.length;
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.focus(); pointerStart.current = point(event); event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStart.current; if (!start) return; const end = point(event); pointerStart.current = undefined;
    const moved = Math.hypot(end.x - start.x, end.y - start.y);
    void browserAction(moved < 0.008 ? "mouse_click" : "mouse_drag", moved < 0.008 ? { xRatio: end.x, yRatio: end.y, clickCount: event.detail > 1 ? 2 : 1 } : { xRatio: start.x, yRatio: start.y, endXRatio: end.x, endYRatio: end.y });
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!sessionId) return;
    const modifiers = [event.ctrlKey ? "Control" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", event.metaKey ? "Meta" : ""].filter(Boolean);
    if (modifiers.length || event.key.length > 1) {
      const keyAliases: Record<string, string> = { " ": "Space", Escape: "Escape", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight" };
      void browserAction("keyboard_press", { key: [...modifiers, keyAliases[event.key] ?? event.key].join("+") }); event.preventDefault();
    } else if (event.key.length === 1) {
      void browserAction("keyboard_type", { text: event.key }); event.preventDefault();
    }
  };
  const automationSteps = timeline.filter((item) => item.success && !["launch", "close"].includes(item.action)).map(({ action, params }) => ({ action, ...Object.fromEntries(Object.entries(params).filter(([key]) => !["sessionId", "actor", "action"].includes(key))) }));
  const exportAutomation = () => {
    const blob = new Blob([JSON.stringify({ name: `Browser automation ${new Date().toISOString()}`, sessionId, steps: automationSteps }, null, 2)], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `browser-automation-${Date.now()}.json`; link.click(); URL.revokeObjectURL(link.href);
  };
  const replay = async () => { setBusy(true); for (const step of automationSteps) { const { action, ...params } = step; await browserAction(String(action), params); } setBusy(false); };
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex gap-1 border-b border-border p-2"><button onClick={() => void browserAction("history_back")} disabled={!sessionId} className="rounded p-2 hover:bg-accent disabled:opacity-30" title="Zurück"><ArrowLeft className="h-4 w-4"/></button><button onClick={() => void browserAction("history_forward")} disabled={!sessionId} className="rounded p-2 hover:bg-accent disabled:opacity-30" title="Vor"><ArrowRight className="h-4 w-4"/></button><button onClick={() => void browserAction("reload")} disabled={!sessionId} className="rounded p-2 hover:bg-accent disabled:opacity-30" title="Neu laden"><RotateCw className="h-4 w-4"/></button><select value={selected || sessionId} onChange={(e) => { setSelected(e.target.value); setFrame(undefined); }} className="min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs"><option value="__new__">Neue Session</option>{browserSessions.map((s) => <option key={s.tabId} value={s.tabId}>{s.title || s.url || s.tabId}</option>)}</select><button onClick={() => void refreshBrowserSessions()} className="rounded p-2 hover:bg-accent" title="Sessions aktualisieren"><RefreshCw className="h-4 w-4" /></button></div>
    <form onSubmit={(e) => { e.preventDefault(); void go(); }} className="flex gap-2 border-b border-border p-2"><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="min-w-0 flex-1 rounded border border-border bg-background px-3 py-2 text-sm"/><button disabled={busy} className="rounded bg-primary px-3 text-primary-foreground disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Los"}</button></form>
    <div className="flex shrink-0 items-center gap-3 border-b border-cyan-500/20 bg-cyan-500/5 p-2"><span className="relative flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black/70">{frame ? <img src={`data:image/${frame.format};base64,${frame.data}`} alt="Das sieht dein Browser" className="h-full w-full object-cover"/> : <Globe2 className="h-5 w-5 text-cyan-300"/>}<span className="absolute right-1 top-1 h-2 w-2 animate-pulse rounded-full bg-cyan-400"/></span><span className="min-w-0"><span className="block text-xs font-semibold text-cyan-100">Das sieht dein Browser</span><span className="block truncate text-[10px] text-cyan-300/70">{current?.url || url || "Noch keine Seite"}</span><span className="block text-[10px] text-muted-foreground">Gemeinsame Session für dich und den Agenten</span></span></div>
    <div ref={surfaceRef} role="application" aria-label="Interaktiver Browser" tabIndex={0} onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} onWheel={(event) => { event.preventDefault(); void browserAction("scroll_by", { deltaX: event.deltaX, deltaY: event.deltaY }); }} onKeyDown={handleKeyDown} onPaste={(event) => { const text = event.clipboardData.getData("text"); if (text) { event.preventDefault(); void browserAction("keyboard_type", { text }); } }} className="relative flex min-h-0 flex-1 cursor-default touch-none items-center justify-center overflow-hidden bg-black/80 outline-none focus:ring-2 focus:ring-primary/60">{frame ? <img draggable={false} src={`data:image/${frame.format};base64,${frame.data}`} className="pointer-events-none h-full w-full select-none object-contain" alt="Live Browser" /> : <div className="px-6 text-center text-sm text-muted-foreground">{sessionId ? "Browser wird verbunden …" : "URL eingeben, um eine gemeinsame Browser-Session zu starten."}</div>}<span className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-[10px] text-white/70">Klicken, ziehen, scrollen und tippen</span></div>
    <div className="shrink-0 border-t border-border bg-card">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button onClick={() => setShowTimeline((value) => !value)} className="flex items-center gap-1.5 text-xs font-medium"><History className="h-3.5 w-3.5"/>Timeline <span className="rounded bg-muted px-1.5">{timeline.length}</span></button>
        <button
          onClick={() => setRecordingEnabled(!recordingEnabled)}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${recordingEnabled ? "text-red-500" : "text-muted-foreground"}`}
          title={recordingEnabled ? "Aufzeichnung läuft - klicken zum Pausieren" : "Aufzeichnung pausiert - klicken zum Fortsetzen"}
        >
          <Circle className={`h-2.5 w-2.5 ${recordingEnabled ? "fill-current" : ""}`}/>
          {recordingEnabled ? "Aufzeichnung an" : "Pausiert"}
        </button>
        <div className="ml-auto flex gap-1">
          <button onClick={() => void navigator.clipboard.writeText(JSON.stringify(automationSteps, null, 2))} className="rounded p-1.5 hover:bg-accent" title="Automation kopieren"><Clipboard className="h-3.5 w-3.5"/></button>
          <button onClick={exportAutomation} className="rounded p-1.5 hover:bg-accent" title="Automation exportieren"><Download className="h-3.5 w-3.5"/></button>
          <button onClick={() => void replay()} disabled={busy || automationSteps.length === 0} className="rounded p-1.5 hover:bg-accent disabled:opacity-30" title="Timeline wiederholen"><Play className="h-3.5 w-3.5"/></button>
          <button onClick={() => clearActivities(sessionId || undefined)} className="rounded p-1.5 hover:bg-accent" title="Timeline löschen"><Trash2 className="h-3.5 w-3.5"/></button>
        </div>
      </div>
      {showTimeline && <div className="max-h-36 overflow-auto border-t border-border px-2 py-1">{timeline.length === 0 ? <p className="py-2 text-center text-[11px] text-muted-foreground">Browseraktionen werden hier automatisch aufgezeichnet.</p> : timeline.slice().reverse().map((item: BrowserActivity) => <div key={item.id} className="flex items-start gap-2 border-b border-border/50 py-1 text-[10px]"><span className={`mt-0.5 rounded px-1 ${item.actor === "agent" ? "bg-violet-500/15 text-violet-400" : "bg-blue-500/15 text-blue-400"}`}>{item.actor === "agent" ? "Agent" : "Du"}</span><span className="min-w-0 flex-1 truncate" title={JSON.stringify(item.params)}>{item.action}</span><time className="text-muted-foreground">{new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>)}</div>}
      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
        <button onClick={toggleConsole} disabled={!sessionId} className="flex items-center gap-1.5 text-xs font-medium disabled:opacity-40">
          <Bug className="h-3.5 w-3.5"/>Konsole {consoleErrorCount > 0 && <span className="rounded bg-red-500/15 px-1.5 text-red-500">{consoleErrorCount}</span>}
        </button>
        <div className="ml-auto flex gap-1">
          <button onClick={() => void fetchConsole()} disabled={!sessionId || consoleBusy} className="rounded p-1.5 hover:bg-accent disabled:opacity-30" title="Konsole aktualisieren">{consoleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : <RefreshCw className="h-3.5 w-3.5"/>}</button>
        </div>
      </div>
      {showConsole && <div className="max-h-36 overflow-auto border-t border-border px-2 py-1 font-mono">
        {consoleErrorCount === 0 ? (
          <p className="py-2 text-center text-[11px] text-muted-foreground">Keine Konsolenfehler erfasst - der Agent liest denselben Puffer beim Testen.</p>
        ) : (
          <>
            {consoleData.pageErrors.map((err, i) => <div key={`page-${i}`} className="border-b border-border/50 py-1 text-[10px]"><div className="flex items-start gap-2"><span className="mt-0.5 shrink-0 rounded bg-red-500/15 px-1 text-red-500">{err.type}</span><span className="min-w-0 flex-1 break-words text-foreground">{err.text}</span></div><div className="mt-0.5 flex items-center gap-2 text-muted-foreground"><span className="truncate">{err.url}</span><time className="shrink-0">{new Date(err.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div></div>)}
            {consoleData.networkErrors.map((err, i) => <div key={`net-${i}`} className="border-b border-border/50 py-1 text-[10px]"><div className="flex items-start gap-2"><span className="mt-0.5 shrink-0 rounded bg-amber-500/15 px-1 text-amber-500">{err.method}</span><span className="min-w-0 flex-1 break-words text-foreground">{err.error}</span></div><div className="mt-0.5 flex items-center gap-2 text-muted-foreground"><span className="truncate">{err.url}</span><time className="shrink-0">{new Date(err.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div></div>)}
          </>
        )}
      </div>}
    </div>
  </div>;
}

function TerminalTool() {
  const socket = useAppStore((s) => s.socket);
  const [command, setCommand] = useState(""); const [lines, setLines] = useState(["Ducki Terminal — gemeinsame Shell-Umgebung"]); const [busy, setBusy] = useState(false); const bottomRef = useRef<HTMLDivElement>(null);
  // Some desktop/browser bridges return a Promise from scrollIntoView(). Returning that
  // Promise from an effect makes React treat it as the cleanup function and crash on the
  // StrictMode remount ("destroy is not a function"). An effect must return only void or a
  // cleanup callback, so keep the call inside a block.
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [lines]);
  const run = () => { const value = command.trim(); if (!value || !socket) return; setCommand(""); setBusy(true); setLines((old) => [...old, `❯ ${value}`]); socket.emit("shell:control", { command: value, timeout: 120000 }, (result: { success?: boolean; data?: unknown; error?: string }) => { const data = result.data as { output?: string; stdout?: string; stderr?: string } | string | undefined; const output = typeof data === "string" ? data : data?.output ?? data?.stdout ?? data?.stderr ?? result.error ?? ""; setLines((old) => [...old, output || (result.success ? "✓" : "Befehl fehlgeschlagen")]); setBusy(false); }); };
  return <div className="flex min-h-0 flex-1 flex-col bg-zinc-950 text-zinc-100"><div className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">{lines.map((line, i) => <div key={i}>{line}</div>)}{busy && <div className="text-emerald-400">läuft …</div>}<div ref={bottomRef}/></div><form onSubmit={(e) => { e.preventDefault(); run(); }} className="flex items-center border-t border-zinc-800 px-3 py-2 font-mono text-sm"><span className="mr-2 text-emerald-400">❯</span><input autoFocus value={command} onChange={(e) => setCommand(e.target.value)} disabled={busy} className="min-w-0 flex-1 bg-transparent outline-none" placeholder="Befehl eingeben…" /></form></div>;
}

export function AppToolSidebar() {
  const { appSidebarOpen, appSidebarWidth, appSidebarTool, setAppSidebarWidth, setAppSidebarTool, setAppSidebarOpen } = useUiStore();
  const tabs: Array<{ id: AppSidebarTool; label: string; icon: typeof AppWindow }> = [{ id: "apps", label: "Apps", icon: AppWindow }, { id: "browser", label: "Browser", icon: Globe2 }, { id: "terminal", label: "Terminal", icon: TerminalSquare }];
  if (!appSidebarOpen) return <button onClick={() => setAppSidebarOpen(true)} className="hidden w-10 shrink-0 items-center justify-center border-l border-border bg-card text-muted-foreground hover:text-foreground md:flex" title="Apps öffnen"><AppWindow className="h-5 w-5" /></button>;
  return <><SplitHandle value={appSidebarWidth} onChange={setAppSidebarWidth} direction="left" ariaLabel="Apps-Seitenleiste vergrößern"/><aside style={{ width: appSidebarWidth }} className="hidden min-h-0 shrink-0 flex-col border-l border-border bg-card md:flex"><div className="flex h-12 shrink-0 items-center border-b border-border px-1">{tabs.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setAppSidebarTool(id)} className={`flex h-full items-center gap-1.5 border-b-2 px-2 text-xs ${appSidebarTool === id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}><Icon className="h-4 w-4"/>{label}</button>)}<button onClick={() => setAppSidebarOpen(false)} className="ml-auto rounded p-2 text-muted-foreground hover:bg-accent" title="Einklappen"><PanelRightClose className="h-4 w-4"/></button></div><ErrorBoundary fallback={<div className="p-4 text-sm text-destructive">Dieses Tool konnte nicht geladen werden. Die übrige Oberfläche bleibt verfügbar.</div>}>{appSidebarTool === "apps" ? <div className="min-h-0 flex-1 overflow-auto"><AppsList/></div> : appSidebarTool === "browser" ? <BrowserTool/> : <TerminalTool/>}</ErrorBoundary></aside></>;
}
