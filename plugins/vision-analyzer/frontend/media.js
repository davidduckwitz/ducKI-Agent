let mediaObjectUrl = "";
let mediaDetectBusy = false;
let mediaDetectionEnabled = false;
let lastMediaDetectionAt = 0;
let mediaTick = 0;
let mediaAnimationFrame = 0;
let mediaQrBusy = false;

const mediaVideo = document.getElementById("mediaVideo");
const mediaFileInput = document.getElementById("mediaFileInput");
const mediaFileButton = document.getElementById("mediaFileButton");
const mediaCaptureCanvas = document.createElement("canvas");
const mediaCaptureContext = mediaCaptureCanvas.getContext("2d");

function mediaActive() {
  return sourceModeSelect.value === "video" && Boolean(mediaVideo.src);
}

function captureMediaFrame() {
  if (!mediaActive() || !mediaCaptureContext || mediaVideo.readyState < 2) return null;
  const sourceWidth = Math.max(1, mediaVideo.videoWidth || 1);
  const sourceHeight = Math.max(1, mediaVideo.videoHeight || 1);
  const maxWidth = 960;
  const scale = Math.min(1, maxWidth / sourceWidth);
  mediaCaptureCanvas.width = Math.max(1, Math.round(sourceWidth * scale));
  mediaCaptureCanvas.height = Math.max(1, Math.round(sourceHeight * scale));
  mediaCaptureContext.drawImage(mediaVideo, 0, 0, mediaCaptureCanvas.width, mediaCaptureCanvas.height);
  const dataUrl = mediaCaptureCanvas.toDataURL("image/jpeg", 0.72);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

async function refreshMediaDetectorAvailability() {
  try {
    const [deps, models] = await Promise.all([
      invoke({ action: "dependency_status" }),
      invoke({ action: "model_status" }),
    ]);
    const onnx = (deps?.packs || []).find((pack) => pack.id === "onnx");
    mediaDetectionEnabled = onnx?.installed === true && (models?.models || []).some((model) => model.installed);
  } catch {
    mediaDetectionEnabled = false;
  }
}

async function detectMediaQr() {
  if (mediaQrBusy || !qrDetector || !mediaActive() || mediaVideo.readyState < 2) return;
  mediaQrBusy = true;
  try {
    const found = await qrDetector.detect(mediaVideo);
    const width = Math.max(1, mediaVideo.videoWidth || 1);
    const height = Math.max(1, mediaVideo.videoHeight || 1);
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
      if (lastRenderedState) drawMediaOverlay(lastRenderedState);
    }
  } catch {
    // QR decoding is best-effort for video frames.
  } finally {
    mediaQrBusy = false;
  }
}

