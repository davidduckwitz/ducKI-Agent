let cameraStream = null;
let cameraAnimationFrame = 0;
let cameraTick = 0;

const sourceModeSelect = document.getElementById("sourceMode");
const cameraButton = document.getElementById("cameraToggle");
const cameraVideo = document.getElementById("cameraVideo");
const browserSessionsSelect = document.getElementById("sessions");

function setCameraControls(active) {
  cameraButton.textContent = active ? "Kamera stoppen" : "Kamera starten";
  browserSessionsSelect.disabled = active;
  document.getElementById("localScan").disabled = active;
  document.getElementById("smartScan").disabled = active;
  if (active) {
    document.getElementById("live").className = "live on";
    document.getElementById("live").textContent = "● CAMERA";
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
    }
  } catch {
    // Camera QR support is best-effort and must never stop the live preview.
  } finally {
    qrBusy = false;
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

  // Motion is intentionally sampled, not run on every rendered camera frame.
  if (cameraTick % 3 === 0) detectMotion(cameraVideo);
  // QR is cheap but does not need 30 scans/s either.
  if (cameraTick % 6 === 0) void detectCameraQr(cameraVideo);
}

async function startCamera() {
  if (cameraStream) return;
  document.getElementById("error").textContent = "";

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Kamera ist in diesem Browser/Host nicht verfügbar.");
  }

  // Leave an active integrated-browser subscription before switching the visual source.
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

  const image = document.getElementById("frame");
  image.hidden = true;
  cameraVideo.hidden = false;
  cameraVideo.srcObject = stream;
  await cameraVideo.play();

  const empty = document.querySelector("#viewer .empty");
  if (empty) empty.hidden = true;

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
  cameraVideo.pause();
  cameraVideo.srcObject = null;
  cameraVideo.hidden = true;

  if (currentSession === "camera:local") currentSession = "";
  setCameraControls(false);
  document.getElementById("live").className = "live";
  document.getElementById("live").textContent = "● offline";

  const image = document.getElementById("frame");
  if (image.src) image.hidden = false;
  else {
    const empty = document.querySelector("#viewer .empty");
    if (empty) empty.hidden = false;
  }
}

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

window.addEventListener("pagehide", () => {
  if (cameraStream) stopCamera();
});

document.body.dataset.visionSource = "browser";
