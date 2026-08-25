const $ = (id) => document.getElementById(id);
let currentSession = "";
let frameCount = 0;
let qrBusy = false;
let lastQr = "";
let latestQrValues = [];
let previousMotion = null;
let latestMotion = { score: 0, active: false };
let lastObservationReport = 0;
let lastRenderedState = null;
const pending = new Map();

const qrDetector = "BarcodeDetector" in window
  ? new BarcodeDetector({ formats: ["qr_code"] })
  : null;

function request(type, extra = {}) {
  const requestId = crypto.randomUUID();
  parent.postMessage({ type, requestId, ...extra }, location.origin);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Bridge timeout"));
    }, 8000);
    pending.set(requestId, { resolve, reject, timer });
  });
}

async function invoke(input) {
  const response = await fetch("/api/plugins/vision-analyzer/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "vision_analyzer", input }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json?.error?.message || json?.error || "Plugin call failed");
  return json?.data?.result ?? json?.data;
}

function renderList(id, items, formatter) {
  const el = $(id);
  el.innerHTML = "";
  if (!Array.isArray(items) || !items.length) {
    el.textContent = "–";
    return;
  }
  for (const item of items) {
    const div = document.createElement("div");
    div.className = "item";
    div.textContent = formatter(item);
    el.appendChild(div);
  }
}

function displayObjects(state) {
  const analysis = state?.analysis || {};
  const people = Array.isArray(analysis.people) ? analysis.people : (state?.detections?.people || []);
  const objects = Array.isArray(analysis.objects) ? analysis.objects : (state?.detections?.objects || []);
  return {
    people: people.map((entry) => ({ ...entry, type: entry.type || "person" })),
    objects,
  };
}

function renderAnalysis(state) {
  lastRenderedState = state;
  const analysis = state?.analysis || {};
  const shown = displayObjects(state);

  $("scene").textContent = analysis.scene?.label
    ? `${analysis.scene.label}${analysis.scene.confidence ? ` · ${Math.round(analysis.scene.confidence * 100)}%` : ""}`
    : "–";

  renderList(
    "objects",
    [...shown.people, ...shown.objects],
    (entry) => `${entry.type || "object"}${entry.confidence ? ` · ${Math.round(entry.confidence * 100)}%` : ""}`,
  );
  renderList("text", analysis.text, (entry) => entry.text || "");
  renderList("qr", state?.qrCodes || analysis.qrCodes, (entry) => entry.value || entry.rawValue || "QR");

  const detector = state?.detections;
  const detectorInfo = detector?.inferenceMs
    ? `\n\nLocal detector: ${detector.model || "ONNX"} · ${detector.inferenceMs} ms`
    : detector?.skipped
      ? `\n\nLocal detector: ${detector.skipped}`
      : "";
  $("description").textContent = `${analysis.description || analysis.raw || "–"}${detectorInfo}`;

  if (state?.motion) renderMotion(state.motion);
  drawOverlay(state);
}

function renderMotion(motion) {
  const score = Math.max(0, Math.min(1, Number(motion?.score ?? 0) || 0));
  latestMotion = { score, active: motion?.active === true };
  $("motionText").textContent = `${latestMotion.active ? "Bewegung" : "ruhig"} · ${(score * 100).toFixed(1)}%`;
  $("motionFill").style.width = `${Math.min(100, score * 500)}%`;
}

function createManagerCard(title, statusText, description, buttonText, onClick, meta = "") {
  const card = document.createElement("div");
  card.className = "dep";

  const row = document.createElement("div");
  row.className = "dep-row";

  const name = document.createElement("span");
  name.className = "dep-name";
  name.textContent = title;

  const state = document.createElement("span");
  state.className = `dep-status${statusText.startsWith("✓") ? " ok" : ""}`;
  state.textContent = statusText;
  row.append(name, state);

  const desc = document.createElement("p");
  desc.textContent = description;

  const button = document.createElement("button");
  button.textContent = buttonText;
  button.addEventListener("click", async () => {
    button.disabled = true;
    $("error").textContent = "";
    try {
      await onClick(button);
    } catch (error) {
      $("error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  card.append(row, desc);
  if (meta) {
    const extra = document.createElement("p");
    extra.className = "meta";
    extra.textContent = meta;
    card.appendChild(extra);
  }
  card.appendChild(button);
  return card;
}

function renderDependencies(status) {
  const root = $("deps");
  root.innerHTML = "";

  root.appendChild(createManagerCard(
    "Core Local",
    "✓ bereit",
    "Browser-Stream, QR-Code und Bewegungserkennung. Keine Installation, kein LLM.",
    "Immer aktiv",
    async () => {},
  ));
  root.lastElementChild.querySelector("button").disabled = true;

  for (const pack of status?.packs || []) {
    root.appendChild(createManagerCard(
      pack.label,
      pack.installed ? "✓ installiert" : "nicht installiert",
      pack.description || "",
      pack.installed ? "Entfernen" : "Installieren",
      async (button) => {
        button.textContent = pack.installed ? "Entferne …" : "Installiere …";
        const result = await invoke({
          action: pack.installed ? "dependency_remove" : "dependency_install",
          pack: pack.id,
        });
        renderDependencies(result.status || await invoke({ action: "dependency_status" }));
        await loadModels();
      },
      pack.modules?.map((entry) => `${entry.name}: ${entry.installed ? "✓" : "–"}`).join(" · ") || "",
    ));
  }
}

function renderModels(status) {
  const root = $("models");
  root.innerHTML = "";
  const models = status?.models || [];

  if (!models.length) {
    root.textContent = "Keine lokalen Modelle verfügbar.";
    return;
  }

  for (const model of models) {
    const size = model.sizeBytes ? `${(model.sizeBytes / 1024 / 1024).toFixed(1)} MB` : "ca. 10 MB";
    root.appendChild(createManagerCard(
      model.label,
      model.installed ? "✓ installiert" : "nicht installiert",
      model.description || "",
      model.installed ? "Modell entfernen" : "Modell installieren",
      async (button) => {
        button.textContent = model.installed ? "Entferne Modell …" : "Lade & prüfe Modell …";
        const result = await invoke({
          action: model.installed ? "model_remove" : "model_install",
          model: model.id,
        });
        renderModels(result.status || await invoke({ action: "model_status" }));
      },
      `${size} · Lizenz ${model.license || "unbekannt"} · Download wird per SHA-256 geprüft`,
    ));
  }
}

async function loadDependencies() {
  try {
    renderDependencies(await invoke({ action: "dependency_status" }));
  } catch (error) {
    $("error").textContent = error.message;
  }
}

async function loadModels() {
  try {
    renderModels(await invoke({ action: "model_status" }));
  } catch (error) {
    $("error").textContent = error.message;
  }
}

async function loadSessions() {
  try {
    const rows = await request("ducki:browser:list-sessions");
    const select = $("sessions");
    select.innerHTML = '<option value="">Session auswählen …</option>';
    for (const row of rows || []) {
      const opt = document.createElement("option");
      opt.value = row.tabId || row.sessionId;
      opt.textContent = row.title || row.url || opt.value;
      select.appendChild(opt);
    }
  } catch (error) {
    $("error").textContent = error.message;
  }
}

async function subscribe(sessionId) {
  if (currentSession && currentSession !== sessionId) {
    await request("ducki:browser:unsubscribe", { sessionId: currentSession }).catch(() => {});
    await invoke({ action: "stop", sessionId: currentSession }).catch(() => {});
  }
  if (!sessionId) {
    currentSession = "";
    $("live").className = "live";
    $("live").textContent = "● offline";
    return;
  }

  try {
    await request("ducki:browser:subscribe", { sessionId });
    currentSession = sessionId;
    frameCount = 0;
    previousMotion = null;
    latestMotion = { score: 0, active: false };
    $("live").className = "live on";
    $("live").textContent = "● LIVE";
    const state = await invoke({ action: "start", sessionId }).catch(() => null);
    if (state) renderAnalysis(state);
  } catch (error) {
    $("error").textContent = error.message;
  }
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
    const naturalWidth = Math.max(1, img.naturalWidth || 1);
    const naturalHeight = Math.max(1, img.naturalHeight || 1);
    const values = found.map((entry) => ({
      value: entry.rawValue,
      bbox: entry.boundingBox
        ? [
            entry.boundingBox.x / naturalWidth,
            entry.boundingBox.y / naturalHeight,
            entry.boundingBox.width / naturalWidth,
            entry.boundingBox.height / naturalHeight,
          ]
        : undefined,
    }));
    const signature = JSON.stringify(values.map((entry) => entry.value));
    if (signature !== lastQr) {
      lastQr = signature;
      latestQrValues = values;
      renderList("qr", values, (entry) => entry.value);
      await reportLocalObservation(true);
      if (lastRenderedState) {
        lastRenderedState.qrCodes = values;
        drawOverlay(lastRenderedState);
      }
    }
  } catch {
    // BarcodeDetector support differs between Chromium builds; failure must never stop the stream.
  } finally {
    qrBusy = false;
  }
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
    const diff =
      Math.abs(pixels[i] - previousMotion[i]) +
      Math.abs(pixels[i + 1] - previousMotion[i + 1]) +
      Math.abs(pixels[i + 2] - previousMotion[i + 2]);
    if (diff > 75) changed += 1;
  }
  previousMotion.set(pixels);
  const score = changed / count;
  renderMotion({ score, active: score > 0.02 });
  void reportLocalObservation(false);
}

function normalizeBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const values = bbox.slice(0, 4).map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  if (values.some((value) => value < -0.05 || value > 1.05)) return null;
  return values.map((value) => Math.max(0, Math.min(1, value)));
}

function drawOverlay(state) {
  const frame = $("frame");
  const canvas = $("overlay");
  const viewer = $("viewer");
  if (frame.hidden || !frame.naturalWidth || !viewer.clientWidth || !viewer.clientHeight) {
    canvas.width = 1;
    canvas.height = 1;
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(viewer.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(viewer.clientHeight * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, viewer.clientWidth, viewer.clientHeight);

  const viewerRect = viewer.getBoundingClientRect();
  const imageRect = frame.getBoundingClientRect();
  const imageX = imageRect.left - viewerRect.left;
  const imageY = imageRect.top - viewerRect.top;

  const analysis = state?.analysis || {};
  const shown = displayObjects(state);
  const entries = [
    ...shown.people.map((entry) => ({ ...entry, label: "person" })),
    ...shown.objects.map((entry) => ({ ...entry, label: entry.type || "object" })),
    ...(analysis.text || []).map((entry) => ({ ...entry, label: String(entry.text || "text").slice(0, 32) })),
    ...(state?.qrCodes || analysis.qrCodes || []).map((entry) => ({ ...entry, label: "QR" })),
  ];

  ctx.lineWidth = 2;
  ctx.font = "12px system-ui, sans-serif";
  ctx.textBaseline = "top";

  for (const entry of entries) {
    const bbox = normalizeBbox(entry.bbox);
    if (!bbox) continue;
    const [nx, ny, nw, nh] = bbox;
    const x = imageX + nx * imageRect.width;
    const y = imageY + ny * imageRect.height;
    const width = nw * imageRect.width;
    const height = nh * imageRect.height;
    if (width < 2 || height < 2) continue;

    ctx.strokeStyle = "#5ee6a8";
    ctx.strokeRect(x, y, width, height);

    const confidence = Number(entry.confidence);
    const text = `${entry.label || "object"}${Number.isFinite(confidence) ? ` ${Math.round(confidence * 100)}%` : ""}`;
    const textWidth = ctx.measureText(text).width + 8;
    const textY = Math.max(0, y - 18);
    ctx.fillStyle = "rgba(5, 8, 12, .85)";
    ctx.fillRect(x, textY, textWidth, 17);
    ctx.fillStyle = "#baf8d9";
    ctx.fillText(text, x + 4, textY + 2);
  }
}

async function refreshState() {
  if (!currentSession) return;
  try {
    const state = await invoke({ action: "state", sessionId: currentSession });
    renderAnalysis(state);
  } catch {}
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  const msg = event.data || {};

  if (msg.type === "ducki:browser:response" && pending.has(msg.requestId)) {
    const entry = pending.get(msg.requestId);
    clearTimeout(entry.timer);
    pending.delete(msg.requestId);
    msg.ok ? entry.resolve(msg.payload) : entry.reject(new Error(msg.error || "Bridge error"));
    return;
  }

  if (msg.type === "ducki:browser:frame" && msg.payload?.sessionId === currentSession) {
    const frame = $("frame");
    frame.hidden = false;
    frame.src = `data:image/${msg.payload.format === "png" ? "png" : "jpeg"};base64,${msg.payload.data}`;
    frameCount += 1;
    $("fps").textContent = `Frames: ${frameCount}`;
    $("last").textContent = new Date(msg.payload.timestamp || Date.now()).toLocaleTimeString();
    frame.onload = () => {
      void detectQr(frame);
      detectMotion(frame);
      if (lastRenderedState) drawOverlay(lastRenderedState);
    };

    if (frameCount % 20 === 0) void refreshState();
  }
});

window.addEventListener("resize", () => {
  if (lastRenderedState) drawOverlay(lastRenderedState);
});

$("sessions").addEventListener("change", (event) => {
  void subscribe(event.target.value);
});

$("refresh").addEventListener("click", () => {
  void loadSessions();
  void loadDependencies();
  void loadModels();
  void refreshState();
});

$("localScan").addEventListener("click", async () => {
  if (!currentSession) return;
  $("error").textContent = "";
  $("localScan").disabled = true;
  $("localScan").textContent = "Lokal analysiere …";
  try {
    renderAnalysis(await invoke({ action: "local_scan", sessionId: currentSession }));
  } catch (error) {
    $("error").textContent = error.message;
  } finally {
    $("localScan").disabled = false;
    $("localScan").textContent = "Lokal analysieren";
  }
});

$("smartScan").addEventListener("click", async () => {
  if (!currentSession) return;
  $("error").textContent = "";
  $("smartScan").disabled = true;
  $("smartScan").textContent = "Smart Analyse …";
  try {
    renderAnalysis(await invoke({ action: "scan", sessionId: currentSession }));
  } catch (error) {
    $("error").textContent = error.message;
  } finally {
    $("smartScan").disabled = false;
    $("smartScan").textContent = "Smart Analyse";
  }
});

if (!qrDetector) $("qrEngine").textContent = "QR: BarcodeDetector nicht verfügbar";
void Promise.all([loadSessions(), loadDependencies(), loadModels()]);
