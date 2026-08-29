/**
 * Video Editor - multi-track NLE frontend. Vanilla JS, no build step (matches this project's
 * other plugin frontends). Talks to the video_editor tool exclusively through invoke() below -
 * every action name/param here must match tools/video-editor.js exactly (read there first if
 * something looks off, it is the source of truth).
 */
(function () {
"use strict";

const PLUGIN = "video-editor";
const THEME_KEY = "video-editor-theme";
const DEFAULT_RENDER_W = 1280, DEFAULT_RENDER_H = 720;

// =============================================================================================
// Small utilities
// =============================================================================================

function $(id) { return document.getElementById(id); }
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtSec(s) {
  if (s == null || !Number.isFinite(Number(s))) return "0.0s";
  return (Math.round(Number(s) * 10) / 10) + "s";
}
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function debounce(fn, ms) {
  let timer = null;
  const wrapped = function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(null, args), ms);
  };
  wrapped.flush = (...args) => { clearTimeout(timer); fn.apply(null, args); };
  return wrapped;
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// =============================================================================================
// Toasts
// =============================================================================================

function showToast(message, isError) {
  const container = $("toastContainer");
  const toast = el("div", "toast" + (isError ? " error" : ""), escapeHtml(message));
  container.appendChild(toast);
  setTimeout(() => toast.remove(), isError ? 6000 : 3200);
}

/** Custom confirm modal - used instead of window.confirm() for every destructive action, since
 *  a native dialog can't be styled to match this UI and doesn't interact predictably with
 *  automated drivers. Resolves true/false like window.confirm() would. */
function confirmDialog(message) {
  return new Promise((resolve) => {
    const root = $("modalRoot");
    root.innerHTML =
      '<div class="modal-backdrop" id="confirmBackdrop">' +
        '<div class="modal" style="max-width:360px">' +
          '<div class="modal-body" style="padding-top:20px">' +
            '<div style="font-size:13px;line-height:1.5;margin-bottom:16px">' + escapeHtml(message) + "</div>" +
            '<div style="display:flex;gap:8px;justify-content:flex-end">' +
              '<button type="button" class="secondary-button" id="confirmCancelBtn">' + escapeHtml(t("common.cancel")) + "</button>" +
              '<button type="button" class="danger-button" id="confirmOkBtn">' + escapeHtml(t("common.delete")) + "</button>" +
            "</div>" +
          "</div>" +
        "</div>" +
      "</div>";
    function cleanup(result) { root.innerHTML = ""; resolve(result); }
    $("confirmCancelBtn").addEventListener("click", () => cleanup(false));
    $("confirmOkBtn").addEventListener("click", () => cleanup(true));
    $("confirmBackdrop").addEventListener("click", (e) => { if (e.target.id === "confirmBackdrop") cleanup(false); });
  });
}

// =============================================================================================
// API
// =============================================================================================

async function invoke(input) {
  const res = await fetch("/api/plugins/" + PLUGIN + "/invoke", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "video_editor", input }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json && (json.error || json.message)) || ("HTTP " + res.status));
  const payload = (json.data && json.data.result) || json.result || {};
  if (payload.error) throw new Error(payload.error);
  return payload;
}
function dataUrl(rel) { return "/api/plugins/" + PLUGIN + "/data/" + rel; }

// =============================================================================================
// image-gen integration (optional - only rendered if that plugin is installed AND enabled).
// The agent already has this handoff via tools (image_gen.generate -> image_url ->
// add_scene_background_image, see tools/video-editor.js) - this section gives the human user
// the same capability directly in the UI: generate/vary a scene image with a prompt instead of
// only being able to upload a file.
// =============================================================================================

async function detectImageGen() {
  try {
    const res = await fetch("/api/plugins/image-gen");
    if (!res.ok) { state.imageGenAvailable = false; return; }
    const json = await res.json().catch(() => ({}));
    state.imageGenAvailable = !!(json && json.data && json.data.enabled);
  } catch {
    state.imageGenAvailable = false;
  }
}

async function invokeImageGen(input) {
  const res = await fetch("/api/plugins/image-gen/invoke", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "image_gen", input }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json && (json.error || json.message)) || ("HTTP " + res.status));
  const payload = (json.data && json.data.result) || json.result || {};
  if (payload.error) throw new Error(payload.error);
  return payload;
}

/** Generates one image via image-gen and immediately attaches it as a scene background of the
 *  current project, server-side (image_url handoff - no base64 through this browser tab's JS
 *  beyond what the resulting <img> naturally loads). */
async function generateAiImageAndAttach({ prompt, referenceId, referenceImageBase64 }) {
  const genResult = await invokeImageGen({
    action: "generate", prompt,
    reference_id: referenceId || undefined,
    reference_image: referenceImageBase64 || undefined,
  });
  const bgResult = await invoke({
    action: "add_scene_background_image", project_id: state.currentProjectId,
    image_url: genResult.url, original_name: "ai-generated.png",
  });
  return { background: bgResult.background, imageGenId: genResult.id };
}

/** Finds the most recent AI-generated scene image BEFORE `beforeOrder` (or the overall most
 *  recent one if `beforeOrder` is null) so a new/edited scene can offer "stay visually
 *  consistent with that one" via image-gen's reference_id (img2img). Returns null if there is
 *  no earlier AI-generated scene image to chain from. */
function findConsistencyReference(beforeOrder) {
  const candidates = state.timelineItems
    .filter((it) => it.type === "scene" && it.background && it.background.kind === "image" && (beforeOrder == null || it.order < beforeOrder))
    .sort((a, b) => b.order - a.order);
  for (const item of candidates) {
    const cached = state.backgroundsCache.find((b) => String(b.id) === String(item.background.value));
    if (cached && cached.imageGenId) return { imageGenId: cached.imageGenId, name: cached.original_name };
  }
  return null;
}

/** Injects a "Mit KI generieren" toggle + inline prompt form into `container`. No-op if
 *  image-gen isn't available. opts: { referenceImageGenId?, referenceLabel?, buttonLabel?,
 *  onCreated(background, imageGenId) }. */
function renderAiImageControl(container, opts) {
  if (!state.imageGenAvailable) return;
  const toggleBtn = el("button", "secondary-button block-btn", "✨ " + (opts.buttonLabel || "Mit KI generieren"));
  toggleBtn.type = "button";
  toggleBtn.style.marginTop = "6px";
  const formWrap = el("div");
  formWrap.style.marginTop = "8px";
  container.appendChild(toggleBtn);
  container.appendChild(formWrap);

  toggleBtn.addEventListener("click", () => {
    if (formWrap.dataset.open === "1") { formWrap.innerHTML = ""; formWrap.dataset.open = "0"; return; }
    formWrap.dataset.open = "1";
    formWrap.innerHTML =
      '<div class="form-row"><label>Prompt</label><textarea class="form-control small" id="aiImgPrompt" rows="2" placeholder="z. B. a cozy reading nook, warm light, flat illustration"></textarea></div>' +
      (opts.referenceImageGenId
        ? '<label style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text);margin-bottom:10px"><input type="checkbox" id="aiImgConsistent" checked> Stilkonsistent zu ' + escapeHtml(opts.referenceLabel || "letztem Bild") + "</label>"
        : "") +
      '<button type="button" class="primary-button block-btn" id="aiImgGoBtn">Generieren</button>' +
      '<div class="panel-hint" id="aiImgStatus"></div>';

    formWrap.querySelector("#aiImgGoBtn").addEventListener("click", async (e) => {
      const prompt = formWrap.querySelector("#aiImgPrompt").value.trim();
      if (!prompt) { formWrap.querySelector("#aiImgStatus").textContent = "Bitte einen Prompt eingeben."; return; }
      const consistentEl = formWrap.querySelector("#aiImgConsistent");
      const referenceId = (consistentEl && consistentEl.checked) ? opts.referenceImageGenId : undefined;

      await withButtonSpinner(e.target, "Generiere...", async () => {
        try {
          const result = await generateAiImageAndAttach({ prompt, referenceId });
          formWrap.innerHTML = "";
          formWrap.dataset.open = "0";
          opts.onCreated(result.background, result.imageGenId);
        } catch (err) {
          formWrap.querySelector("#aiImgStatus").textContent = err.message || "Generierung fehlgeschlagen";
        }
      });
    });
  });
}

/** Injects an inline "veraendern" form for an EXISTING background into `container` - img2img via
 *  its stored image-gen id if it was AI-generated, otherwise (a manually uploaded photo) the
 *  bytes are fetched client-side from this plugin's own /data/backgrounds/ route and sent as
 *  reference_image (fine here - this is browser<->server traffic, not routed through an agent's
 *  own context, so the base64-bloat concern that applies to tool calls doesn't apply). */
function renderModifyBackgroundControl(container, bg, onCreated) {
  if (!state.imageGenAvailable) return;
  const wrap = el("div");
  wrap.style.marginTop = "8px";
  wrap.innerHTML =
    '<div class="form-row"><label>Neuer Prompt (beschreibt die Veraenderung)</label><textarea class="form-control small" id="modPrompt" rows="2"></textarea></div>' +
    '<button type="button" class="primary-button block-btn" id="modGoBtn">Generieren</button>' +
    '<div class="panel-hint" id="modStatus"></div>';
  container.appendChild(wrap);

  wrap.querySelector("#modGoBtn").addEventListener("click", async (e) => {
    const prompt = wrap.querySelector("#modPrompt").value.trim();
    if (!prompt) { wrap.querySelector("#modStatus").textContent = "Bitte einen Prompt eingeben."; return; }
    await withButtonSpinner(e.target, "Generiere...", async () => {
      try {
        let referenceImageBase64;
        const referenceId = bg.imageGenId || undefined;
        if (!referenceId) {
          const res = await fetch(dataUrl("backgrounds/" + bg.filename));
          const blob = await res.blob();
          referenceImageBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("Bild konnte nicht gelesen werden"));
            reader.readAsDataURL(blob);
          });
        }
        const result = await generateAiImageAndAttach({ prompt, referenceId, referenceImageBase64 });
        wrap.remove();
        onCreated(result.background, result.imageGenId);
      } catch (err) {
        wrap.querySelector("#modStatus").textContent = err.message || "Generierung fehlgeschlagen";
      }
    });
  });
}

// =============================================================================================
// Elements panel - a picker for image-gen results + chat-uploaded images, so the user doesn't
// have to fight the fiddly native drag of the small scene-preview card just to get an existing
// image onto the timeline. Click "+" (or drag the list item itself) to add it as a new scene.
// Only shown when image-gen is available (see detectImageGen()).
// =============================================================================================

/** Builds one `.item-list`'s worth of list-items (same markup/classes as renderClipsList()) from
 *  a generic {url, name} shape, wires the "+" button and native drag, and calls onAdd(url,
 *  atOrder, btn) - kept generic so both the image-gen list and the chat-upload list share it. */
function renderElementsList(container, items, emptyText, onAdd) {
  if (!items.length) {
    container.innerHTML = '<div class="empty-state">' + escapeHtml(emptyText) + "</div>";
    return;
  }
  container.innerHTML = items.map((item, idx) =>
    '<div class="list-item" draggable="true" data-elem-idx="' + idx + '">' +
      '<div class="thumb"><img src="' + item.url + '" loading="lazy"></div>' +
      '<div class="meta"><div class="name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + "</div></div>" +
      '<div class="actions">' +
        '<button type="button" class="icon-button act-add-element" data-elem-idx="' + idx + '" title="' + escapeHtml(t("elements.addTitle")) + '">+</button>' +
        '<button type="button" class="icon-button act-add-element-overlay" data-elem-idx="' + idx + '" title="' + escapeHtml(t("elements.addOverlayTitle")) + '">▭</button>' +
      "</div>" +
    "</div>"
  ).join("");

  container.querySelectorAll(".act-add-element").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onAdd(items[Number(btn.dataset.elemIdx)].url, null, btn);
    });
  });
  container.querySelectorAll(".act-add-element-overlay").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      addElementToOverlayTrack(items[Number(btn.dataset.elemIdx)].url, typeof playheadTime === "number" ? playheadTime : 0, 0, btn);
    });
  });
  container.querySelectorAll(".list-item[data-elem-idx]").forEach((elx) => {
    elx.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("application/json", JSON.stringify({ kind: "element", url: items[Number(elx.dataset.elemIdx)].url }));
    });
  });
}

/** Shared by both the "+" button (atOrder=null, has a btn to spin) and the timeline drop handler
 *  (atOrder=target index, no btn). Same server-side image_url handoff add_scene_background_image
 *  already uses for AI-generated images (see generateAiImageAndAttach) - works unmodified for a
 *  chat-upload URL too, since fetchImageUrlAsBase64() in tools/video-editor.js just does a plain
 *  server-side GET regardless of which plugin/route the URL points at. */
async function addElementToMainTrack(imageUrl, atOrder, btn) {
  if (!state.currentProjectId) { showToast(t("scenes.needProject"), true); return; }
  const run = async () => {
    try {
      const bgResult = await invoke({
        action: "add_scene_background_image", project_id: state.currentProjectId,
        image_url: imageUrl, original_name: "element.png",
      });
      state.backgroundsCache.push({
        id: bgResult.background.id, filename: bgResult.background.filename,
        original_name: "element.png", dataUrl: dataUrl("backgrounds/" + bgResult.background.filename),
      });
      addSceneToMainTrack({ duration: 3, background: { kind: "image", value: bgResult.background.id } }, atOrder);
      populateSceneLibrary();
      showToast(t("elements.added"));
    } catch (err) {
      showToast(err.message || String(err), true);
    }
  };
  if (btn) await withButtonSpinner(btn, "+", run);
  else await run();
}

/** Same image_url handoff as addElementToMainTrack, but attaches the result as an IMAGE overlay
 *  (type:"image", props:{background_id}) on the overlay track instead of a full-frame scene -
 *  see the "image" branch in tools/video-editor.js's buildRenderFilterGraph for how that's
 *  actually burned in (ffmpeg overlay filter, reusing the same backgrounds row/file). */
async function addElementToOverlayTrack(imageUrl, startSec, trackIndex, btn) {
  if (!state.currentProjectId) { showToast(t("scenes.needProject"), true); return; }
  const run = async () => {
    try {
      const bgResult = await invoke({
        action: "add_scene_background_image", project_id: state.currentProjectId,
        image_url: imageUrl, original_name: "element.png",
      });
      state.backgroundsCache.push({
        id: bgResult.background.id, filename: bgResult.background.filename,
        original_name: "element.png", dataUrl: dataUrl("backgrounds/" + bgResult.background.filename),
      });
      const start = Math.max(0, startSec || 0);
      const res = await invoke({
        action: "add_overlay", project_id: state.currentProjectId, type: "image",
        start_sec: start, end_sec: start + 3, x: 65, y: 65, width: 30, height: 30,
        z_index: state.overlays.length, track_index: trackIndex || 0,
        props: { background_id: bgResult.background.id },
      });
      await loadOverlays();
      state.selection = { kind: "overlay", id: res.overlay.id };
      renderAll();
      showToast(t("elements.added"));
    } catch (err) {
      showToast(err.message || String(err), true);
    }
  };
  if (btn) await withButtonSpinner(btn, "▭", run);
  else await run();
}

// Infinite scroll instead of a single fixed-size fetch - both lists can grow without bound
// (every image-gen generation ever made / every chat upload ever sent), so loading everything
// up front would only get slower over time. Each list tracks its own offset/hasMore/loading
// state and fetches the next page when its sentinel div scrolls into view.
const ELEMENTS_PAGE_SIZE = 20;
const elementsGenState = { items: [], offset: 0, hasMore: true, loading: false };
const elementsUploadState = { items: [], offset: 0, hasMore: true, loading: false };

async function loadMoreGenerated() {
  if (elementsGenState.loading || !elementsGenState.hasMore) return;
  elementsGenState.loading = true;
  try {
    const result = await invokeImageGen({ action: "list", limit: ELEMENTS_PAGE_SIZE, offset: elementsGenState.offset });
    const newItems = (result.items || []).map((row) => ({ url: row.url, name: row.prompt || row.id }));
    elementsGenState.items = elementsGenState.items.concat(newItems);
    elementsGenState.offset += newItems.length;
    elementsGenState.hasMore = !!result.hasMore;
    renderElementsList($("elementsGeneratedList"), elementsGenState.items, t("elements.emptyGenerated"), addElementToMainTrack);
  } catch {
    elementsGenState.hasMore = false; // stop retrying this list on error, keep whatever loaded so far
  } finally {
    elementsGenState.loading = false;
  }
}

