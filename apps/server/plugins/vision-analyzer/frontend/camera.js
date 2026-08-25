let cameraStream = null;
let cameraAnimationFrame = 0;
let cameraTick = 0;
let cameraDetectBusy = false;
let cameraDetectionEnabled = false;
let lastCameraDetectionAt = 0;

const sourceModeSelect = document.getElementById("sourceMode");
const cameraButton = document.getElementById("cameraToggle");
const cameraVideo = document.getElementById("cameraVideo");
const browserSessionsSelect = document.getElementById("sessions");
const cameraCaptureCanvas = document.createElement("canvas");
const cameraCaptureContext = cameraCaptureCanvas.getContext("2d");

function setCameraControls(active) {
  cameraButton.textContent = active ? "Kamera stoppen" : "Kamera starten";
  browserSessionsSelect.disabled = active;
  // A camera frame can be locally scanned; Smart/LLM camera analysis is intentionally not wired yet.
  document.getElementById("localScan").disabled = false;
  document.getElementById("smartScan").disabled = active;
  if (active) {
    document.getElementById("live").className = "live on";
    document.getElementById("live").textContent = "● CAMERA";
  }
}

function captureCameraFrame() {
  if (!cameraStream || !cameraCaptureContext || cameraVideo.readyState < 2) return null;
  const sourceWidth = Math.max(1, cameraVideo.videoWidth || 1);
  const sourceHeight = Math.max(1, cameraVideo.videoHeight || 1);
  const maxWidth = 960;
  const scale = Math.min(1, maxWidth / sourceWidth);
  cameraCaptureCanvas.width = Math.max(1, Math.round(sourceWidth * scale));
  cameraCaptureCanvas.height = Math.max(1, Math.round(sourceHeight * scale));
  cameraCaptureContext.drawImage(cameraVideo, 0, 0, cameraCaptureCanvas.width, cameraCaptureCanvas.height);
  const dataUrl = cameraCaptureCanvas.toDataURL("image/jpeg", 0.72);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

async function refreshCameraDetectorAvailability() {
  try {
    const [deps, models] = await Promise.all([
      invoke({ action: "dependency_status" }),
      invoke({ action: "model_status" }),
    ]);
    const onnx = (deps?.packs || []).find((pack) => pack.id === "onnx");
    cameraDetectionEnabled = onnx?.installed === true && (models?.models || []).some((model) => model.installed);
  } catch {
    cameraDetectionEnabled = false;
  }
}

async function detectCameraQr(video) {
  if (qrBusy || !qrDetector || !cameraStream) return;
  qrBusy = true;
  try {
    const found = await qrDetector.detect(video);
    const width = Math.max(1, video.videoWidth || 1);
    const height = Math.max(1, video.videoHeight || 1);
    const values = found.map((entry) => ({
      value: entry.rawValue,
      bbox: entry.boundingBox
        ? [
            entry.boundingBox.x / width,
            entry.boundingBox.y / height,
            entry.boundingBox.width / width,
            entry.boundingBox.height / height,
          ]
        : undefined,
    }));
    const signature = JSON.stringify(values.map((entry) => entry.value));
    if (signature !== lastQr) {
      lastQr = signature;
      latestQrValues = values;
      renderList("qr", values, (entry) => entry.value);
      await reportLocalObservation(true);
      if (lastRenderedState) drawCameraOverlay(lastRenderedState);
    }
  } catch {
    // Camera QR support is best-effort and must never stop the live preview.
  } finally {
    qrBusy = false;
  }
}

function drawCameraOverlay(state) {
  if (!cameraStream || cameraVideo.hidden || !cameraVideo.videoWidth) return;
  const canvas = document.getElementById("overlay");
  const viewer = document.getElementById("viewer");
  if (!viewer.clientWidth || !viewer.clientHeight) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(viewer.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(viewer.clientHeight * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, viewer.clientWidth, viewer.clientHeight);

  const viewerRect = viewer.getBoundingClientRect();
  const videoRect = cameraVideo.getBoundingClientRect();
  const offsetX = videoRect.left - viewerRect.left;
  const offsetY = videoRect.top - viewerRect.top;
  const shown = displayObjects(state);
  const analysis = state?.analysis || {};
  const entries = [
    ...shown.people.map((entry) => ({ ...entry, label: `person${entry.trackId ? ` #${entry.trackId}` : ""}` })),
    ...shown.objects.map((entry) => ({ ...entry, label: `${entry.type || "object"}${entry.trackId ? ` #${entry.trackId}` : ""}` })),
    ...(state?.qrCodes || analysis.qrCodes || []).map((entry) => ({ ...entry, label: "QR" })),
  ];

  ctx.lineWidth = 2;
  ctx.font = "12px system-ui, sans-serif";
  ctx.textBaseline = "top";
  for (const entry of entries) {
    const bbox = normalizeBbox(entry.bbox);
    if (!bbox) continue;
    const [nx, ny, nw, nh] = bbox;
    const x = offsetX + nx * videoRect.width;
    const y = offsetY + ny * videoRect.height;
    const width = nw * videoRect.width;
    const height = nh * videoRect.height;
    if (width < 2 || height < 2) continue;
    ctx.strokeStyle = "#5ee6a8";
    ctx.strokeRect(x, y, width, height);
    const confidence = Number(entry.confidence);
    const label = `${entry.label}${Number.isFinite(confidence) ? ` ${Math.round(confidence * 100)}%` : ""}`;
    const labelWidth = ctx.measureText(label).width + 8;
    const labelY = Math.max(0, y - 18);
    ctx.fillStyle = "rgba(5, 8, 12, .85)";
    ctx.fillRect(x, labelY, labelWidth, 17);
    ctx.fillStyle = "#baf8d9";
    ctx.fillText(label, x + 4, labelY + 2);
  }
}

async function runCameraDetection(force = false) {
  if (!cameraStream || cameraDetectBusy || (!force && !cameraDetectionEnabled)) return;
  const now = performance.now();
  if (!force && now - lastCameraDetectionAt < 650) return;
  const frameBase64 = captureCameraFrame();
  if (!frameBase64) return;

  cameraDetectBusy = true;
  lastCameraDetectionAt = now;
  try {
    const state = await invoke({
      action: "local_frame_detect",
      sessionId: "camera:local",
      frameBase64,
      frameFormat: "jpeg",
    });
    renderAnalysis(state);
    drawCameraOverlay(state);
  } catch (error) {
    if (force) document.getElementById("error").textContent = error instanceof Error ? error.message : String(error);
  } finally {
    cameraDetectBusy = false;
  }
}

async function runCameraLocalScan() {
  if (!cameraStream) return;
  const frameBase64 = captureCameraFrame();
  if (!frameBase64) return;
  const button = document.getElementById("localScan");
  button.disabled = true;
  button.textContent = "Kamera analysiere …";
  document.getElementById("error").textContent = "";
  try {
    const state = await invoke({
      action: "local_frame_scan",
      sessionId: "camera:local",
      frameBase64,
      frameFormat: "jpeg",
    });
    renderAnalysis(state);
    drawCameraOverlay(state);
  } catch (error) {
    document.getElementById("error").textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
    button.textContent = "Lokal analysieren";
  }
}

function cameraLoop() {
  if (!cameraStream) return;
  cameraAnimationFrame = requestAnimationFrame(cameraLoop);
  if (cameraVideo.readyState < 2) return;

  cameraTick += 1;
  frameCount += 1;
  document.getElementById("fps").textContent = `Camera Frames: ${frameCount}`;
  document.getElementById("last").textContent = new Date().toLocaleTimeString();

  if (cameraTick % 3 === 0) detectMotion(cameraVideo);
  if (cameraTick % 6 === 0) void detectCameraQr(cameraVideo);
  void runCameraDetection(false);
}

async function startCamera() {
  if (cameraStream) return;
  document.getElementById("error").textContent = "";

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Kamera ist in diesem Browser/Host nicht verfügbar.");
  }

  if (currentSession && currentSession !== "camera:local") {
    const previous = currentSession;
    await request("ducki:browser:unsubscribe", { sessionId: previous }).catch(() => {});
    await invoke({ action: "stop", sessionId: previous }).catch(() => {});
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: false,
  });

  cameraStream = stream;
  currentSession = "camera:local";
  frameCount = 0;
  cameraTick = 0;
  previousMotion = null;
  latestMotion = { score: 0, active: false };
  latestQrValues = [];
  lastQr = "";
  lastRenderedState = null;
  lastCameraDetectionAt = 0;

  const image = document.getElementById("frame");
  image.hidden = true;
  cameraVideo.hidden = false;
  cameraVideo.srcObject = stream;
  await cameraVideo.play();

  const empty = document.querySelector("#viewer .empty");
  if (empty) empty.hidden = true;

  await refreshCameraDetectorAvailability();
  setCameraControls(true);
  cameraAnimationFrame = requestAnimationFrame(cameraLoop);
  await reportLocalObservation(true);
}

function stopCamera() {
  if (cameraAnimationFrame) cancelAnimationFrame(cameraAnimationFrame);
  cameraAnimationFrame = 0;

  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop();
  }
  cameraStream = null;
  cameraDetectionEnabled = false;
  cameraDetectBusy = false;
  cameraVideo.pause();
  cameraVideo.srcObject = null;
  cameraVideo.hidden = true;

  if (currentSession === "camera:local") currentSession = "";
  void invoke({ action: "local_source_stop", sessionId: "camera:local" }).catch(() => {});
  setCameraControls(false);
  document.getElementById("live").className = "live";
  document.getElementById("live").textContent = "● offline";

  const canvas = document.getElementById("overlay");
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);

  const image = document.getElementById("frame");
  if (image.src) image.hidden = false;
  else {
    const empty = document.querySelector("#viewer .empty");
    if (empty) empty.hidden = false;
  }
}

// Capture-phase interception prevents app.js's browser-session local_scan handler from firing
// when the same button is used while the camera source is active.
document.getElementById("localScan").addEventListener("click", (event) => {
  if (!cameraStream) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void runCameraLocalScan();
}, true);

sourceModeSelect.addEventListener("change", async () => {
  const mode = sourceModeSelect.value;
  document.body.dataset.visionSource = mode;
  cameraButton.hidden = mode !== "camera";
  browserSessionsSelect.hidden = mode === "camera";

  if (mode === "camera") {
    try {
      await startCamera();
    } catch (error) {
      document.getElementById("error").textContent = error instanceof Error ? error.message : String(error);
      sourceModeSelect.value = "browser";
      document.body.dataset.visionSource = "browser";
      cameraButton.hidden = true;
      browserSessionsSelect.hidden = false;
      stopCamera();
    }
  } else {
    stopCamera();
  }
});

cameraButton.addEventListener("click", async () => {
  try {
    if (cameraStream) stopCamera();
    else await startCamera();
  } catch (error) {
    document.getElementById("error").textContent = error instanceof Error ? error.message : String(error);
  }
});

window.addEventListener("resize", () => {
  if (cameraStream && lastRenderedState) drawCameraOverlay(lastRenderedState);
});

window.addEventListener("pagehide", () => {
  if (cameraStream) stopCamera();
});

document.body.dataset.visionSource = "browser";