function drawMediaOverlay(state) {
  if (!mediaActive() || !mediaVideo.videoWidth) return;
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
  const videoRect = mediaVideo.getBoundingClientRect();
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

async function runMediaDetection(force = false) {
  if (!mediaActive() || mediaDetectBusy || (!force && !mediaDetectionEnabled)) return;
  const now = performance.now();
  if (!force && now - lastMediaDetectionAt < 650) return;
  const frameBase64 = captureMediaFrame();
  if (!frameBase64) return;

  mediaDetectBusy = true;
  lastMediaDetectionAt = now;
  try {
    const state = await invoke({
      action: "local_frame_detect",
      sessionId: "video:local",
      frameBase64,
      frameFormat: "jpeg",
    });
    renderAnalysis(state);
    drawMediaOverlay(state);
  } catch (error) {
    if (force) document.getElementById("error").textContent = error instanceof Error ? error.message : String(error);
  } finally {
    mediaDetectBusy = false;
  }
}

async function runMediaLocalScan() {
  if (!mediaActive()) return;
  const frameBase64 = captureMediaFrame();
  if (!frameBase64) return;
  const button = document.getElementById("localScan");
  button.disabled = true;
  button.textContent = "Video analysiere …";
  document.getElementById("error").textContent = "";
  try {
    const state = await invoke({
      action: "local_frame_scan",
      sessionId: "video:local",
      frameBase64,
      frameFormat: "jpeg",
    });
    renderAnalysis(state);
    drawMediaOverlay(state);
  } catch (error) {
    document.getElementById("error").textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
    button.textContent = "Lokal analysieren";
  }
}

function mediaLoop() {
  if (sourceModeSelect.value !== "video") return;
  mediaAnimationFrame = requestAnimationFrame(mediaLoop);
  if (!mediaActive() || mediaVideo.paused || mediaVideo.ended || mediaVideo.readyState < 2) return;

  mediaTick += 1;
  frameCount += 1;
  document.getElementById("fps").textContent = `Video Frames: ${frameCount}`;
  document.getElementById("last").textContent = `${mediaVideo.currentTime.toFixed(1)}s / ${Number.isFinite(mediaVideo.duration) ? mediaVideo.duration.toFixed(1) : "?"}s`;
  if (mediaTick % 3 === 0) detectMotion(mediaVideo);
  if (mediaTick % 6 === 0) void detectMediaQr();
  void runMediaDetection(false);
}

async function activateMediaFile(file) {
  if (!file) return;
  cleanupMediaSource();
  if (!String(file.type || "").startsWith("video/")) {
    throw new Error("Bitte eine Videodatei auswählen.");
  }

  if (currentSession && currentSession !== "video:local") {
    const previous = currentSession;
    await request("ducki:browser:unsubscribe", { sessionId: previous }).catch(() => {});
    await invoke({ action: "stop", sessionId: previous }).catch(() => {});
  }

  mediaObjectUrl = URL.createObjectURL(file);
  mediaVideo.src = mediaObjectUrl;
  mediaVideo.hidden = false;
  document.getElementById("frame").hidden = true;
  cameraVideo.hidden = true;
  currentSession = "video:local";
  previousMotion = null;
  latestMotion = { score: 0, active: false };
  latestQrValues = [];
  lastQr = "";
  lastRenderedState = null;
  frameCount = 0;
  mediaTick = 0;
  lastMediaDetectionAt = 0;

  const empty = document.querySelector("#viewer .empty");
  if (empty) empty.hidden = true;

  await refreshMediaDetectorAvailability();
  document.getElementById("smartScan").disabled = true;
  document.getElementById("live").className = "live on";
  document.getElementById("live").textContent = "● VIDEO";
  await reportLocalObservation(true);
  await mediaVideo.play().catch(() => {});
  if (!mediaAnimationFrame) mediaAnimationFrame = requestAnimationFrame(mediaLoop);
}

function cleanupMediaSource() {
  if (mediaAnimationFrame) cancelAnimationFrame(mediaAnimationFrame);
  mediaAnimationFrame = 0;
  mediaDetectBusy = false;
  mediaDetectionEnabled = false;
  mediaVideo.pause();
  mediaVideo.removeAttribute("src");
  mediaVideo.load();
  mediaVideo.hidden = true;
  if (mediaObjectUrl) URL.revokeObjectURL(mediaObjectUrl);
  mediaObjectUrl = "";
  if (currentSession === "video:local") currentSession = "";
  void invoke({ action: "local_source_stop", sessionId: "video:local" }).catch(() => {});
}

mediaFileButton.addEventListener("click", () => mediaFileInput.click());
mediaFileInput.addEventListener("change", () => {
  const file = mediaFileInput.files?.[0];
  if (!file) return;
  void activateMediaFile(file).catch((error) => {
    document.getElementById("error").textContent = error instanceof Error ? error.message : String(error);
  });
});

document.getElementById("localScan").addEventListener("click", (event) => {
  if (!mediaActive()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void runMediaLocalScan();
}, true);

sourceModeSelect.addEventListener("change", () => {
  const videoMode = sourceModeSelect.value === "video";
  mediaFileButton.hidden = !videoMode;
  if (!videoMode) {
    cleanupMediaSource();
  } else {
    browserSessionsSelect.hidden = true;
    cameraButton.hidden = true;
    document.getElementById("smartScan").disabled = true;
    const empty = document.querySelector("#viewer .empty");
    if (empty) {
      empty.hidden = false;
      empty.textContent = "Videodatei auswählen";
    }
  }
});

mediaVideo.addEventListener("play", () => {
  if (sourceModeSelect.value === "video" && !mediaAnimationFrame) mediaAnimationFrame = requestAnimationFrame(mediaLoop);
});
mediaVideo.addEventListener("seeked", () => {
  if (mediaActive()) {
    previousMotion = null;
    void runMediaDetection(true);
  }
});

window.addEventListener("resize", () => {
  if (mediaActive() && lastRenderedState) drawMediaOverlay(lastRenderedState);
});
window.addEventListener("pagehide", cleanupMediaSource);
