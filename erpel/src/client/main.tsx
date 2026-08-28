import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bot, ChevronLeft, ChevronRight, FileText, Image, Menu, Mic, Moon, Paperclip, Plus, Send, Settings, Sparkles, Speaker, Square, Sun, Trash2, Users, Video, VolumeX, X } from "lucide-react";
import "./styles.css";
import { AgentAvatar } from "./AgentAvatar";
import { MarkdownMessage } from "./MarkdownMessage";

const SpeakerX = VolumeX;

type Setup = { mode: "local" | "cloud"; localUrl: string; cloudUrl: string; apiKey: string };
type Message = { id: string; role: "user" | "assistant"; text: string; attachment?: { name: string; mimeType: string; preview?: string }; pending?: boolean; error?: boolean };
type Attachment = { name: string; mimeType: string; base64: string; preview?: string };
type BotInfo = { slug: string; name: string; description?: string; avatar?: string };

const api = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`/erpel-api${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `HTTP ${response.status}`);
  return body;
};

const examples = [
  { icon: Sparkles, title: "Tag planen", text: "Plane meinen heutigen Tag anhand meiner wichtigsten offenen Aufgaben." },
  { icon: FileText, title: "Dokument verstehen", text: "Fasse das angehängte Dokument zusammen und nenne die nächsten Schritte." },
  { icon: Users, title: "Team einsetzen", text: "Delegiere diese Aufgabe an den passendsten Spezialisten und fasse das Ergebnis zusammen." },
  { icon: Image, title: "Bild analysieren", text: "Analysiere das angehängte Bild und beschreibe auffällige Details." },
];

function Duck({ working = false }: { working?: boolean }) {
  return <span className={`duck ${working ? "working" : ""}`} aria-label={working ? "DucKI arbeitet" : "DucKI"}>
    <svg viewBox="0 0 64 64"><ellipse className="duck-shadow" cx="34" cy="55" rx="16" ry="3"/><g className="duck-flight"><path d="M14 40 Q6 38 8 46 Q12 47 17 43 Z" fill="#F2B705"/><ellipse cx="30" cy="42" rx="18" ry="14" fill="#FFCE31"/><g className="duck-wing"><path d="M27 33 Q40 30 39 44 Q31 45 25 40 Z" fill="#F2B705"/></g><circle cx="42" cy="24" r="11" fill="#FFCE31"/><path d="M50 22 L60 25 L50 29 Z" fill="#FF8A1E"/><circle cx="45" cy="21" r="2.2" fill="#22303C"/><g className="duck-feet"><path d="M24 55 L20 60 M24 55 L24 61 M24 55 L28 60"/><path d="M36 55 L32 60 M36 55 L36 61 M36 55 L40 60"/></g></g></svg>
  </span>;
}

function AttachmentPreview({ mimeType, preview, name }: { mimeType: string; preview?: string; name: string }) {
  if (mimeType.startsWith("image/")) return preview ? <img src={preview} alt={name}/> : <Image/>;
  if (mimeType.startsWith("video/")) return preview ? <video src={preview} controls preload="metadata"/> : <Video/>;
  return preview ? <a href={preview} download={name} onClick={e => e.stopPropagation()} title={`${name} herunterladen`}><FileText/></a> : <FileText/>;
}

function SetupWizard({ initial, onDone, onClose, dark, tts, onDark, onTts }: { initial?: Partial<Setup>; onDone: (s: Setup) => void; onClose?: () => void; dark?: boolean; tts?: boolean; onDark?: (value: boolean) => void; onTts?: (value: boolean) => void }) {
  const [form, setForm] = useState<Setup>({ mode: initial?.mode ?? "local", localUrl: initial?.localUrl ?? "http://127.0.0.1:3001", cloudUrl: initial?.cloudUrl ?? "", apiKey: "" });
  const [state, setState] = useState<"idle" | "testing" | "saving">("idle");
  const [notice, setNotice] = useState("");
  const update = (key: keyof Setup, value: string) => setForm(current => ({ ...current, [key]: value }));
  const test = async () => { setState("testing"); setNotice(""); try { await api("/setup/test", { method: "POST", body: JSON.stringify(form) }); setNotice("Verbindung erfolgreich."); } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); } finally { setState("idle"); } };
  const save = async () => { setState("saving"); setNotice(""); try { await api("/setup", { method: "POST", body: JSON.stringify(form) }); onDone(form); } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); setState("idle"); } };
  return <div className="modal-backdrop"><section className="wizard panel">
    {onClose && <button className="icon-btn modal-close" onClick={onClose}><X/></button>}
    <div className="wizard-mark"><Duck/></div><span className="eyebrow">Willkommen bei Erpel</span><h1>Wie möchtest du dich verbinden?</h1><p className="muted">Lokal direkt mit dem DucKI-Agent-Server oder unterwegs über deine Laravel Cloud.</p>
    <div className="mode-cards">
      <button className={form.mode === "local" ? "selected" : ""} onClick={() => setForm({ ...form, mode: "local" })}><span className="mode-icon">⌂</span><strong>Lokal</strong><small>Direkt zur Agent-API, ohne Laravel</small></button>
      <button className={form.mode === "cloud" ? "selected" : ""} onClick={() => setForm({ ...form, mode: "cloud" })}><span className="mode-icon">☁</span><strong>Cloud</strong><small>Laravel-URL und API-Key</small></button>
    </div>
    {form.mode === "local" ? <label>Lokale Agent-URL<input value={form.localUrl} onChange={e => update("localUrl", e.target.value)} placeholder="http://127.0.0.1:3001"/></label> : <><label>Laravel-Cloud-URL<input value={form.cloudUrl} onChange={e => update("cloudUrl", e.target.value)} placeholder="https://cloud.example.de"/></label><label>API-Key<input type="password" value={form.apiKey} onChange={e => update("apiKey", e.target.value)} placeholder={initial?.apiKey ? "Leer lassen, um den Key beizubehalten" : "Dein Agent-API-Key"}/></label></>}
    {onClose && <div className="settings-section"><span className="section-caption">Darstellung & Audio</span><label className="toggle-row"><span><strong>Dunkles Design</strong><small>Erpel mit dunkler Oberfläche anzeigen</small></span><input type="checkbox" checked={dark} onChange={e => onDark?.(e.target.checked)}/></label><label className="toggle-row"><span><strong>Antworten vorlesen</strong><small>Fertige Agentenantworten automatisch sprechen</small></span><input type="checkbox" checked={tts} onChange={e => onTts?.(e.target.checked)}/></label><div className="setting-info"><strong>Agent-Pet & Avatare</strong><small>Werden automatisch vom Main-Agenten und den angelegten Bots übernommen.</small></div></div>}
    {notice && <div className={notice.includes("erfolgreich") ? "notice success" : "notice error"}>{notice}</div>}
    <div className="wizard-actions"><button className="secondary" disabled={state !== "idle"} onClick={test}>{state === "testing" ? "Prüfe …" : "Verbindung testen"}</button><button className="primary" disabled={state !== "idle"} onClick={save}>{state === "saving" ? "Speichere …" : "Erpel starten"}</button></div>
  </section></div>;
}

function App() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<Partial<Setup>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [mode, setMode] = useState<"agent" | "team">("agent");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [working, setWorking] = useState(false);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [tts, setTts] = useState(() => localStorage.getItem("erpel.tts") === "true");
  const [dark, setDark] = useState(() => localStorage.getItem("erpel.theme") !== "light");
  const [models, setModels] = useState<any[]>([]);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState(localStorage.getItem("erpel.model") ?? "");
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [agentPetId, setAgentPetId] = useState<string | null>(null);
  const [botsLoading, setBotsLoading] = useState(false);
  const [selectedBotSlug, setSelectedBotSlug] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<number | undefined>();
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { api("/config").then(data => { setConfigured(data.configured); setSetup(data.config); }).catch(() => setConfigured(false)); }, []);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; localStorage.setItem("erpel.theme", dark ? "dark" : "light"); }, [dark]);
  useEffect(() => { localStorage.setItem("erpel.tts", String(tts)); }, [tts]);
  const storageKey = mode === "team" ? `erpel.messages.team.${selectedBotSlug ?? "_all"}` : "erpel.messages.agent";
  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    // Drop any leftover "pending" bubble: it belonged to a job whose poll loop died with the
    // last page load (reload, crash, closed tab) and would otherwise sit forever showing
    // "arbeitet …" with no active poll behind it — the "chat never finishes" symptom.
    const parsed: Message[] = saved ? JSON.parse(saved).filter((m: Message) => !m.pending) : [];
    setMessages(parsed);
    setConversationId(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  useEffect(() => { if (configured) localStorage.setItem(storageKey, JSON.stringify(messages.filter(m => !m.pending).slice(-100))); bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, storageKey, configured]);
  useEffect(() => { if (configured && bots.length === 0) void loadBots(); }, [configured]);
  useEffect(() => { if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js"); }, []);

  const loadModels = async () => { setModelsOpen(true); setModelsLoading(true); try { const data = await api("/models"); setModels(data.models ?? []); } catch (e) { setModels([{ id: "", name: e instanceof Error ? e.message : String(e), error: true }]); } finally { setModelsLoading(false); } };
  const loadBots = async () => { setBotsLoading(true); try { const data = await api("/bots"); setBots(data.bots ?? []); setAgentPetId(data.petId ?? null); } finally { setBotsLoading(false); } };

  const pollJob = async (id: string) => {
    while (true) { const job = await api(`/jobs/${id}`); if (job.status === "done") return job.result; if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error || "Auftrag gestoppt."); await new Promise(r => setTimeout(r, 1200)); }
  };

  const stopCurrentJob = async () => {
    if (!currentJobId) return;
    try { await api(`/jobs/${currentJobId}/stop`, { method: "POST" }); } catch (error) { console.warn("Stop failed", error); }
  };

  const completeResult = (result: any, userId: string) => {
    const text = result.reply ?? result.response ?? result.result?.response ?? "Auftrag abgeschlossen.";
    const nextConversation = result.conversationId ?? result.result?.conversationId;
    if (nextConversation) setConversationId(Number(nextConversation));
    setMessages(current => current.filter(m => m.id !== `${userId}-pending`).concat({ id: crypto.randomUUID(), role: "assistant", text }));
    if (tts && "speechSynthesis" in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); }
  };

  const send = async (text = draft) => {
    const clean = text.trim(); if ((!clean && !attachment) || working) return;
    const id = crypto.randomUUID(); const sentAttachment = attachment;
    setMessages(current => current.concat({ id, role: "user", text: clean || `Analysiere ${sentAttachment?.name}`, attachment: sentAttachment ? { name: sentAttachment.name, mimeType: sentAttachment.mimeType, preview: sentAttachment.preview } : undefined }, { id: `${id}-pending`, role: "assistant", text: mode === "team" ? "Das Team stimmt sich ab …" : "DucKI arbeitet …", pending: true }));
    setDraft(""); setAttachment(null); setWorking(true);
    try { const job = await api("/chat", { method: "POST", body: JSON.stringify({ message: clean || `Analysiere ${sentAttachment?.name}`, mode, model: selectedModel || undefined, conversationId, botSlug: mode === "team" ? selectedBotSlug ?? undefined : undefined, attachment: sentAttachment }) }); setCurrentJobId(job.id); completeResult(await pollJob(job.id), id); }
    catch (e) { setMessages(current => current.map(m => m.id === `${id}-pending` ? { ...m, pending: false, error: true, text: `Fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}` } : m)); }
    finally { setWorking(false); setCurrentJobId(null); }
  };

  const pickFile = async (file?: File) => {
    if (!file) return; const limit = file.type.startsWith("video/") ? 26_000_000 : 8_000_000;
    if (file.size > limit) { alert(`Datei zu groß. Maximum: ${Math.round(limit / 1_000_000)} MB.`); return; }
    const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
    setAttachment({ name: file.name, mimeType: file.type || "application/octet-stream", base64: dataUrl.split(",")[1] ?? "", preview: dataUrl });
  };

  const toggleRecording = async () => {
    if (recording) { recorderRef.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); const recorder = new MediaRecorder(stream); chunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data); };
      recorder.onstop = async () => { setRecording(false); stream.getTracks().forEach(t => t.stop()); const blob = new Blob(chunksRef.current, { type: recorder.mimeType }); const buffer = await blob.arrayBuffer(); const bytes = new Uint8Array(buffer); let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); const audio = btoa(binary); const id = crypto.randomUUID(); setMessages(current => current.concat({ id, role: "user", text: "🎙️ Sprachnachricht" }, { id: `${id}-pending`, role: "assistant", text: "Sprache wird verarbeitet …", pending: true })); setWorking(true); try { const job = await api("/transcribe", { method: "POST", body: JSON.stringify({ audio, mode, model: selectedModel || undefined, conversationId, botSlug: mode === "team" ? selectedBotSlug ?? undefined : undefined }) }); completeResult(await pollJob(job.id), id); } catch (e) { setMessages(current => current.map(m => m.id === `${id}-pending` ? { ...m, pending: false, error: true, text: `Fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}` } : m)); } finally { setWorking(false); } };
      recorderRef.current = recorder; recorder.start(); setRecording(true);
    } catch { alert("Mikrofonzugriff wurde nicht erlaubt."); }
  };

  const mainBot = bots.find(bot => bot.slug === "main") ?? bots[0];
  const activeBot = mode === "team" && selectedBotSlug ? bots.find(bot => bot.slug === selectedBotSlug) : undefined;
  const mainAvatar = mode === "team" && activeBot ? activeBot.avatar : agentPetId || mainBot?.avatar;
  const displayName = activeBot?.name ?? mainBot?.name ?? "DucKI";
  const clearChat = () => { if (messages.length && !window.confirm("Diesen Chat wirklich leeren?")) return; setMessages([]); setConversationId(undefined); };
  const groupedModels = useMemo(() => Object.entries(models.reduce((acc: Record<string, any[]>, model) => { (acc[model.provider ?? "Aktiver Provider"] ??= []).push(model); return acc; }, {})), [models]);
  if (configured === null) return <div className="splash"><Duck working/><span>Erpel startet …</span></div>;
  if (!configured) return <SetupWizard initial={setup} onDone={value => { setSetup(value); setConfigured(true); }}/ >;

  return <div className="app-shell">
    {mobileSidebar && <div className="sidebar-scrim" onClick={() => setMobileSidebar(false)}/>}<aside className={`sidebar ${sidebar ? "" : "collapsed"} ${mobileSidebar ? "mobile-open" : ""}`}>
      <div className="brand"><Duck working={working}/><div className="brand-copy"><strong>Erpel</strong><span>DucKI Voice</span></div><button className="icon-btn desktop-only" onClick={() => setSidebar(!sidebar)}>{sidebar ? <ChevronLeft/> : <ChevronRight/>}</button><button className="icon-btn mobile-only" onClick={() => setMobileSidebar(false)}><X/></button></div>
      <button className="new-chat" onClick={() => { setMessages([]); setConversationId(undefined); setMobileSidebar(false); }}><Plus/><span>Neuer Chat</span></button>
      <nav><button className={mode === "agent" ? "active" : ""} onClick={() => { setMode("agent"); setMobileSidebar(false); }}><Bot/><span>Agent-Chat</span></button><button className={mode === "team" ? "active" : ""} onClick={() => { setMode("team"); setMobileSidebar(false); }}><Users/><span>Team-Chat</span></button></nav>
      {mode === "team" && <section className="bot-overview"><div className="section-title"><span>Agenten & Bots</span><button onClick={loadBots}>↻</button></div>{botsLoading ? <small>Lade Team …</small> : <>
        <button className={`bot-row bot-row-btn ${!selectedBotSlug ? "selected" : ""}`} onClick={() => setSelectedBotSlug(null)}><AgentAvatar avatar={mainBot?.avatar} name="Team" size={30}/><div><strong>Alle (Team)</strong><small>Aufgabe ans ganze Team delegieren</small></div></button>
        {bots.map(bot => <button className={`bot-row bot-row-btn ${selectedBotSlug === bot.slug ? "selected" : ""}`} key={bot.slug} onClick={() => setSelectedBotSlug(bot.slug)}><AgentAvatar avatar={bot.avatar} name={bot.name} size={30}/><div><strong>{bot.name}</strong><small>{bot.description || bot.slug}</small></div></button>)}
      </>}</section>}
      <div className="sidebar-spacer"/><div className="sidebar-footer"><button onClick={() => setDark(!dark)}>{dark ? <Sun/> : <Moon/>}<span>{dark ? "Helles Design" : "Dunkles Design"}</span></button><button onClick={() => setSettingsOpen(true)}><Settings/><span>Einstellungen</span></button><div className="connection"><i/><span>{setup.mode === "cloud" ? "Laravel Cloud" : "Lokaler Agent"}</span></div></div>
    </aside>
    <main className="chat-main"><header><button className="icon-btn mobile-only" onClick={() => setMobileSidebar(true)}><Menu/></button><div className="header-title"><AgentAvatar avatar={mainAvatar} name={displayName} working={working} size={30}/><div><strong>{mode === "team" ? (activeBot ? activeBot.name : "Team-Chat") : "Voice-Chat"}</strong><small>{working ? "Agent arbeitet …" : setup.mode === "cloud" ? "Über Laravel verbunden" : "Direkt lokal verbunden"}</small></div></div><div className="header-actions"><button className="icon-btn" title="Chat leeren" onClick={clearChat} disabled={!messages.length}><Trash2/></button><button className="icon-btn" title="Antworten vorlesen" onClick={() => setTts(!tts)}>{tts ? <Speaker/> : <SpeakerX/>}</button><button className="model-pill" onClick={loadModels}>{selectedModel || "Agent-Modell"}</button></div></header>
      {working && <div className="work-bar"><span/></div>}
      <section className="messages">{messages.length === 0 ? <div className="empty-state"><div className="hero-duck"><AgentAvatar avatar={mainAvatar} name={displayName} size={52}/></div><span className="eyebrow">Bereit, wenn du es bist</span><h1>Was können wir heute erledigen?</h1><p>Schreibe, sprich oder hänge eine Datei an. Erpel verbindet dich mit deinem {mode === "team" ? "Agenten-Team" : "DucKI-Agenten"}.</p><div className="example-grid">{examples.map(item => <button key={item.title} onClick={() => { setDraft(item.text); void send(item.text); }}><item.icon/><strong>{item.title}</strong><span>{item.text}</span></button>)}</div></div> : messages.map(message => <article key={message.id} className={`message ${message.role} ${message.pending ? "pending" : ""} ${message.error ? "error" : ""}`}><div className="avatar">{message.role === "assistant" ? <AgentAvatar avatar={mainAvatar} name={displayName} working={message.pending} size={30}/> : "DU"}</div><div className="bubble">{message.attachment && <div className="attachment-card"><AttachmentPreview mimeType={message.attachment.mimeType} preview={message.attachment.preview} name={message.attachment.name}/><span>{message.attachment.name}</span></div>}{message.role === "assistant" && !message.pending ? <MarkdownMessage content={message.text}/> : <p>{message.text}</p>}{message.pending && <div className="typing"><i/><i/><i/></div>}</div></article>)}<div ref={bottomRef}/></section>
      <section className="composer-wrap">{attachment && <div className="pending-file"><AttachmentPreview mimeType={attachment.mimeType} preview={attachment.preview} name={attachment.name}/><div><strong>{attachment.name}</strong><small>Wird mit der Nachricht analysiert</small></div><button className="icon-btn" onClick={() => setAttachment(null)}><X/></button></div>}<div className={`composer ${recording ? "recording" : ""}`}><button className="icon-btn attach" onClick={() => fileRef.current?.click()} title="Datei anhängen"><Paperclip/></button><input ref={fileRef} type="file" hidden accept="image/*,video/*,.pdf,.txt,.md,.doc,.docx,.csv,.json,.js,.ts,.tsx,.php,.py" onChange={e => { void pickFile(e.target.files?.[0]); e.target.value = ""; }}/><textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder={recording ? "Aufnahme läuft …" : mode === "team" ? "Aufgabe an das Team …" : "Nachricht an DucKI …"} rows={1}/><button className={`voice-btn ${recording ? "active" : ""}`} onClick={toggleRecording} disabled={working && !recording}><span className="mic-ripple"/><Mic/></button>{working ? <button className="stop-btn" onClick={() => void stopCurrentJob()} disabled={!currentJobId} title="Laufenden Chat stoppen"><Square/></button> : <button className="send-btn" onClick={() => void send()} disabled={!draft.trim() && !attachment}><Send/></button>}</div><div className="composer-hint"><span>{recording ? "Aufnahme aktiv · Tippe zum Senden" : working ? "Der Agent arbeitet · mit Stopp abbrechen" : "Enter zum Senden · Shift+Enter für neue Zeile"}</span><span>{mode === "team" ? (activeBot ? `Direkt an ${activeBot.name}` : `${bots.length || "–"} Bots im Team`) : selectedModel || "Agent-Standardmodell"}</span></div></section>
    </main>
    {settingsOpen && <SetupWizard initial={setup} dark={dark} tts={tts} onDark={setDark} onTts={setTts} onClose={() => setSettingsOpen(false)} onDone={value => { setSetup(value); setSettingsOpen(false); setMessages([]); }}/ >}
    {modelsOpen && <div className="modal-backdrop" onClick={() => setModelsOpen(false)}><section className="model-modal panel" onClick={e => e.stopPropagation()}><button className="icon-btn modal-close" onClick={() => setModelsOpen(false)}><X/></button><span className="eyebrow">Modell für Erpel</span><h2>Modell auswählen</h2><p className="muted">Die Auswahl gilt nur für Agent-Chats in Erpel.</p>{modelsLoading ? <div className="model-loading"><div><span/></div><p>Modelle werden im Hintergrund geladen …</p><small>Du kannst dieses Fenster jederzeit schließen.</small></div> : <div className="model-list"><button className={!selectedModel ? "selected" : ""} onClick={() => { setSelectedModel(""); localStorage.removeItem("erpel.model"); setModelsOpen(false); }}><strong>Agent-Standardmodell</strong><small>Globale DucKI-Einstellung verwenden</small></button>{groupedModels.map(([provider, list]) => <div className="model-group" key={provider}><span>{provider}</span>{list.map(model => <button disabled={model.error} className={selectedModel === model.id ? "selected" : ""} key={`${provider}-${model.id || model.name}`} onClick={() => { setSelectedModel(model.id); localStorage.setItem("erpel.model", model.id); setModelsOpen(false); }}><strong>{model.name || model.id}</strong><small>{model.id}</small></button>)}</div>)}</div>}</section></div>}
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
