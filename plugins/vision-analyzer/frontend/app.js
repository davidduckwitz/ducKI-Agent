const $ = (id) => document.getElementById(id);
let currentSession = "";
let frameCount = 0;
let qrBusy = false;
let lastQr = "";
let latestQrValues = [];
let previousMotion = null;
let latestMotion = { score: 0, active: false };
let lastObservationReport = 0;
const pending = new Map();

const qrDetector = "BarcodeDetector" in window
  ? new BarcodeDetector({ formats: ["qr_code"] })
  : null;

function request(type, extra = {}) {
  const requestId = crypto.randomUUID();
  parent.postMessage({ type, requestId, ...extra }, location.origin);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Bridge timeout")); }, 8000);
    pending.set(requestId, { resolve, reject, timer });
  });
}

async function invoke(input) {
  const response = await fetch("/api/plugins/vision-analyzer/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "vision_analyzer", input })
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json?.error?.message || json?.error || "Plugin call failed");
  return json?.data?.result ?? json?.data;
}

function renderList(id, items, formatter) {
  const el = $(id); el.innerHTML = "";
  if (!Array.isArray(items) || !items.length) { el.textContent = "–"; return; }
  for (const item of items) {
    const div = document.createElement("div");
    div.className = "item";
    div.textContent = formatter(item);
    el.appendChild(div);
  }
}

function renderAnalysis(state) {
  const a = state?.analysis || {};
  $("scene").textContent = a.scene?.label
    ? `${a.scene.label}${a.scene.confidence ? ` · ${Math.round(a.scene.confidence * 100)}%` : ""}`
    : "–";
  renderList("objects", [...(a.people || []).map((x) => ({ ...x, type: "person" })), ...(a.objects || [])], (x) => `${x.type || "object"}${x.confidence ? ` · ${Math.round(x.confidence * 100)}%` : ""}`);
  renderList("text", a.text, (x) => x.text || "");
  renderList("qr", state?.qrCodes || a.qrCodes, (x) => x.value || x.rawValue || "QR");
  $("description").textContent = a.description || a.raw || "–";
  if (state?.motion) renderMotion(state.motion);
}

function renderMotion(motion) {
  const score = Math.max(0, Math.min(1, Number(motion?.score ?? 0) || 0));
  latestMotion = { score, active: motion?.active === true };
  $("motionText").textContent = `${latestMotion.active ? "Bewegung" : "ruhig"} · ${(score * 100).toFixed(1)}%`;
  $("motionFill").style.width = `${Math.min(100, score * 500)}%`;
}

function renderDependencies(status) {
  const root = $("deps");
  root.innerHTML = "";

  const core = document.createElement("div");
  core.className = "dep";
  core.innerHTML = `<div class="dep-row"><span class="dep-name">Core Local</span><span class="dep-status ok">✓ bereit</span></div><p>Browser-Stream, QR-Code und Bewegungserkennung. Keine Installation, kein LLM.</p>`;
  root.appendChild(core);

  for (const pack of status?.packs || []) {
    const card = document.createElement("div");
    card.className = "dep";
    const row = document.createElement("div"); row.className = "dep-row";
    const name = document.createElement("span"); name.className = "dep-name"; name.textContent = pack.label;
    const state = document.createElement("span"); state.className = `dep-status${pack.installed ? " ok" : ""}`; state.textContent = pack.installed ? "✓ installiert" : "nicht installiert";
    row.append(name, state);
    const desc = document.createElement("p"); desc.textContent = pack.description || "";
    const button = document.createElement("button"); button.textContent = pack.installed ? "Entfernen" : "Installieren";
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = pack.installed ? "Entferne …" : "Installiere …";
      $("error").textContent = "";
      try {
        const result = await invoke({ action: pack.installed ? "dependency_remove" : "dependency_install", pack: pack.id });
        renderDependencies(result.status || await invoke({ action: "dependency_status" }));
      } catch (e) {
        $("error").textContent = e.message;
        button.disabled = false;
        button.textContent = pack.installed ? "Entfernen" : "Installieren";
      }
    });
    card.append(row, desc, button);
    root.appendChild(card);
  }
}

async function loadDependencies() {
  try { renderDependencies(await invoke({ action: "dependency_status" })); }
  catch (e) { $("error").textContent = e.message; }
}

async function loadSessions() {
  try {
    const rows = await request("ducki:browser:list-sessions");
    const select = $("sessions"); select.innerHTML = '<option value="">Session auswählen …</option>';
    for (const row of rows || []) {
      const opt = document.createElement("option");
      opt.value = row.tabId || row.sessionId;
      opt.textContent = row.title || row.url || opt.value;
      select.appendChild(opt);
    }
  } catch (e) { $("error").textContent = e.message; }
}