async function loadMoreUploads() {
  if (elementsUploadState.loading || !elementsUploadState.hasMore) return;
  elementsUploadState.loading = true;
  try {
    // /api/artifacts has no "hasMore"/mime-filter of its own - fetch one extra RAW row to detect
    // whether another page exists, then filter to images client-side. offset always advances by
    // the number of RAW rows consumed (not the filtered image count), so paging stays correct
    // even through a long run of non-image uploads.
    const probeLimit = ELEMENTS_PAGE_SIZE + 1;
    const res = await fetch("/api/artifacts?source=chat_upload&limit=" + probeLimit + "&offset=" + elementsUploadState.offset);
    const json = await res.json();
    const rawRows = (json && json.data) || [];
    elementsUploadState.hasMore = rawRows.length > ELEMENTS_PAGE_SIZE;
    const pageRows = rawRows.slice(0, ELEMENTS_PAGE_SIZE);
    elementsUploadState.offset += pageRows.length;
    const newItems = pageRows
      .filter((row) => (row.mimeType || "").startsWith("image/"))
      .map((row) => ({ url: "/api/shared/view?path=" + encodeURIComponent(row.path), name: row.filename || "upload" }));
    elementsUploadState.items = elementsUploadState.items.concat(newItems);
    renderElementsList($("elementsUploadsList"), elementsUploadState.items, t("elements.emptyUploads"), addElementToMainTrack);
  } catch {
    elementsUploadState.hasMore = false;
  } finally {
    elementsUploadState.loading = false;
  }
}

function loadElementsPanel() {
  if (!state.imageGenAvailable) return;
  elementsGenState.items = []; elementsGenState.offset = 0; elementsGenState.hasMore = true;
  elementsUploadState.items = []; elementsUploadState.offset = 0; elementsUploadState.hasMore = true;
  renderElementsList($("elementsGeneratedList"), [], t("elements.emptyGenerated"), addElementToMainTrack);
  renderElementsList($("elementsUploadsList"), [], t("elements.emptyUploads"), addElementToMainTrack);
  loadMoreGenerated();
  loadMoreUploads();
}

/** Sentinel-based infinite scroll: a 1px marker after each list, observed against the sidebar's
 *  own scroll container (.side-panel-scroll - the individual .item-list divs don't scroll
 *  themselves, the whole sidebar panel does). Fires again automatically once more items are
 *  appended and the sentinel re-enters the rootMargin, no manual scroll-position math needed. */
function initElementsInfiniteScroll() {
  const scrollRoot = document.querySelector(".side-panel-scroll");
  if (!scrollRoot) return;
  const genSentinel = el("div", "elements-scroll-sentinel");
  const uploadSentinel = el("div", "elements-scroll-sentinel");
  $("elementsGeneratedList").insertAdjacentElement("afterend", genSentinel);
  $("elementsUploadsList").insertAdjacentElement("afterend", uploadSentinel);
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (entry.target === genSentinel) loadMoreGenerated();
      else if (entry.target === uploadSentinel) loadMoreUploads();
    }
  }, { root: scrollRoot, rootMargin: "200px" });
  observer.observe(genSentinel);
  observer.observe(uploadSentinel);
}

function initElementsPanel() {
  if (!state.imageGenAvailable) return;
  $("elementsTabBtn").addEventListener("click", loadElementsPanel);
  initElementsInfiniteScroll();
  loadElementsPanel();
}

// =============================================================================================
// Theme
// =============================================================================================

function applyTheme(theme) {
  if (theme === "dark" || theme === "light") {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  const isDark = theme === "dark" || (theme == null && window.matchMedia("(prefers-color-scheme: dark)").matches);
  $("themeToggleBtn").textContent = isDark ? "☀️" : "🌙";
}
function initTheme() {
  let stored = null;
  try { stored = window.localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
  applyTheme(stored);
  $("themeToggleBtn").addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme")
      || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    try { window.localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    applyTheme(next);
  });
}

function initLang() {
  $("langToggleBtn").textContent = window.currentLang.toUpperCase();
  window.applyI18n();
  $("langToggleBtn").addEventListener("click", () => {
    window.setLang(window.currentLang === "de" ? "en" : "de");
    $("langToggleBtn").textContent = window.currentLang.toUpperCase();
    window.applyI18n();
    renderAll();
  });
}

// =============================================================================================
// Global state
// =============================================================================================

const state = {
  projects: [],
  currentProjectId: null,
  clips: [],
  timelineItems: [],   // sorted by .order; type:'clip'|'scene'
  captions: [],
  overlays: [],
  audioTracks: [],
  renders: [],
  pxPerSec: 60,
  selection: null,     // {kind:'main', index} | {kind:'overlay'|'audio'|'caption', id}
  backgroundsCache: [], // session-only cache of uploaded scene background images: {id, filename, original_name, dataUrl, imageGenId?}
  imageGenAvailable: false, // whether the image-gen plugin is installed+enabled (see detectImageGen())
  audioDurations: {},  // audioTrack.id -> probed duration (client-side only, for timeline width)
  pendingAudioUpload: null, // {file, dataUrl, originalName} staged from the Audio panel, not yet uploaded
  renderPollTimer: null,

  // ----- composited ("full") preview - see the big doc comment above renderCompositedPreview() -----
  previewMode: "single",       // "single" | "composited"
  isPlaying: false,
  rafId: null,
  lastFrameWallTime: 0,
  compositedBuilt: false,      // whether #compositedBg/#compositedLayer currently hold live DOM
  compositedActiveItemKey: null, // "clip:<id>" | "scene:<idx>" - which Main-track item is loaded
  compositedVideoEl: null,     // the <video> currently inside #compositedBg, if any
  overlayDomCache: {},         // overlay.id -> persistent DOM element (composited mode)
  captionDomCache: {},         // caption.id -> persistent DOM element (composited mode)
};

// ----- derived timeline math (mirrors tools/video-editor.js so on-screen block widths line up
// with what the backend will actually render) -----------------------------------------------
function speedFactorOf(item) {
  const fx = (item.effects || []).find((e) => e && e.type === "speed");
  if (!fx || fx.value == null) return 1;
  return clamp(Number(fx.value) || 1, 0.5, 2.0);
}
function itemRawDuration(item) {
  if (item.type === "scene") return Math.max(0.05, Number(item.duration_sec) || 1);
  const start = Math.max(0, Number(item.source_start_sec) || 0);
  const end = Math.max(start + 0.05, Number(item.source_end_sec) || start + 0.05);
  return end - start;
}
function itemEffectiveDuration(item) { return itemRawDuration(item) / speedFactorOf(item); }

function mainTrackOffsets() {
  const offsets = [];
  let acc = 0;
  for (const item of state.timelineItems) {
    offsets.push(acc);
    acc += itemEffectiveDuration(item);
  }
  return { offsets, total: acc };
}
function timelineTotalDuration() {
  const mainTotal = mainTrackOffsets().total;
  let maxEnd = mainTotal;
  for (const o of state.overlays) maxEnd = Math.max(maxEnd, Number(o.end_sec) || 0);
  for (const c of state.captions) maxEnd = Math.max(maxEnd, Number(c.end_sec) || 0);
  for (const a of state.audioTracks) {
    const dur = state.audioDurations[a.id] || 4;
    maxEnd = Math.max(maxEnd, (Number(a.start_sec) || 0) + dur);
  }
  return Math.max(10, maxEnd + 2);
}
function clipById(id) { return state.clips.find((c) => c.id === id); }

// =============================================================================================
// Overlay/audio LANES - track_index is a pure UI grouping concept (the backend already
// composites every overlay/audio row into the render regardless of lane, see tools/video-editor.js
// comments), so the number of VISIBLE lanes lives entirely client-side: max(track_index in use)+1,
// plus however many extra empty lanes the user has added this project via "+ Spur" (persisted in
// localStorage per project so it survives reload, same pattern as theme/lang).
// =============================================================================================

const LANE_HEIGHT = 36;

function laneStorageKey(kind) { return "video-editor-extra-lanes-" + kind + "-" + state.currentProjectId; }
function getExtraLaneCount(kind) {
  if (!state.currentProjectId) return 0;
  try { return Number(window.localStorage.getItem(laneStorageKey(kind))) || 0; } catch (e) { return 0; }
}
function bumpLaneCount(kind) {
  if (!state.currentProjectId) return;
  const next = getExtraLaneCount(kind) + 1;
  try { window.localStorage.setItem(laneStorageKey(kind), String(next)); } catch (e) { /* ignore */ }
  renderTimeline();
}
function computeLaneCount(kind, items) {
  const maxUsed = items.reduce((m, it) => Math.max(m, Number(it.track_index) || 0), -1) + 1;
  return Math.max(1, maxUsed) + getExtraLaneCount(kind);
}

// =============================================================================================
// Timeline autosave (batched set_timeline) - main-track edits (trim/order/transition/effects)
// live only in state.timelineItems until debounce-flushed via set_timeline.
// =============================================================================================

function setSaveStatus(text, isError) {
  const readout = $("saveStatusReadout");
  readout.textContent = text || "";
  readout.style.color = isError ? "var(--danger)" : "var(--muted)";
}
const saveTimelineDebounced = debounce(async () => {
  if (!state.currentProjectId) return;
  setSaveStatus(t("timeline.saving"));
  try {
    await invoke({ action: "set_timeline", project_id: state.currentProjectId, items: state.timelineItems });
    setSaveStatus(t("timeline.saved"));
    setTimeout(() => setSaveStatus(""), 1500);
  } catch (err) {
    setSaveStatus(t("timeline.saveError", { msg: err.message || String(err) }), true);
  }
}, 500);
function reorderMainTrack() { state.timelineItems.forEach((it, i) => { it.order = i; }); }
function scheduleTimelineSave() { reorderMainTrack(); saveTimelineDebounced(); renderTimeline(); syncInspectorLive(); syncPreviewLive(); }

// =============================================================================================
// Projects
// =============================================================================================

async function loadProjects() {
  const res = await invoke({ action: "list_projects" });
  state.projects = res.projects || [];
  const select = $("projectSelect");
  if (state.projects.length === 0) {
    select.innerHTML = '<option value="">' + escapeHtml(t("topbar.noProjects")) + "</option>";
    state.currentProjectId = null;
    $("projectNameInput").value = "";
    return;
  }
  if (!state.currentProjectId || !state.projects.some((p) => p.id === state.currentProjectId)) {
    state.currentProjectId = state.projects[0].id;
  }
  select.innerHTML = state.projects.map((p) =>
    '<option value="' + p.id + '"' + (p.id === state.currentProjectId ? " selected" : "") + '>' + escapeHtml(p.name) + "</option>"
  ).join("");
  const current = state.projects.find((p) => p.id === state.currentProjectId);
  $("projectNameInput").value = current ? current.name : "";
}

async function loadAll() {
  state.selection = null;
  await Promise.all([loadClips(), loadTimeline(), loadCaptions(), loadOverlays(), loadAudioTracks(), loadRenders()]);
  renderAll();
}

function renderAll() {
  // Data was just reloaded from the server (project switch, item add/remove, etc.) - force the
  // composited preview's persistent overlay/caption DOM to be rebuilt from scratch next render
  // rather than reused, since the underlying arrays may now contain different items entirely.
  // (Routine edits to an EXISTING item, e.g. dragging or an inspector field, never call
  // renderAll() - they go through commit*Update() + a targeted refresh instead, which is what
  // keeps an in-progress drag's DOM element alive across those.)
  state.compositedBuilt = false;
  renderClipsList();
  renderTimeline();
  renderInspector();
  renderPreview();
  populateSceneLibrary();
}

function initProjectControls() {
  $("projectSelect").addEventListener("change", async (e) => {
    state.currentProjectId = Number(e.target.value) || null;
    await loadAll();
  });

  // Project creation is an inline text field + Enter (not window.prompt()): a native modal
  // dialog can't be styled/tested reliably and is a worse fit for this NLE-style UI anyway.
  // The same field displays the current project's name when one is selected (there is no
  // rename action in the backend tool, so editing an EXISTING project's name here does
  // nothing beyond a local label change until Enter is pressed with different text, which
  // creates a NEW project rather than renaming).
  const nameInput = $("projectNameInput");
  $("newProjectBtn").addEventListener("click", () => {
    nameInput.value = "";
    nameInput.placeholder = t("prompt.newProjectName");
    nameInput.focus();
  });
  nameInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const name = nameInput.value.trim();
    if (!name) return;
    const current = state.projects.find((p) => p.id === state.currentProjectId);
    if (current && current.name === name) { nameInput.blur(); return; }
    const res = await invoke({ action: "add_project", name });
    state.currentProjectId = res.project.id;
    await loadProjects();
    await loadAll();
    nameInput.blur();
  });

  $("deleteProjectBtn").addEventListener("click", async () => {
    if (!state.currentProjectId) return;
    if (!(await confirmDialog(t("confirm.deleteProject")))) return;
    await invoke({ action: "delete_project", id: state.currentProjectId });
    state.currentProjectId = null;
    await loadProjects();
    await loadAll();
  });
}

// =============================================================================================
// Clips panel
// =============================================================================================

async function loadClips() {
  if (!state.currentProjectId) { state.clips = []; return; }
  const res = await invoke({ action: "list_clips", project_id: state.currentProjectId });
  state.clips = res.clips || [];
}

function renderClipsList() {
  const list = $("clipsList");
  if (!state.currentProjectId) {
    list.innerHTML = '<div class="empty-state">' + escapeHtml(t("clips.noProject")) + "</div>";
    return;
  }
  if (state.clips.length === 0) {
    list.innerHTML = '<div class="empty-state">' + escapeHtml(t("clips.empty")) + "</div>";
    return;
  }
  list.innerHTML = state.clips.map((clip) => {
    const thumb = clip.thumbnail_data_url ? '<img src="' + clip.thumbnail_data_url + '">' : "🎞️";
    const hasTranscript = clip.transcript_segments_json && clip.transcript_segments_json !== "[]";
    const ready = clip.status === "ready";
    return (
      '<div class="list-item" data-clip-id="' + clip.id + '"' + (ready ? ' draggable="true"' : "") + '>' +
        '<div class="thumb" data-open="' + clip.id + '">' + thumb + "</div>" +
        '<div class="meta" data-open="' + clip.id + '">' +
          '<div class="name" title="' + escapeHtml(clip.original_name || "") + '"><span class="status-dot ' + clip.status + '"></span>' + escapeHtml(clip.original_name || ("Clip " + clip.id)) + "</div>" +
          '<div class="sub">' + (clip.duration_sec ? fmtSec(clip.duration_sec) : t("clips.status." + clip.status)) + "</div>" +
        "</div>" +
        '<div class="actions">' +
          (ready ? '<button type="button" class="icon-button act-add" data-id="' + clip.id + '" title="' + escapeHtml(t("clips.addTitle")) + '">+</button>' : "") +
        "</div>" +
      "</div>"
    );
  }).join("");

  list.querySelectorAll("[data-open]").forEach((elx) => elx.addEventListener("click", () => openClipDetail(Number(elx.dataset.open))));
  list.querySelectorAll(".act-add").forEach((elx) => elx.addEventListener("click", (e) => {
    e.stopPropagation();
    addClipToMainTrack(Number(elx.dataset.id));
  }));
  list.querySelectorAll(".list-item[draggable='true']").forEach((elx) => {
    elx.addEventListener("dragstart", (e) => {
      elx.classList.add("dragging");
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("application/json", JSON.stringify({ kind: "clip", clipId: Number(elx.dataset.clipId) }));
    });
    elx.addEventListener("dragend", () => elx.classList.remove("dragging"));
  });
}

function addClipToMainTrack(clipId, atOrder) {
  const clip = clipById(clipId);
  if (!clip) return;
  const item = { type: "clip", clip_id: clipId, source_start_sec: 0, source_end_sec: Number(clip.duration_sec) || 1, order: state.timelineItems.length };
  if (atOrder == null || atOrder >= state.timelineItems.length) state.timelineItems.push(item);
  else state.timelineItems.splice(atOrder, 0, item);
  state.selection = { kind: "main", index: state.timelineItems.indexOf(item) };
  scheduleTimelineSave();
}

async function withButtonSpinner(btn, label, fn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>' + escapeHtml(label);
  try { await fn(); } finally { btn.disabled = false; btn.innerHTML = original; }
}

function initClipsPanel() {
  $("uploadInput").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!state.currentProjectId) { showToast(t("clips.needProject"), true); e.target.value = ""; return; }
    const hint = $("uploadHint");
    hint.innerHTML = '<span class="spinner dark"></span>' + escapeHtml(t("clips.uploading"));
    try {
      const base64 = await fileToDataUrl(file);
      const res = await invoke({ action: "add_clip", project_id: state.currentProjectId, video_base64: base64, original_name: file.name });
      if (res.clip && res.clip.status === "error") showToast(t("clips.uploadFailed", { msg: res.clip.error || "?" }), true);
      else showToast(t("clips.uploaded"));
      await loadClips();
      renderClipsList();
    } catch (err) {
      showToast(err.message || String(err), true);
    } finally {
      hint.textContent = t("clips.uploadHint");
      e.target.value = "";
    }
  });
}

