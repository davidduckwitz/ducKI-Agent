const $ = (id) => document.getElementById(id);
let currentSession = "";
let frameCount = 0;
let firstFrameAt = 0;
let qrBusy = false;
let lastQr = "";
const pending = new Map();

function request(type, extra = {}) {
  const requestId = crypto.randomUUID();
  parent.postMessage({ type, requestId, ...extra }, location.origin);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Bridge timeout")); }, 8000);
    pending.set(requestId, { resolve, reject, timer });
  });
}

async function invoke(input) {
  const response = await fetch("/api/plugins/vision-analyzer/invoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: "vision_analyzer", input }) });
  const json = await response.json();
  if (!response.ok) throw new Error(json?.error?.message || json?.error || "Plugin call failed");
  return json?.data?.result ?? json?.data;
}

function renderList(id, items, formatter) {
  const el = $(id); el.innerHTML = "";
  if (!Array.isArray(items) || !items.length) { el.textContent = "–"; return; }
  for (const item of items) { const div = document.createElement("div"); div.className = "item"; div.textContent = formatter(item); el.appendChild(div); }
}

function renderAnalysis(state) {
  const a = state?.analysis || {};
  $("scene").textContent = a.scene?.label ? `${a.scene.label}${a.scene.confidence ? ` · ${Math.round(a.scene.confidence * 100)}%` : ""}` : "–";
  renderList("objects", [...(a.people || []).map((x) => ({...x,type:"person"})), ...(a.objects || [])], (x) => `${x.type || "object"}${x.confidence ? ` · ${Math.round(x.confidence * 100)}%` : ""}`);
  renderList("text", a.text, (x) => x.text || "");
  renderList("qr", state?.qrCodes || a.qrCodes, (x) => x.value || x.rawValue || "QR");
  $("description").textContent = a.description || a.raw || "–";
}

async function loadSessions() {
  try {
    const rows = await request("ducki:browser:list-sessions");
    const select = $("sessions"); select.innerHTML = '<option value="">Session auswählen …</option>';
    for (const row of rows || []) { const opt = document.createElement("option"); opt.value = row.tabId || row.sessionId; opt.textContent = row.title || row.url || opt.value; select.appendChild(opt); }
  } catch (e) { $("error").textContent = e.message; }
}

async function subscribe(sessionId) {
  if (!sessionId) return;
  try {
    await request("ducki:browser:subscribe", { sessionId });
    currentSession = sessionId; frameCount = 0; firstFrameAt = performance.now(); $("live").className = "live on"; $("live").textContent = "● LIVE";
    await invoke({ action: "start", sessionId }).catch(() => {});
  } catch (e) { $("error").textContent = e.message; }
}

async function detectQr(img) {
  if (qrBusy || !("BarcodeDetector" in window) || !currentSession) return;
  qrBusy = true;
  try {
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    const found = await detector.detect(img);
    const values = found.map((x) => ({ value: x.rawValue, bbox: x.boundingBox ? [x.boundingBox.x, x.boundingBox.y, x.boundingBox.width, x.boundingBox.height] : undefined }));
    const signature = JSON.stringify(values.map((x) => x.value));
    if (signature !== lastQr) { lastQr = signature; renderList("qr", values, (x) => x.value); await invoke({ action: "report_observation", sessionId: currentSession, qrCodes: values }).catch(() => {}); }
  } catch {} finally { qrBusy = false; }
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  const msg = event.data || {};
  if (msg.type === "ducki:browser:response" && pending.has(msg.requestId)) {
    const p = pending.get(msg.requestId); clearTimeout(p.timer); pending.delete(msg.requestId); msg.ok ? p.resolve(msg.payload) : p.reject(new Error(msg.error || "Bridge error")); return;
  }
  if (msg.type === "ducki:browser:frame" && msg.payload?.sessionId === currentSession) {
    const frame = $("frame"); frame.hidden = false; frame.src = `data:image/${msg.payload.format === "png" ? "png" : "jpeg"};base64,${msg.payload.data}`;
    frameCount++; $("fps").textContent = `Frames: ${frameCount}`; $("last").textContent = new Date(msg.payload.timestamp || Date.now()).toLocaleTimeString();
    frame.onload = () => detectQr(frame);
  }
});

$("sessions").addEventListener("change", (e) => subscribe(e.target.value));
$("refresh").addEventListener("click", loadSessions);
$("scan").addEventListener("click", async () => {
  if (!currentSession) return;
  $("error").textContent = ""; $("scan").disabled = true; $("scan").textContent = "Analysiere …";
  try { renderAnalysis(await invoke({ action: "scan", sessionId: currentSession })); } catch (e) { $("error").textContent = e.message; }
  finally { $("scan").disabled = false; $("scan").textContent = "Frame analysieren"; }
});

loadSessions();