async function subscribe(sessionId) {
  if (currentSession && currentSession !== sessionId) {
    await request("ducki:browser:unsubscribe", { sessionId: currentSession }).catch(() => {});
    await invoke({ action: "stop", sessionId: currentSession }).catch(() => {});
  }
  if (!sessionId) return;
  try {
    await request("ducki:browser:subscribe", { sessionId });
    currentSession = sessionId;
    frameCount = 0;
    previousMotion = null;
    latestMotion = { score: 0, active: false };
    $("live").className = "live on";
    $("live").textContent = "● LIVE";
    await invoke({ action: "start", sessionId }).catch(() => {});
  } catch (e) { $("error").textContent = e.message; }
}

async function reportLocalObservation(force = false) {
  if (!currentSession) return;
  const now = Date.now();
  if (!force && now - lastObservationReport < 1000) return;
  lastObservationReport = now;
  await invoke({
    action: "report_observation",
    sessionId: currentSession,
    qrCodes: latestQrValues,
    motion: latestMotion,
  }).catch(() => {});
}

async function detectQr(img) {
  if (qrBusy || !qrDetector || !currentSession) return;
  qrBusy = true;
  try {
    const found = await qrDetector.detect(img);
    const values = found.map((x) => ({
      value: x.rawValue,
      bbox: x.boundingBox ? [x.boundingBox.x, x.boundingBox.y, x.boundingBox.width, x.boundingBox.height] : undefined
    }));
    const signature = JSON.stringify(values.map((x) => x.value));
    if (signature !== lastQr) {
      lastQr = signature;
      latestQrValues = values;
      renderList("qr", values, (x) => x.value);
      await reportLocalObservation(true);
    }
  } catch {} finally { qrBusy = false; }
}

function detectMotion(img) {
  if (!currentSession || frameCount % 3 !== 0) return;
  const canvas = $("motionCanvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  if (!previousMotion) {
    previousMotion = new Uint8ClampedArray(pixels);
    return;
  }
  let changed = 0;
  const count = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    const diff = Math.abs(pixels[i] - previousMotion[i]) + Math.abs(pixels[i + 1] - previousMotion[i + 1]) + Math.abs(pixels[i + 2] - previousMotion[i + 2]);
    if (diff > 75) changed++;
  }
  previousMotion.set(pixels);
  const score = changed / count;
  renderMotion({ score, active: score > 0.02 });
  void reportLocalObservation(false);
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  const msg = event.data || {};
  if (msg.type === "ducki:browser:response" && pending.has(msg.requestId)) {
    const p = pending.get(msg.requestId);
    clearTimeout(p.timer);
    pending.delete(msg.requestId);
    msg.ok ? p.resolve(msg.payload) : p.reject(new Error(msg.error || "Bridge error"));
    return;
  }
  if (msg.type === "ducki:browser:frame" && msg.payload?.sessionId === currentSession) {
    const frame = $("frame");
    frame.hidden = false;
    frame.src = `data:image/${msg.payload.format === "png" ? "png" : "jpeg"};base64,${msg.payload.data}`;
    frameCount++;
    $("fps").textContent = `Frames: ${frameCount}`;
    $("last").textContent = new Date(msg.payload.timestamp || Date.now()).toLocaleTimeString();
    frame.onload = () => {
      void detectQr(frame);
      detectMotion(frame);
    };
  }
});

$("sessions").addEventListener("change", (e) => { void subscribe(e.target.value); });
$("refresh").addEventListener("click", () => { void loadSessions(); void loadDependencies(); });
$("localScan").addEventListener("click", async () => {
  if (!currentSession) return;
  $("error").textContent = "";
  $("localScan").disabled = true;
  $("localScan").textContent = "Lokal analysiere …";
  try { renderAnalysis(await invoke({ action: "local_scan", sessionId: currentSession })); }
  catch (e) { $("error").textContent = e.message; }
  finally { $("localScan").disabled = false; $("localScan").textContent = "Lokal analysieren"; }
});
$("smartScan").addEventListener("click", async () => {
  if (!currentSession) return;
  $("error").textContent = "";
  $("smartScan").disabled = true;
  $("smartScan").textContent = "Smart Analyse …";
  try { renderAnalysis(await invoke({ action: "scan", sessionId: currentSession })); }
  catch (e) { $("error").textContent = e.message; }
  finally { $("smartScan").disabled = false; $("smartScan").textContent = "Smart Analyse"; }
});

if (!qrDetector) $("qrEngine").textContent = "QR: BarcodeDetector nicht verfügbar";
void Promise.all([loadSessions(), loadDependencies()]);