async function openClipDetail(clipId) {
  const res = await invoke({ action: "get_clip", id: clipId });
  renderClipDetail(res.clip);
}

function renderClipDetail(clip) {
  const root = $("modalRoot");
  const segments = (() => { try { return JSON.parse(clip.transcript_segments_json || "[]"); } catch { return []; } })();
  const transcriptHtml = segments.length
    ? segments.map((s) => '<div class="transcript-seg"><span class="t">' + fmtSec(s.startSec) + '</span>' + escapeHtml(s.text) + "</div>").join("")
    : '<span style="color:var(--muted)">' + escapeHtml(t("clips.noTranscript")) + "</span>";

  root.innerHTML =
    '<div class="modal-backdrop" id="modalBackdrop">' +
      '<div class="modal">' +
        '<div class="modal-head"><h2>' + escapeHtml(clip.original_name || ("Clip " + clip.id)) + '</h2><button type="button" class="modal-close" id="modalCloseBtn">✕</button></div>' +
        '<div class="modal-body">' +
          (clip.filename ? '<video class="modal-video" controls src="' + dataUrl("clips/" + clip.filename) + '"></video>' : "") +
          '<div style="font-size:11px;color:var(--muted)">' + fmtSec(clip.duration_sec) + (clip.width ? " · " + clip.width + "×" + clip.height : "") + "</div>" +
          '<div class="modal-meta-row" style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button type="button" class="secondary-button" id="modalTranscribeBtn">' + escapeHtml(segments.length ? t("clips.retranscribe") : t("clips.transcribe")) + "</button>" +
            '<button type="button" class="secondary-button" id="modalAnalyzeBtn">' + escapeHtml(t("clips.analyze")) + "</button>" +
            '<button type="button" class="secondary-button" id="modalHighlightBtn">' + escapeHtml(t("clips.highlight")) + "</button>" +
            (segments.length ? '<button type="button" class="secondary-button" id="modalGenCaptionsBtn" data-i18n-title="clips.generateCaptions" title="' + escapeHtml(t("clips.generateCaptions")) + '">' + escapeHtml(t("clips.generateCaptions")) + "</button>" : "") +
          "</div>" +
          '<div><div class="section-label">' + escapeHtml(t("clips.transcript")) + '</div><div class="text-box" id="modalTranscriptBox">' + transcriptHtml + "</div></div>" +
          (clip.ai_summary ? '<div><div class="section-label">' + escapeHtml(t("clips.aiSummary")) + '</div><div class="text-box">' + escapeHtml(clip.ai_summary) + "</div></div>" : "") +
          '<div class="danger-row"><button type="button" class="danger-button" id="modalDeleteBtn" style="margin-left:auto">' + escapeHtml(t("clips.delete")) + "</button></div>" +
        "</div>" +
      "</div>" +
    "</div>";

  $("modalCloseBtn").addEventListener("click", closeModal);
  $("modalBackdrop").addEventListener("click", (e) => { if (e.target.id === "modalBackdrop") closeModal(); });
  $("modalDeleteBtn").addEventListener("click", async () => {
    if (!(await confirmDialog(t("clips.deleteConfirm")))) return;
    await invoke({ action: "delete_clip", id: clip.id });
    closeModal();
    await loadClips();
    renderClipsList();
  });
  $("modalTranscribeBtn").addEventListener("click", async (e) => {
    await withButtonSpinner(e.target, t("clips.transcribing"), async () => {
      try {
        await invoke({ action: "transcribe_clip", clip_id: clip.id });
        showToast(t("clips.transcribeDone"));
        await loadClips();
        await openClipDetail(clip.id);
      } catch (err) { showToast(err.message || String(err), true); }
    });
  });
  $("modalAnalyzeBtn").addEventListener("click", async (e) => {
    await withButtonSpinner(e.target, t("clips.analyzing"), async () => {
      try {
        await invoke({ action: "analyze_clip", clip_id: clip.id });
        showToast(t("clips.analyzeDone"));
        await loadClips();
        await openClipDetail(clip.id);
      } catch (err) { showToast(err.message || String(err), true); }
    });
  });
  $("modalHighlightBtn").addEventListener("click", async (e) => {
    await withButtonSpinner(e.target, t("clips.highlighting"), async () => {
      try {
        const res = await invoke({ action: "suggest_highlight", clip_id: clip.id });
        if (res.hint) showToast(t("clips.highlightHint", { hint: res.hint }));
        else showToast(t("clips.highlightResult", { start: fmtSec(res.start_sec), end: fmtSec(res.end_sec) }));
      } catch (err) { showToast(err.message || String(err), true); }
    });
  });
  const genCaptionsBtn = $("modalGenCaptionsBtn");
  if (genCaptionsBtn) {
    genCaptionsBtn.addEventListener("click", async (e) => {
      if (!state.currentProjectId) return showToast(t("render.needProject"), true);
      // Places the clip's timestamped transcript as captions starting at the current playhead
      // position (adjustable per-caption afterward, same as any other caption on the track).
      const offset = playheadTime;
      await withButtonSpinner(e.target, t("clips.generatingCaptions"), async () => {
        try {
          const res = await invoke({ action: "generate_captions_from_clip", project_id: state.currentProjectId, clip_id: clip.id, timeline_offset_sec: offset });
          showToast(t("clips.captionsGenerated", { count: res.count, offset: fmtSec(offset) }));
          closeModal();
          await loadCaptions();
          renderAll();
        } catch (err) { showToast(err.message || String(err), true); }
      });
    });
  }
}
function closeModal() { $("modalRoot").innerHTML = ""; }

// =============================================================================================
// Scenes panel
// =============================================================================================

function currentSceneConfig() {
  const kind = $("sceneKindSelect").value;
  const duration = Number($("sceneDurationInput").value) || 3;
  if (kind === "color") {
    return { duration, background: { kind: "color", value: $("sceneColorInput") ? $("sceneColorInput").value : "#111318" } };
  }
  if (kind === "gradient") {
    return {
      duration,
      background: {
        kind: "gradient",
        value: {
          from: $("sceneGradFromInput") ? $("sceneGradFromInput").value : "#0ea5e9",
          to: $("sceneGradToInput") ? $("sceneGradToInput").value : "#8b5cf6",
          direction: $("sceneGradDirInput") ? $("sceneGradDirInput").value : "horizontal",
        },
      },
    };
  }
  // image
  const bgId = $("sceneDragConfig").dataset.bgId;
  return { duration, background: { kind: "image", value: bgId ? Number(bgId) : null } };
}

function renderSceneKindFields() {
  const kind = $("sceneKindSelect").value;
  const wrap = $("sceneKindFields");
  if (kind === "color") {
    wrap.innerHTML = '<div class="form-row"><label data-i18n="scenes.color">Farbe</label><input type="color" class="form-control small" id="sceneColorInput" value="#111318"></div>';
  } else if (kind === "gradient") {
    wrap.innerHTML =
      '<div class="form-row-inline">' +
        '<div class="form-row"><label data-i18n="scenes.from">Von</label><input type="color" class="form-control small" id="sceneGradFromInput" value="#0ea5e9"></div>' +
        '<div class="form-row"><label data-i18n="scenes.to">Nach</label><input type="color" class="form-control small" id="sceneGradToInput" value="#8b5cf6"></div>' +
      "</div>" +
      '<div class="form-row"><label data-i18n="scenes.direction">Richtung</label>' +
        '<select class="form-control small" id="sceneGradDirInput">' +
          '<option value="horizontal" data-i18n="scenes.direction.horizontal">Horizontal</option>' +
          '<option value="vertical" data-i18n="scenes.direction.vertical">Vertikal</option>' +
        "</select></div>";
  } else {
    wrap.innerHTML =
      '<div class="form-row"><label data-i18n="scenes.image">Bild wählen…</label><input type="file" accept="image/*" class="form-control small" id="sceneImageInput"></div>';
  }
  window.applyI18n(wrap);
  wrap.querySelectorAll("input,select").forEach((inp) => {
    inp.addEventListener("input", updateScenePreview);
    if (inp.tagName === "SELECT") inp.addEventListener("change", updateScenePreview);
  });
  if (kind === "image") {
    $("sceneImageInput").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file || !state.currentProjectId) return;
      try {
        const base64 = await fileToDataUrl(file);
        const res = await invoke({ action: "add_scene_background_image", project_id: state.currentProjectId, image_base64: base64, original_name: file.name });
        const bg = res.background;
        state.backgroundsCache.push({ id: bg.id, filename: bg.filename, original_name: bg.original_name || file.name, dataUrl: base64 });
        $("sceneDragConfig").dataset.bgId = bg.id;
        showToast(t("scenes.imageUploaded"));
        updateScenePreview();
        populateSceneLibrary();
      } catch (err) { showToast(err.message || String(err), true); }
    });
    const ref = findConsistencyReference(null);
    renderAiImageControl(wrap, {
      referenceImageGenId: ref && ref.imageGenId,
      referenceLabel: ref && ref.name,
      onCreated: (bg, imageGenId) => {
        state.backgroundsCache.push({ id: bg.id, filename: bg.filename, original_name: "ai-generated.png", dataUrl: dataUrl("backgrounds/" + bg.filename), imageGenId });
        $("sceneDragConfig").dataset.bgId = bg.id;
        showToast("Bild generiert");
        updateScenePreview();
        populateSceneLibrary();
      },
    });
  }
  updateScenePreview();
}

function updateScenePreview() {
  const cfg = currentSceneConfig();
  const swatch = $("scenePreviewSwatch");
  const sub = $("sceneDragSub");
  if (cfg.background.kind === "color") {
    swatch.style.background = cfg.background.value;
    swatch.style.backgroundImage = "";
  } else if (cfg.background.kind === "gradient") {
    const dir = cfg.background.value.direction === "vertical" ? "to bottom" : "to right";
    swatch.style.background = `linear-gradient(${dir}, ${cfg.background.value.from}, ${cfg.background.value.to})`;
  } else {
    const bg = state.backgroundsCache.find((b) => String(b.id) === String(cfg.background.value));
    swatch.style.background = "var(--surface-3)";
    swatch.style.backgroundImage = bg ? `url(${bg.dataUrl})` : "";
  }
  sub.textContent = t("tabs.scenes") + " · " + fmtSec(cfg.duration);
}

function addSceneToMainTrack(cfg, atOrder) {
  if (!cfg.background) return;
  if (cfg.background.kind === "image" && !cfg.background.value) { showToast(t("scenes.needImage"), true); return; }
  const item = { type: "scene", duration_sec: cfg.duration, background: cfg.background, order: state.timelineItems.length };
  if (atOrder == null || atOrder >= state.timelineItems.length) state.timelineItems.push(item);
  else state.timelineItems.splice(atOrder, 0, item);
  state.selection = { kind: "main", index: state.timelineItems.indexOf(item) };
  scheduleTimelineSave();
}

function populateSceneLibrary() {
  const section = $("sceneLibrarySection");
  const list = $("sceneLibraryList");
  if (state.backgroundsCache.length === 0) { section.style.display = "none"; return; }
  section.style.display = "block";
  list.innerHTML = state.backgroundsCache.map((bg) =>
    '<div class="list-item" data-bg-id="' + bg.id + '">' +
      '<div class="thumb"><img src="' + bg.dataUrl + '"></div>' +
      '<div class="meta"><div class="name" title="' + escapeHtml(bg.original_name) + '">' + escapeHtml(bg.original_name) + "</div></div>" +
      '<div class="actions"><button type="button" class="icon-button lib-use" data-id="' + bg.id + '">✓</button>' +
        (state.imageGenAvailable ? '<button type="button" class="icon-button lib-modify" data-id="' + bg.id + '" title="Mit KI veraendern">✨</button>' : "") +
      "</div>" +
    "</div>"
  ).join("");
  list.querySelectorAll(".lib-use").forEach((btn) => btn.addEventListener("click", () => {
    $("sceneKindSelect").value = "image";
    renderSceneKindFields();
    $("sceneDragConfig").dataset.bgId = btn.dataset.id;
    updateScenePreview();
  }));
  list.querySelectorAll(".lib-modify").forEach((btn) => btn.addEventListener("click", () => {
    const bg = state.backgroundsCache.find((b) => String(b.id) === btn.dataset.id);
    const row = btn.closest(".list-item");
    if (!bg || !row) return;
    const existing = row.querySelector(".lib-modify-form");
    if (existing) { existing.remove(); return; }
    row.style.flexWrap = "wrap";
    const wrap = el("div", "lib-modify-form");
    wrap.style.flexBasis = "100%";
    row.appendChild(wrap);
    renderModifyBackgroundControl(wrap, bg, (newBg, imageGenId) => {
      state.backgroundsCache.push({ id: newBg.id, filename: newBg.filename, original_name: "ai-generated.png", dataUrl: dataUrl("backgrounds/" + newBg.filename), imageGenId });
      populateSceneLibrary();
    });
  }));
}

function initScenesPanel() {
  $("sceneKindSelect").addEventListener("change", renderSceneKindFields);
  $("sceneDurationInput").addEventListener("input", updateScenePreview);
  renderSceneKindFields();

  $("addSceneBtn").addEventListener("click", () => {
    if (!state.currentProjectId) return showToast(t("scenes.needProject"), true);
    addSceneToMainTrack(currentSceneConfig());
  });

  $("sceneDragConfig").addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("application/json", JSON.stringify({ kind: "scene", scene: currentSceneConfig() }));
  });

  $("titleCardText") && $("addTitleCardBtn").addEventListener("click", async () => {
    if (!state.currentProjectId) return showToast(t("scenes.needProject"), true);
    const text = $("titleCardText").value.trim();
    if (!text) return showToast(t("text.needContent"), true);
    const duration = Number($("titleCardDuration").value) || 3;
    try {
      await invoke({ action: "add_title_card", project_id: state.currentProjectId, text, duration_sec: duration });
      showToast(t("scenes.titleCardAdded"));
      $("titleCardText").value = "";
      await loadTimeline();
      await loadOverlays();
      renderAll();
    } catch (err) { showToast(err.message || String(err), true); }
  });
}

// =============================================================================================
// Text panel
// =============================================================================================

function currentTextConfig() {
  return {
    content: $("textContentInput").value || t("text.content"),
    font_size: Number($("textFontSizeInput").value) || 32,
    color: $("textColorInput").value,
    align: $("textAlignInput").value,
    background_color: $("textBgEnableInput").checked ? $("textBgColorInput").value : undefined,
  };
}

function addOverlayToTrack(type, props, startSec, atX, atY, trackIndex) {
  if (!state.currentProjectId) return showToast(t(type === "text" ? "text.needProject" : "shapes.needProject"), true);
  const start = Math.max(0, startSec != null ? startSec : 0);
  const defaultDur = type === "text" ? 3 : 2.5;
  const width = type === "shape" ? 20 : 60;
  const height = type === "shape" ? 20 : 14;
  const x = atX != null ? atX : (type === "text" ? 20 : 40);
  const y = atY != null ? atY : (type === "text" ? 42 : 40);
  invoke({
    action: "add_overlay", project_id: state.currentProjectId, type,
    start_sec: start, end_sec: start + defaultDur, x, y, width, height, z_index: state.overlays.length,
    track_index: trackIndex || 0, props,
  }).then(async (res) => {
    await loadOverlays();
    state.selection = { kind: "overlay", id: res.overlay.id };
    renderAll();
  }).catch((err) => showToast(err.message || String(err), true));
}

function initTextPanel() {
  ["textContentInput", "textFontSizeInput", "textColorInput", "textAlignInput", "textBgEnableInput", "textBgColorInput"].forEach((id) => {
    $(id).addEventListener("input", () => { $("textDragName").textContent = $("textContentInput").value || t("text.title"); });
  });
  $("addTextBtn").addEventListener("click", () => {
    const cfg = currentTextConfig();
    if (!cfg.content.trim()) return showToast(t("text.needContent"), true);
    addOverlayToTrack("text", cfg, 0);
  });
  $("textDragConfig").addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("application/json", JSON.stringify({ kind: "overlay-text", props: currentTextConfig() }));
  });
}

// =============================================================================================
// Shapes panel
// =============================================================================================

function currentShapeConfig() {
  return {
    shape_type: $("shapeTypeInput").value,
    color: $("shapeColorInput").value,
    opacity: Number($("shapeOpacityInput").value) || 0.7,
    stroke_width: $("shapeTypeInput").value === "rect" ? (Number($("shapeStrokeInput").value) || 0) : undefined,
  };
}

