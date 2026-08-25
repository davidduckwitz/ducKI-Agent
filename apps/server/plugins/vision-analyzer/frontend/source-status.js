const sourceStatus = document.getElementById("sourceStatus");

function refreshSourceStatus() {
  if (!sourceStatus) return;
  const mode = document.getElementById("sourceMode")?.value || "browser";
  if (mode === "camera") {
    sourceStatus.textContent = cameraVideo && !cameraVideo.hidden ? "Quelle: Kamera · lokal" : "Quelle: Kamera · aus";
    return;
  }
  if (mode === "video") {
    const name = mediaFileInput?.files?.[0]?.name;
    sourceStatus.textContent = name ? `Quelle: Video · ${name}` : "Quelle: Videodatei";
    return;
  }
  const selected = document.getElementById("sessions")?.selectedOptions?.[0];
  sourceStatus.textContent = selected?.value ? `Quelle: Browser · ${selected.textContent || selected.value}` : "Quelle: Browser";
}

document.getElementById("sourceMode")?.addEventListener("change", () => setTimeout(refreshSourceStatus, 0));
document.getElementById("sessions")?.addEventListener("change", refreshSourceStatus);
document.getElementById("cameraToggle")?.addEventListener("click", () => setTimeout(refreshSourceStatus, 0));
document.getElementById("mediaFileInput")?.addEventListener("change", () => setTimeout(refreshSourceStatus, 0));
cameraVideo?.addEventListener("playing", refreshSourceStatus);
cameraVideo?.addEventListener("pause", refreshSourceStatus);
mediaVideo?.addEventListener("loadedmetadata", refreshSourceStatus);
mediaVideo?.addEventListener("emptied", refreshSourceStatus);

refreshSourceStatus();
