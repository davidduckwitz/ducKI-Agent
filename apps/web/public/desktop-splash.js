// Logic for desktop-splash.html - kept external so the strict script-src CSP applies unchanged.
(() => {
  "use strict";

  const FEATURES = [
    { icon: "🧠", title: "Memory", text: "Ein Langzeitgedächtnis, das sich Fakten, Vorlieben und Projektwissen über alle Chats hinweg merkt.", use: "„Wie hieß nochmal die Bibliothek, die wir letzte Woche gewählt haben?“" },
    { icon: "📚", title: "LLM-Wiki", text: "DucKI baut aus Gesprächen, Dateien und Recherchen ein verlinktes Wiki, inklusive Graph-Ansicht.", use: "„Leg eine Wiki-Seite zu unserem Deployment-Prozess an.“" },
    { icon: "🧩", title: "Skills", text: "Kompatibel mit agentskills.io: Jeder Skill bringt neues Können mit und wird passend zur Aufgabe automatisch geladen.", use: "„Installiere den Code-Review-Skill und prüf meinen Branch.“" },
    { icon: "🔌", title: "Plugins", text: "Datenquellen, Tools, Widgets, Pets und Connectors als Ordner. Eigene Plugins kann DucKI selbst bauen.", use: "„Bau mir ein Plugin, das meine RSS-Feeds zusammenfasst.“" },
    { icon: "💻", title: "Coding-Agent", text: "Plant mit Checkliste, schreibt Code im Workspace, legt Checkpoints an und prüft das Ergebnis selbst.", use: "„Füge dem Projekt einen Dark-Mode hinzu und teste ihn.“" },
    { icon: "🎙️", title: "Voice-Modus", text: "Sprich freihändig mit DucKI: lokales Whisper für Spracherkennung, Chatterbox für die Stimme.", use: "„Lies mir die wichtigsten Mails von heute vor.“" },
    { icon: "🌐", title: "Browser & Shell", text: "DucKI steuert Browser, Dateien und Terminal im Shared Workspace, und du schaust live zu.", use: "„Recherchiere drei Hosting-Anbieter und vergleiche die Preise.“" },
    { icon: "💬", title: "Connectors", text: "Discord und weitere Portale: DucKI antwortet auch dort, wo dein Team schreibt.", use: "„Poste die Release-Notes in unseren Discord-Kanal.“" },
    { icon: "⏰", title: "Cronjobs & Workflows", text: "Wiederkehrende Aufgaben laufen zuverlässig im Hintergrund, auch wenn das Fenster zu ist.", use: "„Schick mir jeden Morgen um 8 Uhr eine Zusammenfassung.“" },
    { icon: "🔒", title: "Local-first", text: "Lokal mit LM Studio oder Ollama, oder in der Cloud mit OpenAI, Claude oder OpenRouter. Du entscheidest, wohin deine Daten gehen.", use: "Tipp: Den Provider stellst du gleich im Setup-Assistenten ein." },
  ];

  const STEPS = [
    { key: "prepare", label: "Vorbereiten", phases: ["prepare", "migrate"] },
    { key: "seed", label: "Skills & Plugins", phases: ["seed"] },
    { key: "agent", label: "Agent starten", phases: ["agent"] },
    { key: "ready", label: "Bereit", phases: ["ready"] },
  ];

  const TAGLINES = [
    "Dein lokaler KI-Agent wird geweckt …",
    "Die Ente putzt sich noch die Federn …",
    "Skills werden sortiert, Plugins eingestöpselt …",
    "Das Gedächtnis wird aufgewärmt …",
    "Gleich geht’s los, quak!",
  ];

  const $ = (id) => document.getElementById(id);
  const card = $("card");

  // Night sky
  const stars = $("stars");
  for (let i = 0; i < 38; i++) {
    const s = document.createElement("span");
    s.className = "star";
    s.style.left = `${Math.random() * 100}%`;
    s.style.top = `${Math.random() * 62}%`;
    s.style.setProperty("--d", `${2 + Math.random() * 4}s`);
    s.style.setProperty("--delay", `${-Math.random() * 4}s`);
    stars.appendChild(s);
  }

  // Feature carousel
  const featureEls = FEATURES.map((f) => {
    const el = document.createElement("article");
    el.className = "feature";
    el.innerHTML = `<div class="icon"></div><div><h2></h2><p></p><div class="usecase"></div></div>`;
    el.querySelector(".icon").textContent = f.icon;
    el.querySelector("h2").textContent = f.title;
    el.querySelector("p").textContent = f.text;
    el.querySelector(".usecase").textContent = f.use;
    $("features").appendChild(el);
    return el;
  });
  const dotEls = FEATURES.map((_, i) => {
    const d = document.createElement("span");
    d.className = "dot";
    $("dots").appendChild(d);
    return d;
  });
  let featureIndex = Math.floor(Math.random() * FEATURES.length);
  function showFeature(next) {
    featureEls.forEach((el, i) => {
      el.classList.toggle("active", i === next);
      el.classList.toggle("gone", i === featureIndex && i !== next);
    });
    dotEls.forEach((d, i) => d.classList.toggle("active", i === next));
    featureIndex = next;
  }
  showFeature(featureIndex);
  setInterval(() => showFeature((featureIndex + 1) % FEATURES.length), 3600);

  let taglineIndex = 0;
  const taglineTimer = setInterval(() => {
    taglineIndex = (taglineIndex + 1) % TAGLINES.length;
    $("tagline").textContent = TAGLINES[taglineIndex];
  }, 4200);

  // Steps
  const stepEls = STEPS.map((s) => {
    const el = document.createElement("div");
    el.className = "step";
    el.innerHTML = "<i></i><span></span>";
    el.querySelector("span").textContent = s.label;
    $("steps").appendChild(el);
    return el;
  });

  function setChip(id, value, suffixHtml) {
    const chip = $(id);
    if (!value) return;
    chip.querySelector("b").textContent = String(value);
    chip.classList.add("show");
  }

  let lastPhase = "";
  function render(status) {
    if (!status) return;
    const phase = status.phase || "prepare";
    if (status.stats?.version) $("version").textContent = `v${status.stats.version}`;
    $("fill").style.width = `${Math.max(3, Math.min(100, status.progress || 0))}%`;
    $("message").textContent = status.message || "";
    setChip("chip-skills", status.stats?.skills);
    setChip("chip-plugins", status.stats?.plugins);
    setChip("chip-port", status.stats?.port);

    if (phase === "error") {
      card.classList.remove("working", "ready");
      card.classList.add("error");
      $("error-text").textContent = status.error || "Unbekannter Fehler";
      $("tagline").textContent = "Beim Start ist etwas schiefgelaufen.";
      clearInterval(taglineTimer);
      return;
    }
    card.classList.remove("error");
    const current = STEPS.findIndex((s) => s.phases.includes(phase));
    stepEls.forEach((el, i) => {
      el.classList.toggle("done", i < current || (phase === "ready" && i === current));
      el.classList.toggle("current", i === current && phase !== "ready");
    });
    if (phase === "ready" && lastPhase !== "ready") {
      card.classList.remove("working");
      card.classList.add("ready");
      $("bubble").classList.add("show");
      $("tagline").textContent = status.stats?.firstRun
        ? "Willkommen! Gleich richtest du DucKI im Setup-Assistenten ein."
        : "Willkommen zurück!";
      clearInterval(taglineTimer);
      setTimeout(() => card.classList.add("leaving"), 650);
    }
    lastPhase = phase;
  }

  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke;
  const listen = tauri?.event?.listen;

  $("btn-retry").addEventListener("click", () => {
    card.classList.remove("error", "leaving");
    card.classList.add("working");
    $("bubble").classList.remove("show");
    lastPhase = "";
    if (invoke) invoke("retry_startup");
    else demo(false);
  });
  $("btn-logs").addEventListener("click", () => invoke?.("open_logs"));
  $("btn-quit").addEventListener("click", () => (invoke ? invoke("quit_app") : window.close()));

  if (invoke && listen) {
    listen("startup://progress", (event) => render(event.payload));
    invoke("get_startup_status").then(render).catch(() => {});
    return;
  }

  // ---- Browser preview: simulate a startup ----
  function demo(fail) {
    const timeline = [
      [250, { phase: "prepare", progress: 4, message: "Arbeitsverzeichnisse vorbereiten" }],
      [900, { phase: "seed", progress: 18, message: "Core-Skills installieren" }],
      [1600, { phase: "seed", progress: 34, message: "Plugin: calendar" }],
      [2300, { phase: "seed", progress: 45, message: "Plugins bereit", stats: { skills: 32, plugins: 14 } }],
      [3000, { phase: "agent", progress: 58, message: "Node-Laufzeit startet (Port 3001)" }],
      [4200, { phase: "agent", progress: 86, message: "Warte auf den Agenten … 3 s" }],
      fail
        ? [5200, { phase: "error", progress: 86, message: "Start fehlgeschlagen", error: "Der Agent hat sich beim Start beendet.\n\nLetzte Ausgabe:\nError: listen EACCES: permission denied 127.0.0.1:3001\n    at Server.setupListenHandle [as _listen2] (node:net:1872:21)" }]
        : [5400, { phase: "ready", progress: 100, message: "Bereit – quak!", stats: { port: 3001, firstRun: true } }],
    ];
    let merged = { stats: { version: "0.1.0" } };
    for (const [at, patch] of timeline) {
      setTimeout(() => {
        merged = { ...merged, ...patch, stats: { ...merged.stats, ...(patch.stats || {}) } };
        render(merged);
      }, at);
    }
  }
  demo(new URLSearchParams(location.search).has("error"));
})();