function initShapesPanel() {
  $("shapeTypeInput").addEventListener("change", () => {
    const isRect = $("shapeTypeInput").value === "rect";
    $("shapeStrokeRow").style.display = isRect ? "" : "none";
    $("shapeDragThumb").textContent = isRect ? "▭" : "⬤";
  });
  $("addShapeBtn").addEventListener("click", () => addOverlayToTrack("shape", currentShapeConfig(), 0));
  $("shapeDragConfig").addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("application/json", JSON.stringify({ kind: "overlay-shape", props: currentShapeConfig() }));
  });
}

// =============================================================================================
// Audio panel
// =============================================================================================

function initAudioPanel() {
  $("audioFileInput").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const dataUrlStr = await fileToDataUrl(file);
    state.pendingAudioUpload = { file, dataUrl: dataUrlStr, originalName: file.name };
    $("audioDragConfig").style.display = "flex";
    $("audioDragName").textContent = file.name;
  });

  $("addAudioBtn").addEventListener("click", () => uploadPendingAudio(0));
  $("audioDragConfig").addEventListener("dragstart", (e) => {
    if (!state.pendingAudioUpload) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("application/json", JSON.stringify({ kind: "audio" }));
  });
}

async function uploadPendingAudio(startSec, trackIndex) {
  if (!state.currentProjectId) return showToast(t("audio.needProject"), true);
  if (!state.pendingAudioUpload) return showToast(t("audio.needFile"), true);
  const volume = Number($("audioVolumeInput").value) || 1;
  const btn = $("addAudioBtn");
  await withButtonSpinner(btn, t("audio.uploading"), async () => {
    try {
      const res = await invoke({
        action: "add_audio_track", project_id: state.currentProjectId,
        audio_base64: state.pendingAudioUpload.dataUrl, start_sec: Math.max(0, startSec || 0), volume,
        track_index: trackIndex || 0, original_name: state.pendingAudioUpload.originalName,
      });
      showToast(t("audio.added"));
      await loadAudioTracks();
      state.selection = { kind: "audio", id: res.audio_track.id };
      renderAll();
    } catch (err) { showToast(err.message || String(err), true); }
  });
}

// =============================================================================================
// Timeline data loading
// =============================================================================================

async function loadTimeline() {
  if (!state.currentProjectId) { state.timelineItems = []; return; }
  const res = await invoke({ action: "get_timeline", project_id: state.currentProjectId });
  state.timelineItems = (res.items || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
async function loadCaptions() {
  if (!state.currentProjectId) { state.captions = []; return; }
  const res = await invoke({ action: "list_captions", project_id: state.currentProjectId });
  state.captions = res.captions || [];
}
async function loadOverlays() {
  if (!state.currentProjectId) { state.overlays = []; return; }
  const res = await invoke({ action: "list_overlays", project_id: state.currentProjectId });
  state.overlays = res.overlays || [];
}
async function loadAudioTracks() {
  if (!state.currentProjectId) { state.audioTracks = []; return; }
  const res = await invoke({ action: "list_audio_tracks", project_id: state.currentProjectId });
  state.audioTracks = res.audio_tracks || [];
  state.audioTracks.forEach(probeAudioDuration);
}
function probeAudioDuration(track) {
  if (state.audioDurations[track.id] != null || !track.filename) return;
  const audio = new Audio();
  audio.preload = "metadata";
  audio.src = dataUrl("audio/" + track.filename);
  audio.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(audio.duration)) {
      state.audioDurations[track.id] = audio.duration;
      renderTimeline();
    }
  });
}

// =============================================================================================
// Timeline rendering
// =============================================================================================

function initZoom() {
  const slider = $("zoomSlider");
  slider.value = String(state.pxPerSec);
  slider.addEventListener("input", () => {
    state.pxPerSec = Number(slider.value) || 60;
    renderTimeline();
  });
}

function renderRuler(totalDuration) {
  const ruler = $("ruler");
  ruler.innerHTML = "";
  ruler.style.width = (totalDuration * state.pxPerSec) + "px";
  // choose a "nice" tick step so labels don't collide at any zoom level
  const minPxBetweenTicks = 64;
  const rawStep = minPxBetweenTicks / state.pxPerSec;
  const niceSteps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = niceSteps.find((s) => s >= rawStep) || 300;
  for (let s = 0; s <= totalDuration; s += step) {
    const tick = el("div", "ruler-tick");
    tick.style.left = (s * state.pxPerSec) + "px";
    ruler.appendChild(tick);
    const label = el("div", "ruler-tick-label", (Math.round(s * 10) / 10) + "s");
    label.style.left = (s * state.pxPerSec) + "px";
    ruler.appendChild(label);
  }
  ruler.onclick = (e) => {
    if (e.target !== ruler) return;
    const rect = ruler.getBoundingClientRect();
    const sec = (e.clientX - rect.left) / state.pxPerSec;
    setPlayheadTime(Math.max(0, sec));
    refreshCompositedIfActive();
  };
}

let playheadTime = 0;
function setPlayheadTime(sec) {
  playheadTime = sec;
  $("playhead").style.left = (sec * state.pxPerSec) + "px";
  $("timeReadout").textContent = fmtSec(sec);
}

function renderTimeline() {
  const totalDuration = timelineTotalDuration();
  const contentWidth = totalDuration * state.pxPerSec;
  $("timelineContent").style.width = contentWidth + "px";
  renderRuler(totalDuration);
  $("playhead").style.left = (playheadTime * state.pxPerSec) + "px";

  // Overlay/audio lane counts drive both the track's own height and its label cell's height (kept
  // in lockstep so the two flex columns - .track-labels and .tracks-scroll - stay row-aligned).
  const overlayLanes = computeLaneCount("overlay", state.overlays);
  const audioLanes = computeLaneCount("audio", state.audioTracks);
  const overlaysHeight = overlayLanes * LANE_HEIGHT;
  const audioHeight = audioLanes * LANE_HEIGHT;
  $("trackOverlays").style.height = overlaysHeight + "px";
  $("overlaysTrackLabel").style.height = overlaysHeight + "px";
  $("trackAudio").style.height = audioHeight + "px";
  $("audioTrackLabel").style.height = audioHeight + "px";

  renderMainTrack(contentWidth);
  renderOverlaysTrack(contentWidth, overlayLanes);
  renderAudioTrack(contentWidth, audioLanes);
  renderCaptionsTrack(contentWidth);
}

function isSelected(kind, idOrIndex) {
  return !!state.selection && state.selection.kind === kind &&
    (kind === "main" ? state.selection.index === idOrIndex : state.selection.id === idOrIndex);
}

function selectItem(kind, idOrIndex) {
  state.selection = kind === "main" ? { kind, index: idOrIndex } : { kind, id: idOrIndex };
  renderTimeline();
  renderInspector();
  renderPreview();
}

// ----- Main track (clips + scenes) -----
function renderMainTrack(minWidth) {
  const track = $("trackMain");
  track.innerHTML = "";
  track.style.minWidth = minWidth + "px";
  const { offsets } = mainTrackOffsets();

  state.timelineItems.forEach((item, idx) => {
    const left = offsets[idx] * state.pxPerSec;
    const width = Math.max(6, itemEffectiveDuration(item) * state.pxPerSec);
    const isScene = item.type === "scene";
    const block = el("div", "tl-block " + (isScene ? "scene-block" : "clip-block") + (isSelected("main", idx) ? " selected" : ""));
    block.style.left = left + "px";
    block.style.width = width + "px";
    block.draggable = true;
    block.dataset.idx = String(idx);

    if (!isScene) {
      const clip = clipById(item.clip_id);
      if (clip && clip.thumbnail_data_url) {
        const img = el("img", "tl-thumb");
        img.src = clip.thumbnail_data_url;
        block.appendChild(img);
      }
      const label = el("span", "tl-label", escapeHtml(clip ? (clip.original_name || ("Clip " + clip.id)) : ("#" + item.clip_id)));
      block.appendChild(label);
    } else {
      const bg = item.background || {};
      if (bg.kind === "color") block.style.background = bg.value;
      else if (bg.kind === "gradient") {
        const dir = bg.value && bg.value.direction === "vertical" ? "to bottom" : "to right";
        block.style.background = `linear-gradient(${dir}, ${(bg.value && bg.value.from) || "#0ea5e9"}, ${(bg.value && bg.value.to) || "#8b5cf6"})`;
      } else block.style.background = "var(--scene-fill)";
      const label = el("span", "tl-label", "🎬 " + escapeHtml(t("timeline.scene")));
      block.appendChild(label);
    }

    const transition = item.transition_out;
    if (transition && transition.type !== "none" && idx < state.timelineItems.length - 1) {
      block.appendChild(el("div", "transition-mark"));
    }

    const leftHandle = el("div", "resize-handle left");
    const rightHandle = el("div", "resize-handle right");
    block.appendChild(leftHandle);
    block.appendChild(rightHandle);

    block.addEventListener("click", (e) => { if (e.target === leftHandle || e.target === rightHandle) return; selectItem("main", idx); });
    block.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "reorder:" + idx);
      block.classList.add("dragging");
    });
    block.addEventListener("dragend", () => block.classList.remove("dragging"));

    attachResizeHandle(leftHandle, item, "left");
    attachResizeHandle(rightHandle, item, "right");

    track.appendChild(block);
  });

  track.ondragover = (e) => {
    const isReorder = Array.from(e.dataTransfer.types).includes("text/plain");
    e.preventDefault();
    e.dataTransfer.dropEffect = isReorder ? "move" : "copy";
    track.classList.add("drop-target");
  };
  track.ondragleave = () => track.classList.remove("drop-target");
  track.ondrop = (e) => {
    e.preventDefault();
    track.classList.remove("drop-target");
    const rect = track.getBoundingClientRect();
    const scrollLeft = $("tracksScroll").scrollLeft;
    const dropX = e.clientX - rect.left + scrollLeft;
    const dropSec = Math.max(0, dropX / state.pxPerSec);
    const targetIdx = mainTrackIndexForTime(dropSec);

    const reorderText = e.dataTransfer.getData("text/plain");
    if (reorderText && reorderText.startsWith("reorder:")) {
      const fromIdx = Number(reorderText.split(":")[1]);
      if (Number.isFinite(fromIdx)) moveMainTrackItem(fromIdx, targetIdx);
      return;
    }
    const json = e.dataTransfer.getData("application/json");
    if (!json) return;
    try {
      const payload = JSON.parse(json);
      if (payload.kind === "clip") addClipToMainTrack(payload.clipId, targetIdx);
      else if (payload.kind === "scene") addSceneToMainTrack(payload.scene, targetIdx);
      else if (payload.kind === "element") addElementToMainTrack(payload.url, targetIdx, null);
    } catch (err) { /* ignore malformed payload */ }
  };
}

function mainTrackIndexForTime(sec) {
  const { offsets } = mainTrackOffsets();
  for (let i = 0; i < state.timelineItems.length; i++) {
    const dur = itemEffectiveDuration(state.timelineItems[i]);
    if (sec < offsets[i] + dur / 2) return i;
  }
  return state.timelineItems.length;
}
function moveMainTrackItem(fromIdx, toIdx) {
  if (fromIdx === toIdx || fromIdx + 1 === toIdx) return;
  const [item] = state.timelineItems.splice(fromIdx, 1);
  const adjustedTo = toIdx > fromIdx ? toIdx - 1 : toIdx;
  state.timelineItems.splice(clamp(adjustedTo, 0, state.timelineItems.length), 0, item);
  if (state.selection && state.selection.kind === "main") state.selection.index = state.timelineItems.indexOf(item);
  scheduleTimelineSave();
}

