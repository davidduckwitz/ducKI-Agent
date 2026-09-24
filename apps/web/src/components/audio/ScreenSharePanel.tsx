import { useEffect, useRef, useState } from "react";
import { Monitor, MonitorOff, MousePointer2, ScanEye } from "lucide-react";
import { useAppStore } from "../../lib/store";
import { getScreenShareContext, setScreenShareContext } from "../../lib/screenShareContext";
import { onVoiceEndRequested } from "../../lib/voiceCaptureBus";

type Frame = { screenshot: string; format: "jpeg"; width: number; height: number; timestamp: string };
export function ScreenSharePanel() {
  const socket = useAppStore((s) => s.socket);
  const loading = useAppStore((s) => s.isLoading);
  const [mode, setMode] = useState<"display" | "desktop" | null>(null);
  const [control, setControl] = useState(false);
  const [available, setAvailable] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const modeRef = useRef(mode); modeRef.current = mode;
  const stop = () => {
    generation.current++;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    socket?.emit("screen:revoke");
    setScreenShareContext(null);
    modeRef.current = null;
    setMode(null); setControl(false); setPreview(null); setActivity(null); setPending(false);
  };
  const request = async (event: string, ...args: unknown[]) => {
    if (!socket?.connected) throw new Error("Keine Verbindung zum Agenten");
    const result = await socket.timeout(20000).emitWithAck(event, ...args);
    if (result?.error) throw new Error(result.error);
    return result;
  };
  const captureDisplay = (): Frame => {
    const video = videoRef.current;
    if (!stream.current || !video?.videoWidth || video.readyState < 2) throw new Error("Bildschirmbild noch nicht bereit");
    const canvas = document.createElement("canvas");
    let scale = Math.min(1, 1600 / video.videoWidth);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Bildschirmaufnahme nicht unterstützt");
    let screenshot = "";
    for (let attempt = 0; attempt < 6; attempt++) {
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      screenshot = canvas.toDataURL("image/jpeg", attempt ? 0.55 : 0.8).split(",")[1]!;
      if (screenshot.length <= 185000) break;
      scale *= 0.8;
    }
    if (screenshot.length > 185000) throw new Error("Bildschirmbild zu groß. Bitte ein einzelnes Fenster freigeben.");
    return { screenshot, format: "jpeg", width: canvas.width, height: canvas.height, timestamp: new Date().toISOString() };
  };
  const configure = async (next: "display" | "desktop", allowed = false) => {
    stop(); setError(null); setPending(true);
    const token = generation.current;
    try {
      if (next === "display") {
        if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Bildschirmfreigabe benötigt einen unterstützten Browser und HTTPS oder localhost");
        const media = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 8 }, audio: false });
        if (token !== generation.current) { media.getTracks().forEach((track) => track.stop()); return; }
        stream.current = media;
        media.getVideoTracks()[0]?.addEventListener("ended", stop, { once: true });
        if (videoRef.current) { videoRef.current.srcObject = media; await videoRef.current.play(); }
      }
      await request("screen:configure", { mode: next, control: allowed });
      if (token !== generation.current) { socket?.emit("screen:revoke"); return; }
      modeRef.current = next; setMode(next); setControl(allowed); setScreenShareContext(next, allowed);
      if (next === "desktop") {
        const result = await request("screen:snapshot");
        if (token === generation.current) setPreview(`data:image/jpeg;base64,${result.data.screenshot}`);
      }
    } catch (failure) {
      if (token === generation.current) { stop(); setError(failure instanceof Error ? failure.message : "Freigabe fehlgeschlagen"); }
    } finally { if (token === generation.current) setPending(false); }
  };
  useEffect(() => {
    if (!socket) return;
    let mounted = true;
    const capabilities = () => {
      void request("screen:capabilities").then((result) => { if (mounted) setAvailable(result.desktop === true); }).catch(() => { if (mounted) setAvailable(false); });
    };
    capabilities();
    socket.on("connect", capabilities);
    const frame = (reply: (frame: Frame | { error: string }) => void) => {
      try { reply(captureDisplay()); } catch (failure) { reply({ error: String(failure) }); }
    };
    const showPreview = (data: Frame) => { if (modeRef.current === "desktop") setPreview(`data:image/jpeg;base64,${data.screenshot}`); };
    const showActivity = (data: { action: string | null }) => setActivity(data.action);
    socket.on("screen:frame-request", frame); socket.on("screen:preview", showPreview);
    socket.on("screen:activity", showActivity); socket.on("disconnect", stop);
    const offEnd = onVoiceEndRequested(stop);
    const offConversation = useAppStore.subscribe((state, previous) => {
      // Creating the first conversation preserves the explicit grant; switching revokes it.
      if (previous.conversationId !== undefined && state.conversationId !== previous.conversationId) stop();
    });
    return () => {
      mounted = false; offEnd(); offConversation(); stop();
      socket.off("screen:frame-request", frame); socket.off("screen:preview", showPreview);
      socket.off("screen:activity", showActivity); socket.off("disconnect", stop);
      socket.off("connect", capabilities);
    };
  }, [socket]);
  const analyse = () => {
    void useAppStore.getState().sendMessage("Analysiere den aktuell freigegebenen Bildschirm und erkläre mir, was du siehst." + getScreenShareContext());
  };
  return (
    <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-white/[0.025] p-4 text-left">
      <div className="flex flex-wrap items-center gap-2">
        <Monitor className="h-4 w-4 text-cyan-300" />
        <span className="flex-1 text-sm font-medium text-slate-200">{mode ? control ? "Desktop · Steuerung aktiv" : "Bildschirm · Nur ansehen" : "Gemeinsam auf den Bildschirm schauen"}</span>
        {mode && <button type="button" onClick={stop} className="rounded-lg bg-red-500/15 px-3 py-2 text-xs text-red-300"><MonitorOff className="mr-1 inline h-3 w-3" />Freigabe beenden</button>}
      </div>
      <video ref={videoRef} muted autoPlay playsInline className={mode === "display" ? "mt-3 max-h-48 w-full rounded-lg bg-black object-contain" : "hidden"} />
      {preview && <img src={preview} alt="Freigegebener Windows-Desktop, zuletzt aufgenommenes Bild" className="mt-3 max-h-48 w-full rounded-lg object-contain" />}
      <div className="mt-3 flex flex-wrap gap-2">
        {!mode && <button type="button" disabled={pending} onClick={() => void configure("display")} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-slate-200 disabled:opacity-40">{pending ? "Wird verbunden …" : "Fenster / Bildschirm teilen"}</button>}
        {!mode && available && <button type="button" disabled={pending} onClick={() => void configure("desktop")} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-slate-200 disabled:opacity-40">Windows-Desktop verbinden</button>}
        {mode === "desktop" && <button type="button" disabled={pending} aria-pressed={control} onClick={() => void configure("desktop", !control)} className={`rounded-lg px-3 py-2 text-xs ${control ? "bg-amber-500/20 text-amber-200" : "bg-cyan-500/15 text-cyan-200"}`}><MousePointer2 className="mr-1 inline h-3 w-3" />{control ? "Steuerung entziehen" : "Maus und Tastatur erlauben"}</button>}
        {mode && <button type="button" disabled={loading || pending} onClick={analyse} className="rounded-lg bg-white/10 px-3 py-2 text-xs text-white disabled:opacity-40"><ScanEye className="mr-1 inline h-3 w-3" />Bildschirm analysieren</button>}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-500">{mode === "desktop" ? "Alle Monitore dieses Windows-PCs. Der Agent holt bei Bedarf aktuelle Bilder. Freigabe gilt für dieses Gespräch." : mode ? "Der Agent kann aktuelle Bilder des ausgewählten Fensters abrufen. Für Maus und Tastatur verbinde den Windows-Desktop." : "Teile ein Fenster zur Analyse oder verbinde diesen Windows-PC, um auch Browser und Apps bedienen zu lassen."}</p>
      {activity && <p role="status" className="mt-2 text-xs text-cyan-300">Agent greift auf den Bildschirm zu: {activity}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
    </div>
  );
}