function attachResizeHandle(handle, item, side) {
  handle.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const isScene = item.type === "scene";
    const startVal = isScene ? item.duration_sec : (side === "left" ? item.source_start_sec : item.source_end_sec);
    const clip = isScene ? null : clipById(item.clip_id);
    const maxDur = clip ? Number(clip.duration_sec) || 999 : 999999;

    function onMove(ev) {
      const deltaSec = (ev.clientX - startX) / state.pxPerSec;
      if (isScene) {
        item.duration_sec = Math.max(0.2, startVal + deltaSec);
      } else if (side === "left") {
        item.source_start_sec = clamp(startVal + deltaSec, 0, Math.max(0, item.source_end_sec - 0.1));
      } else {
        item.source_end_sec = clamp(startVal + deltaSec, item.source_start_sec + 0.1, maxDur);
      }
      renderTimeline();
      if (state.selection && state.selection.kind === "main") syncInspectorLive();
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      scheduleTimelineSave();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ----- Overlay / audio / caption tracks (secondary, per-item CRUD, not part of set_timeline) -----
// `opts.lanes` (overlays/audio only) is the visible lane count; items position by BOTH time (left)
// and lane (top), and dragging can change lane (vertical) in addition to start_sec (horizontal).
// Captions have no lanes (single row, same as before - the backend schema only added track_index
// to overlays/audio_tracks).
function renderSecondaryTrack(trackId, items, kindKey, blockClassBase, opts) {
  const track = $(trackId);
  // keep the corner add-fab (captions track) if present
  const fab = track.querySelector(".track-add-fab");
  track.innerHTML = "";
  if (fab) track.appendChild(fab);

  const hasLanes = opts.lanes != null;

  items.forEach((itm) => {
    const start = Number(itm.start_sec) || 0;
    const durationSec = opts.getDuration(itm);
    const left = start * state.pxPerSec;
    const width = Math.max(16, durationSec * state.pxPerSec);
    const selected = isSelected(kindKey, itm.id);
    const block = el("div", "tl-block " + blockClassBase + (selected ? " selected" : ""));
    block.style.left = left + "px";
    block.style.width = width + "px";
    if (hasLanes) {
      const lane = clamp(Number(itm.track_index) || 0, 0, opts.lanes - 1);
      block.style.top = (lane * LANE_HEIGHT + 3) + "px";
      block.style.height = (LANE_HEIGHT - 6) + "px";
    }
    block.appendChild(el("span", "tl-label", opts.label(itm)));

    let leftHandle = null, rightHandle = null;
    if (opts.resizable) {
      leftHandle = el("div", "resize-handle left");
      rightHandle = el("div", "resize-handle right");
      block.appendChild(leftHandle);
      block.appendChild(rightHandle);
      attachSecondaryResize(leftHandle, itm, "left", opts);
      attachSecondaryResize(rightHandle, itm, "right", opts);
    }

    block.addEventListener("click", (e) => {
      if (e.target === leftHandle || e.target === rightHandle) return;
      selectItem(kindKey, itm.id);
    });
    attachSecondaryDrag(block, itm, opts, [leftHandle, rightHandle].filter(Boolean));

    track.appendChild(block);
  });

  track.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; track.classList.add("drop-target"); };
  track.ondragleave = () => track.classList.remove("drop-target");
  track.ondrop = (e) => {
    e.preventDefault();
    track.classList.remove("drop-target");
    const json = e.dataTransfer.getData("application/json");
    if (!json) return;
    const rect = track.getBoundingClientRect();
    const scrollLeft = $("tracksScroll").scrollLeft;
    const dropSec = Math.max(0, (e.clientX - rect.left + scrollLeft) / state.pxPerSec);
    const dropLane = hasLanes ? clamp(Math.floor((e.clientY - rect.top) / LANE_HEIGHT), 0, opts.lanes - 1) : 0;
    try {
      const payload = JSON.parse(json);
      opts.onDrop && opts.onDrop(payload, dropSec, dropLane);
    } catch (err) { /* ignore */ }
  };
}

function attachSecondaryDrag(block, itm, opts, excludeEls) {
  block.addEventListener("mousedown", (e) => {
    if (excludeEls.includes(e.target)) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startSec = Number(itm.start_sec) || 0;
    const startLane = Number(itm.track_index) || 0;
    const dur = opts.linkedEnd ? opts.getDuration(itm) : 0;
    const hasLanes = opts.lanes != null;
    function onMove(ev) {
      const deltaSec = (ev.clientX - startX) / state.pxPerSec;
      itm.start_sec = Math.max(0, startSec + deltaSec);
      if (opts.linkedEnd) itm.end_sec = itm.start_sec + dur;
      block.style.left = (itm.start_sec * state.pxPerSec) + "px";
      if (hasLanes) {
        const deltaLane = Math.round((ev.clientY - startY) / LANE_HEIGHT);
        itm.track_index = clamp(startLane + deltaLane, 0, opts.lanes - 1);
        block.style.top = (itm.track_index * LANE_HEIGHT + 3) + "px";
      }
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      opts.onCommit(itm);
      if (hasLanes && itm.track_index !== startLane) renderTimeline();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
function attachSecondaryResize(handle, itm, side, opts) {
  handle.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startStart = Number(itm.start_sec) || 0;
    const startEnd = Number(itm.end_sec) || startStart + 1;
    function onMove(ev) {
      const deltaSec = (ev.clientX - startX) / state.pxPerSec;
      if (side === "left") itm.start_sec = clamp(startStart + deltaSec, 0, startEnd - 0.1);
      else itm.end_sec = clamp(startEnd + deltaSec, startStart + 0.1, 100000);
      renderTimeline();
      if (state.selection && state.selection.kind === opts.kindKey && state.selection.id === itm.id) syncInspectorLive();
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      opts.onCommit(itm);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function renderOverlaysTrack(minWidth, lanes) {
  const track = $("trackOverlays");
  track.style.minWidth = minWidth + "px";
  renderSecondaryTrack("trackOverlays", state.overlays, "overlay", "overlay-block", {
    kindKey: "overlay",
    resizable: true,
    linkedEnd: true,
    lanes,
    getDuration: (o) => Math.max(0.2, (Number(o.end_sec) || 0) - (Number(o.start_sec) || 0)),
    label: (o) => (o.type === "text" ? "🔤 " + escapeHtml(o.props.content || "") : o.type === "image" ? "🖼️ " + t("inspector.overlay.image") : "▭ " + escapeHtml(o.props.shape_type || "shape")),
    onCommit: (o) => commitOverlayUpdate(o),
    onDrop: (payload, sec, lane) => {
      if (payload.kind === "overlay-text") addOverlayToTrack("text", payload.props, sec, null, null, lane);
      else if (payload.kind === "overlay-shape") addOverlayToTrack("shape", payload.props, sec, null, null, lane);
      else if (payload.kind === "element") addElementToOverlayTrack(payload.url, sec, lane, null);
    },
  });
}
function renderAudioTrack(minWidth, lanes) {
  const track = $("trackAudio");
  track.style.minWidth = minWidth + "px";
  renderSecondaryTrack("trackAudio", state.audioTracks, "audio", "audio-block", {
    kindKey: "audio",
    resizable: false,
    lanes,
    getDuration: (a) => state.audioDurations[a.id] || 4,
    label: (a) => "🎵 " + escapeHtml(a.original_name || a.filename || ""),
    onCommit: (a) => commitAudioUpdate(a),
    onDrop: (payload, sec, lane) => { if (payload.kind === "audio") uploadPendingAudio(sec, lane); },
  });
}
function renderCaptionsTrack(minWidth) {
  const track = $("trackCaptions");
  track.style.minWidth = minWidth + "px";
  renderSecondaryTrack("trackCaptions", state.captions, "caption", "caption-block", {
    kindKey: "caption",
    resizable: true,
    linkedEnd: true,
    getDuration: (c) => Math.max(0.2, (Number(c.end_sec) || 0) - (Number(c.start_sec) || 0)),
    label: (c) => escapeHtml(c.text || ""),
    onCommit: (c) => commitCaptionUpdate(c),
    onDrop: () => {},
  });
}

const commitOverlayUpdate = debounce((o) => {
  invoke({ action: "update_overlay", id: o.id, start_sec: o.start_sec, end_sec: o.end_sec, x: o.x, y: o.y, width: o.width, height: o.height, z_index: o.z_index, track_index: o.track_index, props: o.props })
    .catch((err) => showToast(err.message || String(err), true));
}, 250);
const commitAudioUpdate = debounce((a) => {
  invoke({ action: "update_audio_track", id: a.id, start_sec: a.start_sec, volume: a.volume, track_index: a.track_index })
    .catch((err) => showToast(err.message || String(err), true));
}, 250);
const commitCaptionUpdate = debounce((c) => {
  invoke({ action: "update_caption", id: c.id, start_sec: c.start_sec, end_sec: c.end_sec, text: c.text, pos_x: c.pos_x, pos_y: c.pos_y })
    .catch((err) => showToast(err.message || String(err), true));
}, 250);

function initCaptionAddFab() {
  $("captionAddFab").addEventListener("click", async () => {
    if (!state.currentProjectId) return showToast(t("render.needProject"), true);
    const start = playheadTime;
    try {
      const res = await invoke({ action: "add_caption", project_id: state.currentProjectId, start_sec: start, end_sec: start + 2, text: "…" });
      await loadCaptions();
      state.selection = { kind: "caption", id: res.caption.id };
      renderAll();
    } catch (err) { showToast(err.message || String(err), true); }
  });
}

// =============================================================================================
// Preview (center panel) - per-item preview only, see preview.scopeNote in i18n.
// =============================================================================================

function renderPreview() {
  if (state.previewMode === "composited") { renderCompositedPreview(); return; }

  const frame = $("previewFrame");
  const scrubber = $("trimScrubber");
  frame.innerHTML = "";
  scrubber.style.display = "none";

  if (!state.selection) {
    frame.appendChild(buildPreviewEmpty());
    return;
  }
  if (state.selection.kind === "main") {
    const item = state.timelineItems[state.selection.index];
    if (!item) { frame.appendChild(buildPreviewEmpty()); return; }
    if (item.type === "clip") renderClipPreview(item, frame, scrubber);
    else renderScenePreview(item, frame);
    return;
  }
  if (state.selection.kind === "overlay") {
    const o = state.overlays.find((x) => x.id === state.selection.id);
    if (!o) { frame.appendChild(buildPreviewEmpty()); return; }
    renderOverlayPreview(o, frame);
    return;
  }
  if (state.selection.kind === "audio") {
    const a = state.audioTracks.find((x) => x.id === state.selection.id);
    if (!a) { frame.appendChild(buildPreviewEmpty()); return; }
    renderAudioPreview(a, frame);
    return;
  }
  if (state.selection.kind === "caption") {
    const c = state.captions.find((x) => x.id === state.selection.id);
    if (!c) { frame.appendChild(buildPreviewEmpty()); return; }
    renderCaptionPreview(c, frame);
  }
}
function syncPreviewLive() {
  if (state.previewMode === "composited") { refreshCompositedIfActive(); return; }
  if (state.selection && state.selection.kind === "main") renderPreview();
}

function buildPreviewEmpty() {
  const wrap = el("div", "preview-empty");
  wrap.innerHTML = '<span class="big">🎬</span><h3>' + escapeHtml(t("preview.empty.title")) + "</h3><p>" + escapeHtml(t("preview.empty.body")) + "</p>";
  return wrap;
}

let previewVideoEl = null;
function renderClipPreview(item, frame, scrubber) {
  const clip = clipById(item.clip_id);
  if (!clip || !clip.filename) { frame.appendChild(buildPreviewEmpty()); return; }
  const video = document.createElement("video");
  video.controls = true;
  video.src = dataUrl("clips/" + clip.filename);
  frame.appendChild(video);
  previewVideoEl = video;

  scrubber.style.display = "block";
  const duration = Number(clip.duration_sec) || 1;
  const update = () => {
    const startPct = clamp((item.source_start_sec / duration) * 100, 0, 100);
    const endPct = clamp((item.source_end_sec / duration) * 100, 0, 100);
    $("trimRange").style.left = startPct + "%";
    $("trimRange").style.right = (100 - endPct) + "%";
    $("trimHandleLeft").style.left = "calc(" + startPct + "% - 5px)";
    $("trimHandleRight").style.left = "calc(" + endPct + "% - 5px)";
    $("trimLabelStart").textContent = t("preview.clip.trimStart") + ": " + fmtSec(item.source_start_sec);
    $("trimLabelEnd").textContent = t("preview.clip.trimEnd") + ": " + fmtSec(item.source_end_sec);
  };
  update();

  video.addEventListener("loadedmetadata", () => { video.currentTime = item.source_start_sec || 0; });

  function bindHandle(handleEl, side) {
    handleEl.onmousedown = (e) => {
      e.preventDefault();
      const track = $("trimTrack");
      function onMove(ev) {
        const rect = track.getBoundingClientRect();
        const pct = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
        const sec = pct * duration;
        if (side === "left") item.source_start_sec = clamp(sec, 0, item.source_end_sec - 0.1);
        else item.source_end_sec = clamp(sec, item.source_start_sec + 0.1, duration);
        update();
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        scheduleTimelineSave();
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
  }
  bindHandle($("trimHandleLeft"), "left");
  bindHandle($("trimHandleRight"), "right");
  $("trimTrack").onclick = (e) => {
    if (e.target !== $("trimTrack")) return;
    const rect = $("trimTrack").getBoundingClientRect();
    const pct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    video.currentTime = pct * duration;
  };
}

/** Shared by the single-item scene preview AND the composited preview's #compositedBg (a scene
 *  item has no video, just a rendered background - same technique both places). */
function buildSceneBackgroundEl(bg) {
  bg = bg || { kind: "color", value: "#111318" };
  const box = el("div", "preview-scene-bg");
  if (bg.kind === "color") {
    box.style.background = bg.value || "#111318";
  } else if (bg.kind === "gradient") {
    const dir = bg.value && bg.value.direction === "vertical" ? "to bottom" : "to right";
    box.style.background = `linear-gradient(${dir}, ${(bg.value && bg.value.from) || "#0ea5e9"}, ${(bg.value && bg.value.to) || "#8b5cf6"})`;
  } else if (bg.kind === "image") {
    const cached = state.backgroundsCache.find((b) => String(b.id) === String(bg.value));
    if (cached) { const img = document.createElement("img"); img.src = cached.dataUrl; box.appendChild(img); }
    else box.style.background = "var(--surface-3)";
  }
  return box;
}

function renderScenePreview(item, frame) {
  const bg = item.background || { kind: "color", value: "#111318" };
  frame.appendChild(buildSceneBackgroundEl(bg));
  const label = el("div", "tl-label", t("preview.scene." + bg.kind));
  label.style.cssText = "position:absolute;top:10px;left:10px;background:rgba(0,0,0,.5);padding:4px 9px;border-radius:6px;color:#fff;font-size:11px;z-index:2";
  frame.appendChild(label);
}

function renderOverlayPreview(o, frame) {
  const canvas = el("div", "preview-overlay-canvas");
  canvas.style.background = "linear-gradient(135deg, #1a1a22, #26262f)";
  const box = el("div", "preview-overlay-box" + (o.type === "text" && (o.props.align || "center") !== "left" ? " text-center" : " text-left"));
  box.style.left = (o.x || 0) + "%";
  box.style.top = (o.y || 0) + "%";
  box.style.width = (o.width || 30) + "%";
  box.style.height = (o.height || 20) + "%";
  if (o.type === "text") {
    box.style.color = o.props.color || "#ffffff";
    box.style.fontSize = clamp((o.props.font_size || 32) / 3, 8, 48) + "px";
    box.style.fontWeight = "700";
    if (o.props.background_color) box.style.background = o.props.background_color + "cc";
    box.textContent = o.props.content || "";
  } else if (o.type === "image") {
    const cached = state.backgroundsCache.find((b) => String(b.id) === String(o.props.background_id));
    if (cached) {
      const img = document.createElement("img");
      img.src = cached.dataUrl;
      img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:4px";
      box.appendChild(img);
    } else {
      box.style.background = "var(--surface-3)";
    }
  } else {
    const shape = el("div", o.props.shape_type === "circle" ? "preview-shape-circle" : "preview-shape-rect");
    shape.style.background = o.props.color || "#ff0000";
    shape.style.opacity = String(o.props.opacity != null ? o.props.opacity : 0.7);
    if (o.props.shape_type !== "circle" && o.props.stroke_width) {
      shape.style.background = "transparent";
      shape.style.border = o.props.stroke_width + "px solid " + (o.props.color || "#ff0000");
    }
    box.appendChild(shape);
  }
  canvas.appendChild(box);
  const label = el("div", "tl-label", o.type === "text" ? t("preview.overlay.text") : o.type === "image" ? t("preview.overlay.image") : t("preview.overlay.shape"));
  label.style.cssText = "position:absolute;top:10px;left:10px;background:rgba(0,0,0,.5);padding:4px 9px;border-radius:6px;color:#fff;font-size:11px;z-index:2";
  frame.appendChild(canvas);
  frame.appendChild(label);
}

function renderAudioPreview(a, frame) {
  const wrap = el("div", "preview-audio-panel");
  wrap.innerHTML =
    '<span style="font-size:40px">🎵</span>' +
    '<div style="font-size:13px;font-weight:600">' + escapeHtml(a.original_name || a.filename || "") + "</div>" +
    '<div style="font-size:11px;opacity:.7">' + escapeHtml(t("inspector.start")) + ": " + fmtSec(a.start_sec) + " · " + escapeHtml(t("inspector.volume")) + ": " + a.volume + "</div>";
  const audio = document.createElement("audio");
  audio.controls = true;
  if (a.filename) audio.src = dataUrl("audio/" + a.filename);
  wrap.appendChild(audio);
  frame.appendChild(wrap);
}

function renderCaptionPreview(c, frame) {
  const canvas = el("div", "preview-overlay-canvas");
  canvas.style.background = "linear-gradient(135deg, #1a1a22, #26262f)";
  const box = el("div", "preview-caption-box", escapeHtml(c.text || ""));
  canvas.appendChild(box);
  frame.appendChild(canvas);
  const label = el("div", "tl-label", t("preview.caption"));
  label.style.cssText = "position:absolute;top:10px;left:10px;background:rgba(0,0,0,.5);padding:4px 9px;border-radius:6px;color:#fff;font-size:11px;z-index:2";
  frame.appendChild(label);
}

// =============================================================================================
// Composited ("full") preview - additive to the single-item preview above, toggled via
// state.previewMode ("single"|"composited", see #previewModeToggle in index.html). DOM-layered
// (not canvas) on purpose: #compositedBg holds the active Main-track item (a <video> for clips,
// a plain background div for scenes - built via buildSceneBackgroundEl() above, swapped only when
// the active item actually changes) and #compositedLayer holds one persistent DOM element per
// overlay/caption, built ONCE (buildCompositedOverlayLayer) and then only toggled/restyled every
// playhead tick - never rebuilt - specifically so an in-progress drag/resize never loses its
// element out from under the user's cursor. A single wall-clock requestAnimationFrame loop drives
// a GLOBAL playheadTime (the same variable the ruler/click-to-seek already used) across the whole
// project; the active <video>'s currentTime is repeatedly SET from that wall clock (muted) rather
// than played natively, which keeps a single playhead consistent across clip/scene boundaries and
// heterogeneous item types without fighting each item's own media clock - a deliberate
// simplification, called out in the round-2 report, consistent with this preview already being
// documented (preview.compositedNote) as an approximation, not a frame-accurate substitute for
// an actual render.
// =============================================================================================

function renderCompositedPreview() {
  const frame = $("previewFrame");
  $("trimScrubber").style.display = "none";
  if (state.timelineItems.length === 0 && state.overlays.length === 0 && state.captions.length === 0) {
    frame.innerHTML = "";
    frame.appendChild(buildPreviewEmpty());
    state.compositedBuilt = false;
    return;
  }
  if (!state.compositedBuilt) {
    frame.innerHTML = '<div class="composited-bg" id="compositedBg"></div><div class="composited-layer" id="compositedLayer"></div>';
    state.compositedBuilt = true;
    state.compositedActiveItemKey = null;
    state.compositedVideoEl = null;
    buildCompositedOverlayLayer();
  }
  updateCompositedFrame();
}

function buildCompositedOverlayLayer() {
  const layer = $("compositedLayer");
  if (!layer) return;
  layer.innerHTML = "";
  state.overlayDomCache = {};
  state.captionDomCache = {};
  const sortedOverlays = state.overlays.slice().sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
  sortedOverlays.forEach((o) => {
    const elx = buildCompositedOverlayElement(o);
    layer.appendChild(elx);
    state.overlayDomCache[o.id] = elx;
  });
  // Captions paint on top of overlays here too, mirroring the render pipeline (captions get
  // z_index 1000 in buildRenderFilterGraph so they always burn in above every overlay).
  state.captions.forEach((c) => {
    const elx = buildCompositedCaptionElement(c);
    layer.appendChild(elx);
    state.captionDomCache[c.id] = elx;
  });
}

function applyOverlayElStyle(elx, o) {
  elx.style.left = (Number(o.x) || 0) + "%";
  elx.style.top = (Number(o.y) || 0) + "%";
  elx.style.width = (Number(o.width) || 20) + "%";
  elx.style.height = (Number(o.height) || 20) + "%";
  const handle = elx.querySelector(".resize-handle-corner");
  elx.innerHTML = "";
  if (o.type === "text") {
    const align = (o.props && o.props.align) || "center";
    elx.classList.toggle("align-left", align === "left");
    elx.style.color = (o.props && o.props.color) || "#ffffff";
    elx.style.fontSize = clamp(((o.props && o.props.font_size) || 32) / 3, 8, 48) + "px";
    elx.style.background = (o.props && o.props.background_color) ? o.props.background_color + "cc" : "transparent";
    const textSpan = document.createElement("span");
    textSpan.textContent = (o.props && o.props.content) || "";
    elx.appendChild(textSpan);
  } else if (o.type === "image") {
    const cached = state.backgroundsCache.find((b) => String(b.id) === String(o.props && o.props.background_id));
    if (cached) {
      const img = document.createElement("img");
      img.src = cached.dataUrl;
      img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
      elx.appendChild(img);
    } else {
      elx.style.background = "var(--surface-3)";
    }
  } else {
    const shape = document.createElement("div");
    shape.className = "shape-fill" + ((o.props && o.props.shape_type) === "circle" ? " circle" : "");
    shape.style.background = (o.props && o.props.color) || "#ff0000";
    shape.style.opacity = String(o.props && o.props.opacity != null ? o.props.opacity : 0.7);
    if ((o.props && o.props.shape_type) !== "circle" && o.props && o.props.stroke_width) {
      shape.style.background = "transparent";
      shape.style.border = o.props.stroke_width + "px solid " + (o.props.color || "#ff0000");
    }
    elx.appendChild(shape);
  }
  if (handle) elx.appendChild(handle);
}

function buildCompositedOverlayElement(o) {
  const elx = el("div", "composited-overlay-el " + (o.type === "text" ? "text" : o.type === "image" ? "image" : "shape"));
  elx.dataset.id = String(o.id);
  elx.style.display = "none";
  const handle = el("div", "resize-handle-corner");
  elx.appendChild(handle);
  applyOverlayElStyle(elx, o);
  elx.addEventListener("mousedown", (e) => {
    if (e.target === handle) return;
    startCompositedOverlayDrag(e, o, elx);
  });
  handle.addEventListener("mousedown", (e) => { e.stopPropagation(); startCompositedOverlayResize(e, o, elx); });
  return elx;
}

function startCompositedOverlayDrag(e, o, elx) {
  e.preventDefault();
  const stageRect = $("compositedLayer").getBoundingClientRect();
  const startX = Number(o.x) || 0, startY = Number(o.y) || 0;
  const startClientX = e.clientX, startClientY = e.clientY;
  elx.classList.add("dragging");
  function onMove(ev) {
    const dxPct = ((ev.clientX - startClientX) / stageRect.width) * 100;
    const dyPct = ((ev.clientY - startClientY) / stageRect.height) * 100;
    o.x = clamp(startX + dxPct, 0, 100 - (Number(o.width) || 20));
    o.y = clamp(startY + dyPct, 0, 100 - (Number(o.height) || 20));
    applyOverlayElStyle(elx, o);
    if (state.selection && state.selection.kind === "overlay" && state.selection.id === o.id) syncInspectorLive();
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    elx.classList.remove("dragging");
    commitOverlayUpdate(o);
    selectItem("overlay", o.id);
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startCompositedOverlayResize(e, o, elx) {
  e.preventDefault();
  const stageRect = $("compositedLayer").getBoundingClientRect();
  const startW = Number(o.width) || 20, startH = Number(o.height) || 20;
  const startClientX = e.clientX, startClientY = e.clientY;
  elx.classList.add("dragging");
  function onMove(ev) {
    const dwPct = ((ev.clientX - startClientX) / stageRect.width) * 100;
    const dhPct = ((ev.clientY - startClientY) / stageRect.height) * 100;
    o.width = clamp(startW + dwPct, 4, 100 - (Number(o.x) || 0));
    o.height = clamp(startH + dhPct, 4, 100 - (Number(o.y) || 0));
    applyOverlayElStyle(elx, o);
    if (state.selection && state.selection.kind === "overlay" && state.selection.id === o.id) syncInspectorLive();
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    elx.classList.remove("dragging");
    commitOverlayUpdate(o);
    selectItem("overlay", o.id);
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

/** Mirrors the backend's render-time alignment rule exactly (see the caption draw-item comment
 *  in buildRenderFilterGraph): centered while pos_x is untouched (===50), left-anchored the
 *  moment it isn't - so what you see dragged here is what actually burns into the render. */
function applyCaptionElStyle(elx, c) {
  elx.style.top = (c.pos_y != null ? Number(c.pos_y) : 88) + "%";
  const posX = c.pos_x != null ? Number(c.pos_x) : 50;
  if (posX === 50) { elx.style.left = "50%"; elx.style.transform = "translateX(-50%)"; }
  else { elx.style.left = posX + "%"; elx.style.transform = "none"; }
  elx.textContent = c.text || "";
}

function buildCompositedCaptionElement(c) {
  const elx = el("div", "composited-caption-el");
  elx.dataset.id = String(c.id);
  elx.style.display = "none";
  applyCaptionElStyle(elx, c);
  elx.addEventListener("mousedown", (e) => startCompositedCaptionDrag(e, c, elx));
  return elx;
}

function startCompositedCaptionDrag(e, c, elx) {
  e.preventDefault();
  const stageRect = $("compositedLayer").getBoundingClientRect();
  const startX = c.pos_x != null ? Number(c.pos_x) : 50;
  const startY = c.pos_y != null ? Number(c.pos_y) : 88;
  const startClientX = e.clientX, startClientY = e.clientY;
  elx.classList.add("dragging");
  function onMove(ev) {
    const dxPct = ((ev.clientX - startClientX) / stageRect.width) * 100;
    const dyPct = ((ev.clientY - startClientY) / stageRect.height) * 100;
    c.pos_x = clamp(startX + dxPct, 0, 100);
    c.pos_y = clamp(startY + dyPct, 0, 100);
    applyCaptionElStyle(elx, c);
    if (state.selection && state.selection.kind === "caption" && state.selection.id === c.id) syncInspectorLive();
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    elx.classList.remove("dragging");
    commitCaptionUpdate(c);
    selectItem("caption", c.id);
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function findActiveMainItem(tSec) {
  if (state.timelineItems.length === 0) return null;
  const { offsets } = mainTrackOffsets();
  for (let i = 0; i < state.timelineItems.length; i++) {
    const dur = itemEffectiveDuration(state.timelineItems[i]);
    if (tSec >= offsets[i] && tSec < offsets[i] + dur) return { item: state.timelineItems[i], idx: i, offset: offsets[i], dur };
  }
  const last = state.timelineItems.length - 1;
  return { item: state.timelineItems[last], idx: last, offset: offsets[last], dur: itemEffectiveDuration(state.timelineItems[last]) };
}

function updateCompositedFrame() {
  const bg = $("compositedBg");
  if (!bg) return;
  const active = findActiveMainItem(playheadTime);
  if (!active) {
    if (state.compositedActiveItemKey !== null) {
      bg.innerHTML = "";
      state.compositedActiveItemKey = null;
      state.compositedVideoEl = null;
    }
  } else {
    const cacheKey = active.item.type === "clip" ? ("clip:" + active.item.clip_id) : ("scene:" + active.idx);
    if (cacheKey !== state.compositedActiveItemKey) {
      state.compositedActiveItemKey = cacheKey;
      bg.innerHTML = "";
      state.compositedVideoEl = null;
      if (active.item.type === "clip") {
        const clip = clipById(active.item.clip_id);
        if (clip && clip.filename) {
          const video = document.createElement("video");
          video.muted = true;
          video.playsInline = true;
          video.src = dataUrl("clips/" + clip.filename);
          bg.appendChild(video);
          state.compositedVideoEl = video;
        }
      } else {
        bg.appendChild(buildSceneBackgroundEl(active.item.background));
      }
    }
    if (active.item.type === "clip" && state.compositedVideoEl) {
      const speed = speedFactorOf(active.item);
      const localEffectiveT = playheadTime - active.offset;
      const start = Number(active.item.source_start_sec) || 0;
      const end = Number(active.item.source_end_sec) || start + 0.1;
      const sourceT = clamp(start + localEffectiveT * speed, start, end);
      const vid = state.compositedVideoEl;
      if (Number.isFinite(vid.duration)) {
        if (Math.abs(vid.currentTime - sourceT) > 0.05) vid.currentTime = sourceT;
      } else {
        vid.addEventListener("loadedmetadata", () => { vid.currentTime = sourceT; }, { once: true });
      }
    }
  }

  for (const o of state.overlays) {
    const elx = state.overlayDomCache[o.id];
    if (!elx) continue;
    applyOverlayElStyle(elx, o);
    const visible = playheadTime >= (Number(o.start_sec) || 0) && playheadTime < (Number(o.end_sec) || 0);
    elx.style.display = visible ? "" : "none";
  }
  for (const c of state.captions) {
    const elx = state.captionDomCache[c.id];
    if (!elx) continue;
    applyCaptionElStyle(elx, c);
    const visible = playheadTime >= (Number(c.start_sec) || 0) && playheadTime < (Number(c.end_sec) || 0);
    elx.style.display = visible ? "" : "none";
  }

  setPlayheadTime(playheadTime);
  const readout = $("compositedTimeReadout");
  if (readout) readout.textContent = fmtSec(playheadTime) + " / " + fmtSec(timelineTotalDuration());
}

function refreshCompositedIfActive() {
  if (state.previewMode === "composited" && state.compositedBuilt) updateCompositedFrame();
}

// ----- play/pause: wall-clock rAF loop advancing the global playheadTime, see the module doc
// comment above for why video.currentTime is driven from it rather than native <video> playback.
function toggleCompositedPlayback() {
  if (state.isPlaying) stopCompositedPlayback();
  else startCompositedPlayback();
}
function startCompositedPlayback() {
  if (state.timelineItems.length === 0) { showToast(t("preview.composited.emptyTimeline"), true); return; }
  const total = timelineTotalDuration();
  if (playheadTime >= total - 0.05) { playheadTime = 0; updateCompositedFrame(); }
  state.isPlaying = true;
  $("playPauseBtn").textContent = "⏸";
  state.lastFrameWallTime = performance.now();
  const tick = (now) => {
    if (!state.isPlaying) return;
    const dt = (now - state.lastFrameWallTime) / 1000;
    state.lastFrameWallTime = now;
    playheadTime = Math.min(total, playheadTime + dt);
    updateCompositedFrame();
    if (playheadTime >= total) { stopCompositedPlayback(); return; }
    state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);
}
function stopCompositedPlayback() {
  state.isPlaying = false;
  const btn = $("playPauseBtn");
  if (btn) btn.textContent = "▶";
  if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
}

function initPreviewModeToggle() {
  document.querySelectorAll("#previewModeToggle .segmented-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.mode === state.previewMode) return;
      document.querySelectorAll("#previewModeToggle .segmented-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.previewMode = btn.dataset.mode;
      const isComposited = state.previewMode === "composited";
      $("compositedControls").style.display = isComposited ? "flex" : "none";
      $("previewNote").textContent = t(isComposited ? "preview.compositedNote" : "preview.scopeNote");
      if (!isComposited) stopCompositedPlayback();
      renderPreview();
    });
  });
  $("playPauseBtn").addEventListener("click", toggleCompositedPlayback);
}

// =============================================================================================
// Inspector (right sidebar)
// =============================================================================================

function setInspectorHeader(badgeClass, badgeText, title) {
  $("inspectorHeader").innerHTML =
    '<span class="kind-badge ' + badgeClass + '">' + escapeHtml(badgeText) + "</span>" +
    "<h3>" + escapeHtml(title) + "</h3>";
}

function renderInspector() {
  const body = $("inspectorBody");
  if (!state.selection) {
    $("inspectorHeader").innerHTML = '<h3>' + escapeHtml(t("inspector.title")) + "</h3>";
    body.innerHTML = '<div class="empty-state"><span class="big">🎛️</span>' + escapeHtml(t("inspector.empty.body")) + "</div>";
    return;
  }
  if (state.selection.kind === "main") return renderMainInspector();
  if (state.selection.kind === "overlay") return renderOverlayInspector();
  if (state.selection.kind === "audio") return renderAudioInspector();
  if (state.selection.kind === "caption") return renderCaptionInspector();
}
function syncInspectorLive() { renderInspector(); }

const EFFECT_TYPES = ["fade_in", "fade_out", "brightness", "contrast", "saturation", "blur", "speed"];
const EFFECT_DEFAULTS = { fade_in: { duration_sec: 0.5 }, fade_out: { duration_sec: 0.5 }, brightness: { value: 0 }, contrast: { value: 1 }, saturation: { value: 1 }, blur: { value: 5 }, speed: { value: 1 } };
const EFFECT_RANGES = {
  brightness: { min: -1, max: 1, step: 0.05 }, contrast: { min: 0, max: 3, step: 0.05 }, saturation: { min: 0, max: 3, step: 0.05 },
  blur: { min: 0, max: 20, step: 0.5 }, speed: { min: 0.5, max: 2, step: 0.05 }, fade_in: { min: 0.1, max: 5, step: 0.1 }, fade_out: { min: 0.1, max: 5, step: 0.1 },
};

function renderMainInspector() {
  const idx = state.selection.index;
  const item = state.timelineItems[idx];
  if (!item) { state.selection = null; return renderInspector(); }
  const isScene = item.type === "scene";
  setInspectorHeader("main", isScene ? t("inspector.scene") : t("inspector.clip"), isScene ? t("timeline.scene") : ((clipById(item.clip_id) || {}).original_name || ("Clip " + item.clip_id)));

  const body = $("inspectorBody");
  body.innerHTML = "";

  // --- Trim / duration ---
  const trimSection = el("div", "inspector-section");
  if (isScene) {
    trimSection.innerHTML =
      '<h4>' + escapeHtml(t("inspector.duration")) + '</h4>' +
      '<div class="form-row"><input type="number" class="form-control small" id="insSceneDuration" min="0.2" step="0.1" value="' + item.duration_sec + '"></div>';
  } else {
    const clip = clipById(item.clip_id);
    const maxDur = clip ? Number(clip.duration_sec) || 999 : 999;
    trimSection.innerHTML =
      '<h4>' + escapeHtml(t("inspector.trim")) + '</h4>' +
      '<div class="form-row-inline">' +
        '<div class="form-row"><label>' + escapeHtml(t("inspector.trimStart")) + '</label><input type="number" class="form-control small" id="insTrimStart" min="0" max="' + maxDur + '" step="0.1" value="' + item.source_start_sec + '"></div>' +
        '<div class="form-row"><label>' + escapeHtml(t("inspector.trimEnd")) + '</label><input type="number" class="form-control small" id="insTrimEnd" min="0" max="' + maxDur + '" step="0.1" value="' + item.source_end_sec + '"></div>' +
      "</div>";
  }
  body.appendChild(trimSection);
  if (isScene) {
    $("insSceneDuration").addEventListener("change", (e) => { item.duration_sec = Math.max(0.2, Number(e.target.value) || 1); scheduleTimelineSave(); });
  } else {
    $("insTrimStart").addEventListener("change", (e) => { item.source_start_sec = Math.max(0, Number(e.target.value) || 0); scheduleTimelineSave(); });
    $("insTrimEnd").addEventListener("change", (e) => { item.source_end_sec = Math.max(item.source_start_sec + 0.1, Number(e.target.value) || 1); scheduleTimelineSave(); });
  }

  // --- Background (scene only) ---
  if (isScene) {
    const bgSection = el("div", "inspector-section");
    bgSection.innerHTML = '<h4>' + escapeHtml(t("inspector.background")) + '</h4>';
    const bg = item.background || { kind: "color", value: "#111318" };
    const kindSelect = el("select", "form-control small");
    kindSelect.innerHTML = ["color", "gradient", "image"].map((k) => '<option value="' + k + '"' + (bg.kind === k ? " selected" : "") + '>' + escapeHtml(t("scenes.kind." + k)) + "</option>").join("");
    const fieldsWrap = el("div");
    fieldsWrap.style.marginTop = "8px";
    bgSection.appendChild(kindSelect);
    bgSection.appendChild(fieldsWrap);
    body.appendChild(bgSection);

    function renderBgFields() {
      const kind = kindSelect.value;
      fieldsWrap.innerHTML = "";
      if (kind === "color") {
        const inp = el("input"); inp.type = "color"; inp.className = "form-control small"; inp.value = bg.kind === "color" ? (bg.value || "#111318") : "#111318";
        fieldsWrap.appendChild(inp);
        inp.addEventListener("input", () => { item.background = { kind: "color", value: inp.value }; scheduleTimelineSave(); });
      } else if (kind === "gradient") {
        const row = el("div", "form-row-inline");
        const fromWrap = el("div", "form-row"); fromWrap.innerHTML = '<label>' + escapeHtml(t("scenes.from")) + '</label>';
        const fromInp = el("input"); fromInp.type = "color"; fromInp.className = "form-control small";
        fromInp.value = (bg.kind === "gradient" && bg.value && bg.value.from) || "#0ea5e9";
        fromWrap.appendChild(fromInp);
        const toWrap = el("div", "form-row"); toWrap.innerHTML = '<label>' + escapeHtml(t("scenes.to")) + '</label>';
        const toInp = el("input"); toInp.type = "color"; toInp.className = "form-control small";
        toInp.value = (bg.kind === "gradient" && bg.value && bg.value.to) || "#8b5cf6";
        toWrap.appendChild(toInp);
        row.appendChild(fromWrap); row.appendChild(toWrap);
        fieldsWrap.appendChild(row);
        const dirWrap = el("div", "form-row"); dirWrap.innerHTML = '<label>' + escapeHtml(t("scenes.direction")) + '</label>';
        const dirSel = el("select", "form-control small");
        dirSel.innerHTML = '<option value="horizontal">' + escapeHtml(t("scenes.direction.horizontal")) + '</option><option value="vertical">' + escapeHtml(t("scenes.direction.vertical")) + "</option>";
        dirSel.value = (bg.kind === "gradient" && bg.value && bg.value.direction) || "horizontal";
        dirWrap.appendChild(dirSel);
        fieldsWrap.appendChild(dirWrap);
        const sync = () => { item.background = { kind: "gradient", value: { from: fromInp.value, to: toInp.value, direction: dirSel.value } }; scheduleTimelineSave(); };
        fromInp.addEventListener("input", sync); toInp.addEventListener("input", sync); dirSel.addEventListener("change", sync);
      } else {
        const uploadRow = el("div", "form-row");
        uploadRow.innerHTML = '<label>' + escapeHtml(t("scenes.image")) + '</label>';
        const fileInp = el("input"); fileInp.type = "file"; fileInp.accept = "image/*"; fileInp.className = "form-control small";
        uploadRow.appendChild(fileInp);
        fieldsWrap.appendChild(uploadRow);
        fileInp.addEventListener("change", async () => {
          const file = fileInp.files && fileInp.files[0];
          if (!file || !state.currentProjectId) return;
          const base64 = await fileToDataUrl(file);
          const res = await invoke({ action: "add_scene_background_image", project_id: state.currentProjectId, image_base64: base64, original_name: file.name });
          state.backgroundsCache.push({ id: res.background.id, filename: res.background.filename, original_name: file.name, dataUrl: base64 });
          item.background = { kind: "image", value: res.background.id };
          scheduleTimelineSave();
          populateSceneLibrary();
        });
        if (state.backgroundsCache.length) {
          const libRow = el("div", "form-row-inline");
          const libSelWrap = el("div", "form-row"); libSelWrap.style.flex = "1";
          libSelWrap.innerHTML = '<label>' + escapeHtml(t("scenes.library")) + '</label>';
          const libSel = el("select", "form-control small");
          libSel.innerHTML = state.backgroundsCache.map((b) => '<option value="' + b.id + '"' + (bg.kind === "image" && String(bg.value) === String(b.id) ? " selected" : "") + '>' + escapeHtml(b.original_name) + "</option>").join("");
          libSelWrap.appendChild(libSel);
          libRow.appendChild(libSelWrap);
          if (state.imageGenAvailable) {
            const modifyBtn = el("button", "icon-button", "✨");
            modifyBtn.type = "button";
            modifyBtn.title = "Ausgewaehltes Bild mit KI veraendern";
            modifyBtn.style.alignSelf = "flex-end";
            modifyBtn.style.marginBottom = "10px";
            libRow.appendChild(modifyBtn);
            const modifyWrap = el("div");
            modifyBtn.addEventListener("click", () => {
              if (modifyWrap.childElementCount) { modifyWrap.innerHTML = ""; return; }
              const bgEntry = state.backgroundsCache.find((b) => String(b.id) === libSel.value);
              if (!bgEntry) return;
              renderModifyBackgroundControl(modifyWrap, bgEntry, (newBg, imageGenId) => {
                state.backgroundsCache.push({ id: newBg.id, filename: newBg.filename, original_name: "ai-generated.png", dataUrl: dataUrl("backgrounds/" + newBg.filename), imageGenId });
                item.background = { kind: "image", value: newBg.id };
                scheduleTimelineSave();
                renderBgFields();
              });
            });
            fieldsWrap.appendChild(libRow);
            fieldsWrap.appendChild(modifyWrap);
          } else {
            fieldsWrap.appendChild(libRow);
          }
          libSel.addEventListener("change", () => { item.background = { kind: "image", value: Number(libSel.value) }; scheduleTimelineSave(); });
        }
        const ref = findConsistencyReference(item.order);
        renderAiImageControl(fieldsWrap, {
          referenceImageGenId: ref && ref.imageGenId,
          referenceLabel: ref && ref.name,
          onCreated: (newBg, imageGenId) => {
            state.backgroundsCache.push({ id: newBg.id, filename: newBg.filename, original_name: "ai-generated.png", dataUrl: dataUrl("backgrounds/" + newBg.filename), imageGenId });
            item.background = { kind: "image", value: newBg.id };
            scheduleTimelineSave();
            populateSceneLibrary();
            renderBgFields();
          },
        });
      }
    }
    kindSelect.addEventListener("change", renderBgFields);
    renderBgFields();
  }

  // --- Transition out ---
  const isLast = idx === state.timelineItems.length - 1;
  const transSection = el("div", "inspector-section");
  transSection.innerHTML = '<h4>' + escapeHtml(t("inspector.transition")) + '</h4>';
  if (isLast) {
    transSection.innerHTML += '<div class="inspector-hint">' + escapeHtml(t("inspector.transition.lastItem")) + "</div>";
  } else {
    const transition = item.transition_out || { type: "none", duration_sec: 0.5 };
    const row = el("div", "form-row-inline");
    const typeWrap = el("div", "form-row");
    const typeSel = el("select", "form-control small");
    typeSel.innerHTML = ["none", "crossfade", "wipe", "fade_to_black"].map((tt) => '<option value="' + tt + '"' + (transition.type === tt ? " selected" : "") + '>' + escapeHtml(t("inspector.transition." + tt)) + "</option>").join("");
    typeWrap.appendChild(typeSel);
    const durWrap = el("div", "form-row"); durWrap.innerHTML = '<label>' + escapeHtml(t("inspector.transition.duration")) + '</label>';
    const durInp = el("input"); durInp.type = "number"; durInp.min = "0.1"; durInp.step = "0.1"; durInp.className = "form-control small"; durInp.value = String(transition.duration_sec || 0.5);
    durWrap.appendChild(durInp);
    row.appendChild(typeWrap); row.appendChild(durWrap);
    transSection.appendChild(row);
    const sync = () => { item.transition_out = { type: typeSel.value, duration_sec: Number(durInp.value) || 0.5 }; scheduleTimelineSave(); };
    typeSel.addEventListener("change", sync); durInp.addEventListener("change", sync);
  }
  body.appendChild(transSection);

  // --- Effects ---
  const fxSection = el("div", "inspector-section");
  fxSection.innerHTML = '<h4>' + escapeHtml(t("inspector.effects")) + '</h4>';
  const fxList = el("div");
  fxSection.appendChild(fxList);
  const effects = item.effects || (item.effects = []);
  if (effects.length === 0) fxList.appendChild(el("div", "inspector-hint", escapeHtml(t("inspector.effects.empty"))));
  effects.forEach((fx, fxIdx) => fxList.appendChild(buildEffectRow(item, fx, fxIdx)));

  const addRow = el("div", "effect-add-row");
  addRow.style.marginTop = "8px";
  const addSel = el("select", "form-control small");
  const available = EFFECT_TYPES.filter((etype) => !effects.some((f) => f.type === etype));
  addSel.innerHTML = '<option value="">' + escapeHtml(t("inspector.effects.add")) + "</option>" + available.map((etype) => '<option value="' + etype + '">' + escapeHtml(t("inspector.effect." + etype)) + "</option>").join("");
  addRow.appendChild(addSel);
  fxSection.appendChild(addRow);
  addSel.addEventListener("change", () => {
    if (!addSel.value) return;
    effects.push({ type: addSel.value, ...EFFECT_DEFAULTS[addSel.value] });
    scheduleTimelineSave();
    renderInspector();
  });
  body.appendChild(fxSection);

  body.appendChild(buildInspectorHint(t("inspector.timelineHint")));
  body.appendChild(buildDeleteFooter(async () => {
    if (!(await confirmDialog(t("inspector.deleteConfirm")))) return;
    state.timelineItems.splice(idx, 1);
    state.selection = null;
    scheduleTimelineSave();
    renderInspector();
    renderPreview();
  }));
}

function buildEffectRow(item, fx, fxIdx) {
  const row = el("div", "effect-row");
  const bodyEl = el("div", "effect-body");
  bodyEl.innerHTML = '<div class="effect-name">' + escapeHtml(t("inspector.effect." + fx.type)) + "</div>";
  const range = EFFECT_RANGES[fx.type];
  if (range) {
    const field = fx.type === "fade_in" || fx.type === "fade_out" ? "duration_sec" : "value";
    const rangeRow = el("div", "range-row");
    const slider = el("input"); slider.type = "range"; slider.min = String(range.min); slider.max = String(range.max); slider.step = String(range.step);
    slider.value = String(fx[field] != null ? fx[field] : (EFFECT_DEFAULTS[fx.type][field]));
    const valLabel = el("span", "range-val", slider.value);
    rangeRow.appendChild(slider);
    rangeRow.appendChild(valLabel);
    bodyEl.appendChild(rangeRow);
    const commit = debounce(() => scheduleTimelineSave(), 250);
    slider.addEventListener("input", () => {
      fx[field] = Number(slider.value);
      valLabel.textContent = slider.value;
      commit();
    });
  }
  row.appendChild(bodyEl);
  const removeBtn = el("button", "icon-button", "✕");
  removeBtn.type = "button";
  removeBtn.title = t("inspector.effects.remove");
  removeBtn.addEventListener("click", () => {
    item.effects.splice(fxIdx, 1);
    scheduleTimelineSave();
    renderInspector();
  });
  row.appendChild(removeBtn);
  return row;
}

/** Lane ("Spur") <select> HTML for the overlay/audio inspector - options 0..laneCount-1, laneCount
 *  computed the same way the timeline itself does (max used track_index + any extra empty lanes
 *  the user added via "+ Spur"), so every lane currently visible in the timeline is selectable. */
function buildLaneSelectHtml(id, kind, items, currentTrackIndex) {
  const laneCount = Math.max(1, computeLaneCount(kind, items));
  const current = clamp(Number(currentTrackIndex) || 0, 0, laneCount - 1);
  const options = [];
  for (let i = 0; i < laneCount; i++) {
    options.push('<option value="' + i + '"' + (i === current ? " selected" : "") + '>' + (i + 1) + "</option>");
  }
  return '<div class="form-row"><label>' + escapeHtml(t("inspector.lane")) + '</label><select class="form-control small" id="' + id + '">' + options.join("") + "</select></div>";
}

function buildInspectorHint(text) {
  const wrap = el("div", "inspector-hint");
  wrap.style.cssText = "margin:-6px 0 14px;padding:0 2px;";
  wrap.textContent = text;
  return wrap;
}
function buildDeleteFooter(onDelete) {
  const wrap = el("div", "footer-actions");
  wrap.style.cssText = "border-top:1px solid var(--border);margin-top:6px;padding-top:14px;";
  const btn = el("button", "danger-button block-btn", escapeHtml(t("inspector.delete")));
  btn.type = "button";
  btn.addEventListener("click", onDelete);
  wrap.appendChild(btn);
  return wrap;
}

function renderOverlayInspector() {
  const o = state.overlays.find((x) => x.id === state.selection.id);
  if (!o) { state.selection = null; return renderInspector(); }
  setInspectorHeader(
    "overlay",
    o.type === "text" ? t("inspector.overlay.text") : o.type === "image" ? t("inspector.overlay.image") : t("inspector.overlay.shape"),
    o.type === "text" ? (o.props.content || "") : o.type === "image" ? "" : (o.props.shape_type || "")
  );

  const body = $("inspectorBody");
  body.innerHTML = "";

  const timeSection = el("div", "inspector-section");
  timeSection.innerHTML =
    '<h4>' + escapeHtml(t("inspector.start")) + " / " + escapeHtml(t("inspector.end")) + '</h4>' +
    '<div class="form-row-inline">' +
      '<div class="form-row"><label>' + escapeHtml(t("inspector.start")) + '</label><input type="number" class="form-control small" id="ovStart" min="0" step="0.1" value="' + o.start_sec + '"></div>' +
      '<div class="form-row"><label>' + escapeHtml(t("inspector.end")) + '</label><input type="number" class="form-control small" id="ovEnd" min="0" step="0.1" value="' + o.end_sec + '"></div>' +
    "</div>";
  body.appendChild(timeSection);

  const posSection = el("div", "inspector-section");
  posSection.innerHTML =
    '<h4>' + escapeHtml(t("inspector.position")) + '</h4>' +
    '<div class="form-row-inline">' +
      '<div class="form-row"><label>' + escapeHtml(t("inspector.x")) + '</label><input type="number" class="form-control small" id="ovX" min="0" max="100" step="1" value="' + o.x + '"></div>' +
      '<div class="form-row"><label>' + escapeHtml(t("inspector.y")) + '</label><input type="number" class="form-control small" id="ovY" min="0" max="100" step="1" value="' + o.y + '"></div>' +
    "</div>" +
    '<h4>' + escapeHtml(t("inspector.size")) + '</h4>' +
    '<div class="form-row-inline">' +
      '<div class="form-row"><label>' + escapeHtml(t("inspector.width")) + '</label><input type="number" class="form-control small" id="ovWidth" min="1" max="100" step="1" value="' + (o.width || 20) + '"></div>' +
      '<div class="form-row"><label>' + escapeHtml(t("inspector.height")) + '</label><input type="number" class="form-control small" id="ovHeight" min="1" max="100" step="1" value="' + (o.height || 20) + '"></div>' +
    "</div>" +
    '<div class="form-row"><label>' + escapeHtml(t("inspector.zIndex")) + '</label><input type="number" class="form-control small" id="ovZ" step="1" value="' + (o.z_index || 0) + '"></div>' +
    buildLaneSelectHtml("ovLane", "overlay", state.overlays, o.track_index);
  body.appendChild(posSection);

  const typeSection = el("div", "inspector-section");
  if (o.type === "text") {
    typeSection.innerHTML =
      '<h4>' + escapeHtml(t("inspector.overlay.text")) + '</h4>' +
      '<div class="form-row"><label>' + escapeHtml(t("inspector.content")) + '</label><input type="text" class="form-control small" id="ovContent" value="' + escapeHtml(o.props.content || "") + '"></div>' +
      '<div class="form-row-inline">' +
        '<div class="form-row"><label>' + escapeHtml(t("inspector.fontSize")) + '</label><input type="number" class="form-control small" id="ovFontSize" min="8" max="200" value="' + (o.props.font_size || 32) + '"></div>' +
        '<div class="form-row"><label>' + escapeHtml(t("inspector.color")) + '</label><input type="color" class="form-control small" id="ovColor" value="' + (o.props.color || "#ffffff") + '"></div>' +
      "</div>" +
      '<div class="form-row"><label>' + escapeHtml(t("inspector.align")) + '</label><select class="form-control small" id="ovAlign">' +
        '<option value="center"' + ((o.props.align || "center") === "center" ? " selected" : "") + '>' + escapeHtml(t("text.align.center")) + '</option>' +
        '<option value="left"' + (o.props.align === "left" ? " selected" : "") + '>' + escapeHtml(t("text.align.left")) + "</option></select></div>" +
      '<label class="checkbox-label"><input type="checkbox" id="ovBgEnable"' + (o.props.background_color ? " checked" : "") + '> ' + escapeHtml(t("inspector.bgEnable")) + '</label>' +
      '<input type="color" class="form-control small" id="ovBgColor" value="' + (o.props.background_color || "#000000") + '" style="margin-top:6px">';
  } else if (o.type === "image") {
    const cached = state.backgroundsCache.find((b) => String(b.id) === String(o.props.background_id));
    typeSection.innerHTML =
      '<h4>' + escapeHtml(t("inspector.overlay.image")) + '</h4>' +
      (cached
        ? '<img src="' + cached.dataUrl + '" style="max-width:100%;border-radius:8px;display:block">'
        : '<div class="inspector-hint">' + escapeHtml(t("inspector.imageMissing")) + '</div>');
  } else {
    typeSection.innerHTML =
      '<h4>' + escapeHtml(t("inspector.overlay.shape")) + '</h4>' +
      '<div class="form-row"><label>' + escapeHtml(t("inspector.shapeType")) + '</label><select class="form-control small" id="ovShapeType">' +
        '<option value="rect"' + (o.props.shape_type === "rect" ? " selected" : "") + '>' + escapeHtml(t("shapes.type.rect")) + '</option>' +
        '<option value="circle"' + (o.props.shape_type === "circle" ? " selected" : "") + '>' + escapeHtml(t("shapes.type.circle")) + "</option></select></div>" +
      '<div class="form-row-inline">' +
        '<div class="form-row"><label>' + escapeHtml(t("inspector.color")) + '</label><input type="color" class="form-control small" id="ovShapeColor" value="' + (o.props.color || "#ff0000") + '"></div>' +
        '<div class="form-row"><label>' + escapeHtml(t("inspector.opacity")) + '</label><input type="number" class="form-control small" id="ovOpacity" min="0" max="1" step="0.05" value="' + (o.props.opacity != null ? o.props.opacity : 0.7) + '"></div>' +
      "</div>" +
      '<div class="form-row" id="ovStrokeRow"' + (o.props.shape_type === "circle" ? ' style="display:none"' : "") + '><label>' + escapeHtml(t("inspector.strokeWidth")) + '</label><input type="number" class="form-control small" id="ovStroke" min="0" step="1" value="' + (o.props.stroke_width || 0) + '"></div>';
  }
  body.appendChild(typeSection);
  body.appendChild(buildDeleteFooter(async () => {
    if (!(await confirmDialog(t("inspector.deleteConfirm")))) return;
    await invoke({ action: "delete_overlay", id: o.id });
    await loadOverlays();
    state.selection = null;
    renderAll();
  }));

  function collect() {
    o.start_sec = Number($("ovStart").value) || 0;
    o.end_sec = Number($("ovEnd").value) || o.start_sec + 0.5;
    o.x = Number($("ovX").value) || 0;
    o.y = Number($("ovY").value) || 0;
    o.width = Number($("ovWidth").value) || 20;
    o.height = Number($("ovHeight").value) || 20;
    o.z_index = Number($("ovZ").value) || 0;
    o.track_index = Number($("ovLane").value) || 0;
    if (o.type === "text") {
      o.props = {
        content: $("ovContent").value, font_size: Number($("ovFontSize").value) || 32, color: $("ovColor").value,
        align: $("ovAlign").value, background_color: $("ovBgEnable").checked ? $("ovBgColor").value : undefined,
      };
    } else if (o.type === "image") {
      // no editable props beyond the generic position/time fields collected above
    } else {
      o.props = {
        shape_type: $("ovShapeType").value, color: $("ovShapeColor").value,
        opacity: Number($("ovOpacity").value), stroke_width: $("ovShapeType").value === "rect" ? Number($("ovStroke").value) || 0 : undefined,
      };
    }
  }
  body.querySelectorAll("input,select").forEach((inp) => {
    const handler = () => { collect(); commitOverlayUpdate(o); renderTimeline(); syncPreviewOverlay(o); };
    inp.addEventListener("input", handler);
    // <select> reliably fires "input" on real user interaction in Chromium, but "change" is the
    // one every engine guarantees - bind both so the lane/align/shape-type dropdowns are never
    // one keystroke away from silently not saving on some other embedder.
    if (inp.tagName === "SELECT") inp.addEventListener("change", handler);
  });
  const shapeTypeSel = $("ovShapeType");
  if (shapeTypeSel) shapeTypeSel.addEventListener("change", () => { $("ovStrokeRow").style.display = shapeTypeSel.value === "circle" ? "none" : ""; });
}
function syncPreviewOverlay(o) {
  if (state.selection && state.selection.kind === "overlay" && state.selection.id === o.id) renderPreview();
  refreshCompositedIfActive();
}

function renderAudioInspector() {
  const a = state.audioTracks.find((x) => x.id === state.selection.id);
  if (!a) { state.selection = null; return renderInspector(); }
  setInspectorHeader("audio", t("inspector.audio"), a.original_name || a.filename || "");

  const body = $("inspectorBody");
  body.innerHTML =
    '<div class="inspector-section">' +
      '<div class="form-row"><label>' + escapeHtml(t("inspector.start")) + '</label><input type="number" class="form-control small" id="atStart" min="0" step="0.1" value="' + a.start_sec + '"></div>' +
      '<div class="form-row"><label>' + escapeHtml(t("inspector.volume")) + '</label><input type="number" class="form-control small" id="atVolume" min="0" step="0.1" value="' + a.volume + '"></div>' +
      buildLaneSelectHtml("atLane", "audio", state.audioTracks, a.track_index) +
    "</div>";
  body.appendChild(buildDeleteFooter(async () => {
    if (!(await confirmDialog(t("inspector.deleteConfirm")))) return;
    await invoke({ action: "delete_audio_track", id: a.id });
    await loadAudioTracks();
    state.selection = null;
    renderAll();
  }));

  $("atStart").addEventListener("input", () => { a.start_sec = Math.max(0, Number($("atStart").value) || 0); commitAudioUpdate(a); renderTimeline(); });
  $("atVolume").addEventListener("input", () => { a.volume = Number($("atVolume").value) || 1; commitAudioUpdate(a); });
  $("atLane").addEventListener("change", () => { a.track_index = Number($("atLane").value) || 0; commitAudioUpdate(a); renderTimeline(); });
}

function renderCaptionInspector() {
  const c = state.captions.find((x) => x.id === state.selection.id);
  if (!c) { state.selection = null; return renderInspector(); }
  setInspectorHeader("caption", t("inspector.caption"), c.text || "");

  const body = $("inspectorBody");
  body.innerHTML =
    '<div class="inspector-section">' +
      '<div class="form-row-inline">' +
        '<div class="form-row"><label>' + escapeHtml(t("inspector.start")) + '</label><input type="number" class="form-control small" id="capStart" min="0" step="0.1" value="' + c.start_sec + '"></div>' +
        '<div class="form-row"><label>' + escapeHtml(t("inspector.end")) + '</label><input type="number" class="form-control small" id="capEnd" min="0" step="0.1" value="' + c.end_sec + '"></div>' +
      "</div>" +
      '<div class="form-row"><label>' + escapeHtml(t("inspector.text")) + '</label><textarea class="form-control small" id="capText" rows="3">' + escapeHtml(c.text || "") + "</textarea></div>" +
      '<div class="form-row-inline">' +
        '<div class="form-row"><label>' + escapeHtml(t("inspector.x")) + '</label><input type="number" class="form-control small" id="capPosX" min="0" max="100" step="1" value="' + (c.pos_x != null ? c.pos_x : 50) + '"></div>' +
        '<div class="form-row"><label>' + escapeHtml(t("inspector.y")) + '</label><input type="number" class="form-control small" id="capPosY" min="0" max="100" step="1" value="' + (c.pos_y != null ? c.pos_y : 88) + '"></div>' +
      "</div>" +
      '<div class="inspector-hint">' + escapeHtml(t("inspector.captionPosHint")) + "</div>" +
    "</div>";
  body.appendChild(buildDeleteFooter(async () => {
    if (!(await confirmDialog(t("inspector.deleteConfirm")))) return;
    await invoke({ action: "delete_caption", id: c.id });
    await loadCaptions();
    state.selection = null;
    renderAll();
  }));

  $("capStart").addEventListener("input", () => { c.start_sec = Math.max(0, Number($("capStart").value) || 0); commitCaptionUpdate(c); renderTimeline(); refreshCompositedIfActive(); });
  $("capEnd").addEventListener("input", () => { c.end_sec = Math.max(c.start_sec + 0.1, Number($("capEnd").value) || 1); commitCaptionUpdate(c); renderTimeline(); refreshCompositedIfActive(); });
  $("capText").addEventListener("input", () => { c.text = $("capText").value; commitCaptionUpdate(c); renderTimeline(); if (state.selection.kind === "caption") renderPreview(); refreshCompositedIfActive(); });
  $("capPosX").addEventListener("input", () => { c.pos_x = Number($("capPosX").value) || 0; commitCaptionUpdate(c); refreshCompositedIfActive(); });
  $("capPosY").addEventListener("input", () => { c.pos_y = Number($("capPosY").value) || 0; commitCaptionUpdate(c); refreshCompositedIfActive(); });
}

// =============================================================================================
// Render popover + status polling
// =============================================================================================

async function loadRenders() {
  if (!state.currentProjectId) { state.renders = []; return; }
  const res = await invoke({ action: "list_renders", project_id: state.currentProjectId });
  state.renders = res.renders || [];
  updateRenderStatusChip();
}

function updateRenderStatusChip() {
  const active = state.renders.find((r) => r.status === "queued" || r.status === "rendering");
  const chip = $("renderStatusChip");
  if (active) {
    chip.classList.add("visible");
    $("renderStatusChipText").textContent = t("render.inProgress");
    startRenderPolling();
  } else {
    chip.classList.remove("visible");
    stopRenderPolling();
  }
}

function startRenderPolling() {
  if (state.renderPollTimer) return;
  state.renderPollTimer = setInterval(async () => {
    if (!state.currentProjectId) return;
    await loadRenders();
    renderRenderList();
  }, 3000);
}
function stopRenderPolling() { if (state.renderPollTimer) { clearInterval(state.renderPollTimer); state.renderPollTimer = null; } }

function renderRenderList() {
  const list = $("renderList");
  if (state.renders.length === 0) { list.innerHTML = '<div class="empty-state">' + escapeHtml(t("render.empty")) + "</div>"; return; }
  list.innerHTML = state.renders.map((r) => {
    const videoHtml = r.status === "done" && r.output_filename
      ? '<video class="render-video" controls src="' + dataUrl("renders/" + r.output_filename) + '"></video>' +
        '<a class="download-link" href="' + dataUrl("renders/" + r.output_filename) + '" download>' + escapeHtml(t("render.download")) + "</a>"
      : "";
    const errorNote = r.error ? '<div class="render-error-note">' + escapeHtml(r.error) + "</div>" : "";
    return (
      '<div class="render-row">' +
        '<div class="render-row-head"><span>#' + r.id + " · " + new Date(r.created_at).toLocaleString() + '</span><span class="render-status ' + r.status + '">' + escapeHtml(t("render.status." + r.status)) + "</span></div>" +
        errorNote + videoHtml +
      "</div>"
    );
  }).join("");
}

function initRenderPopover() {
  const popover = $("renderPopover");
  const backdrop = $("renderPopoverBackdrop");
  function open() { popover.classList.add("open"); backdrop.style.display = "block"; renderRenderList(); }
  function close() { popover.classList.remove("open"); backdrop.style.display = "none"; }
  $("renderBtn").addEventListener("click", () => { popover.classList.contains("open") ? close() : open(); });
  backdrop.addEventListener("click", close);

  $("startRenderBtn").addEventListener("click", async () => {
    if (!state.currentProjectId) return showToast(t("render.needProject"), true);
    if (state.timelineItems.length === 0) return showToast(t("render.emptyTimeline"), true);
    const burnCaptions = $("burnCaptionsCheck").checked;
    await withButtonSpinner($("startRenderBtn"), t("render.starting"), async () => {
      try {
        await invoke({ action: "render", project_id: state.currentProjectId, options: { burn_captions: burnCaptions } });
        showToast(t("render.started"));
        await loadRenders();
        renderRenderList();
      } catch (err) { showToast(err.message || String(err), true); }
    });
  });
}

// =============================================================================================
// Side tabs
// =============================================================================================

function initSideTabs() {
  document.querySelectorAll(".side-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".side-tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".side-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $("side-" + btn.dataset.sideTab).classList.add("active");
    });
  });
}

function initLaneButtons() {
  $("addOverlayLaneBtn").addEventListener("click", () => bumpLaneCount("overlay"));
  $("addAudioLaneBtn").addEventListener("click", () => bumpLaneCount("audio"));
}

// =============================================================================================
// Resizable + collapsible sidebars - widths and collapsed state persist in localStorage the same
// way theme/lang do. Sidebar width is set via inline flex-basis (wins over the CSS class's
// default), clamped to SIDEBAR_MIN..SIDEBAR_MAX; collapsing sets flex-basis:0 via a CSS class
// instead of display:none so the resize handle (a sibling, not a child) stays put and clickable.
// =============================================================================================

const SIDEBAR_MIN = 200, SIDEBAR_MAX = 500, SIDEBAR_DEFAULT = 300;

function initSidebarResize() {
  const leftEl = $("sidebarLeft"), rightEl = $("sidebarRight");
  const leftHandle = $("leftResizeHandle"), rightHandle = $("rightResizeHandle");
  const leftCollapseBtn = $("leftCollapseBtn"), rightCollapseBtn = $("rightCollapseBtn");

  function readWidth(key) {
    const v = Number(window.localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? clamp(v, SIDEBAR_MIN, SIDEBAR_MAX) : SIDEBAR_DEFAULT;
  }
  function readCollapsed(key) {
    try { return window.localStorage.getItem(key) === "1"; } catch (e) { return false; }
  }

  let leftWidth = readWidth("video-editor-left-width");
  let rightWidth = readWidth("video-editor-right-width");
  let leftCollapsed = readCollapsed("video-editor-left-collapsed");
  let rightCollapsed = readCollapsed("video-editor-right-collapsed");

  function applyLeft() {
    leftEl.style.width = leftWidth + "px";
    leftEl.style.flexBasis = leftWidth + "px";
    leftEl.classList.toggle("collapsed", leftCollapsed);
    leftCollapseBtn.textContent = leftCollapsed ? "›" : "‹";
    leftCollapseBtn.title = t(leftCollapsed ? "sidebar.expandLeft" : "sidebar.collapseLeft");
  }
  function applyRight() {
    rightEl.style.width = rightWidth + "px";
    rightEl.style.flexBasis = rightWidth + "px";
    rightEl.classList.toggle("collapsed", rightCollapsed);
    rightCollapseBtn.textContent = rightCollapsed ? "‹" : "›";
    rightCollapseBtn.title = t(rightCollapsed ? "sidebar.expandRight" : "sidebar.collapseRight");
  }
  applyLeft();
  applyRight();

  leftCollapseBtn.addEventListener("click", () => {
    leftCollapsed = !leftCollapsed;
    try { window.localStorage.setItem("video-editor-left-collapsed", leftCollapsed ? "1" : "0"); } catch (e) { /* ignore */ }
    applyLeft();
  });
  rightCollapseBtn.addEventListener("click", () => {
    rightCollapsed = !rightCollapsed;
    try { window.localStorage.setItem("video-editor-right-collapsed", rightCollapsed ? "1" : "0"); } catch (e) { /* ignore */ }
    applyRight();
  });

  function bindDrag(handle, getStart, commit) {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      handle.classList.add("dragging");
      const startX = e.clientX;
      const startWidth = getStart();
      function onMove(ev) { commit(startWidth, ev.clientX - startX); }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        handle.classList.remove("dragging");
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  bindDrag(leftHandle, () => leftWidth, (start, delta) => {
    leftWidth = clamp(start + delta, SIDEBAR_MIN, SIDEBAR_MAX);
    if (leftCollapsed) { leftCollapsed = false; try { window.localStorage.setItem("video-editor-left-collapsed", "0"); } catch (e) {} }
    applyLeft();
    try { window.localStorage.setItem("video-editor-left-width", String(leftWidth)); } catch (e) { /* ignore */ }
  });
  bindDrag(rightHandle, () => rightWidth, (start, delta) => {
    rightWidth = clamp(start - delta, SIDEBAR_MIN, SIDEBAR_MAX);
    if (rightCollapsed) { rightCollapsed = false; try { window.localStorage.setItem("video-editor-right-collapsed", "0"); } catch (e) {} }
    applyRight();
    try { window.localStorage.setItem("video-editor-right-width", String(rightWidth)); } catch (e) { /* ignore */ }
  });
}

// =============================================================================================
// Bootstrapping
// =============================================================================================

document.addEventListener("DOMContentLoaded", async function () {
  await detectImageGen();
  $("elementsTabBtn").style.display = state.imageGenAvailable ? "" : "none";

  initTheme();
  initLang();
  initProjectControls();
  initClipsPanel();
  initElementsPanel();
  initScenesPanel();
  initTextPanel();
  initShapesPanel();
  initAudioPanel();
  initSideTabs();
  initZoom();
  initCaptionAddFab();
  initRenderPopover();
  initLaneButtons();
  initSidebarResize();
  initPreviewModeToggle();

  await loadProjects();
  await loadAll();
});

})();
