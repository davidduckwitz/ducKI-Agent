---
name: vanilla-javascript
description: "Hard constraints for the JavaScript step of a static browser project built by this agent: vanilla JS only, no Node.js/npm runtime dependencies or build step, third-party code only via CDN <script>/ESM tags, state persisted only via the browser's localStorage, and a package.json with project metadata always present even though nothing is installed into it. Use for a plan step whose own scope is scripting/interactivity."
category: development
tags: [javascript, vanilla-js, cdn, no-build, localstorage, static-site, package-json]
priority: high
dependencies: [coding-system]
related_skills: [html-structure, css-styling, frontend-scaffold, coding-system]
fallback_skills: [frontend-scaffold]
version: 1.0.0
---

# Vanilla JavaScript Skill

## Goal
This agent builds small, self-contained browser projects that must run by opening `index.html`
directly (or being served as static files) - there is no build pipeline, no `node_modules`, and
no server-side runtime for the page's own logic. This skill is the hard constraint set for any
plan step whose job is writing JavaScript behavior: it exists because a model given a JS task
defaults to what it has seen most in training - `npm install <library>`, a bundler config, a
backend API call for persistence - none of which work in this project shape and all of which
this skill explicitly forbids.

## When to Use
- The CURRENT plan step's own title/description is about behavior/interactivity: e.g.
  "JavaScript Funktionalität implementieren", "add the theme toggle", "wire up localStorage
  persistence", "implement the timer/countdown/calculator logic".
- NOT for the HTML skeleton (see `html-structure`) or CSS rules (see `css-styling`) - if a
  toggle needs both a CSS rule for `.is-open`/`[data-theme="dark"]` AND the JS that flips it,
  the CSS rule belongs to the styling step; only the flipping logic belongs here.
- Applies to EVERY JavaScript-writing step in a static/vanilla project produced by this agent,
  not only ones that explicitly say "vanilla" - these are the project's default constraints,
  not an opt-in style choice.

## The Hard Rules

### 1. No Node.js/npm runtime dependencies, no build step
- Never run `npm install`, `npm init` for a real package graph, `pnpm add`, `yarn add`, or any
  command that populates `node_modules` for something the BROWSER will execute. This project
  ships raw `.js` files the browser loads directly - there is no bundler (no webpack/vite/esbuild
  build step) turning them into something else first.
- Never write `require("...")` or a bare-specifier `import x from "some-npm-package"` in a file
  the browser loads - the browser cannot resolve either without a bundler, and there is none
  here. The one exception is a genuine ES module import from a full URL (see rule 2) - a bare
  specifier with no protocol is always a build-step assumption and always wrong here.
- If the verification command for this project happens to be an npm script (lint/type-check),
  that is a DEV-time tooling concern, unrelated to what ships to the browser - it does not
  license adding a runtime dependency.

### 2. Third-party code only via CDN, never installed
- Need a library (a date formatter, a charting library, a small utility)? Load it with a
  `<script src="https://cdn.jsdelivr.net/npm/<package>@<version>/dist/<file>.min.js"></script>`
  tag in the HTML (structure step's file, referenced here) or, for ESM-style code, an import
  from a full CDN URL:
  ```js
  import { debounce } from "https://cdn.jsdelivr.net/npm/lodash-es@4.17.21/lodash.js";
  ```
- ALWAYS pin an exact version in the CDN URL (`@4.17.21`, not `@latest`) - an unpinned CDN
  import can change behavior under the user without any change to this project's own files.
- Prefer writing the ~20 lines of vanilla JS yourself over pulling in a library for something
  trivial (a debounce, a simple date format, a class-toggle). A CDN dependency is still a
  dependency: it can go down, drift, or add page-load latency for functionality this system can
  write directly.
- Never suggest or perform an `npm install` "so it's easier to import" - that would silently
  break the "open `index.html` directly, no build step" contract this skill exists to protect.

### 3. Vanilla JavaScript - no framework by default
- Write plain DOM APIs (`document.querySelector`, `addEventListener`, `classList`,
  `dataset`, template literals for small HTML fragments) - not React/Vue/Svelte/jQuery. This
  project's projects are small enough that vanilla JS is simpler and has zero dependency
  surface, which is the point.
- If the goal explicitly asks for a framework, that is a different kind of project (see
  `phaser-game-scaffold` for the one framework-shaped exception already supported) and this
  skill's "vanilla only" default does not apply - but absent an explicit framework request,
  default to vanilla every time, even for state-heavy UI.
- Wrap DOM-touching code in
  `document.addEventListener("DOMContentLoaded", () => { ... })` (or use `defer` on the
  `<script>` tag, not both redundantly) so it runs after the structure step's markup exists,
  and guard every element lookup (`if (!el) return;`) before attaching listeners - a script that
  assumes an element exists throws and silently breaks every listener queued after it.

### 4. State persists only in the browser's own localStorage
- Any state this project needs to remember between visits (a theme choice, a saved timer, a
  todo list, settings) is written with `localStorage.setItem(key, JSON.stringify(value))` and
  read back with `JSON.parse(localStorage.getItem(key) ?? "null")` - never a backend endpoint,
  a database, a cookie-based session, or `sessionStorage` (which does not survive a closed tab,
  and this system's projects are expected to remember state across visits, not just within one).
- Namespace every key so this project's data cannot collide with another static project the
  user might open from the same origin/file context, e.g. `"<project-slug>:theme"` rather than
  the bare `"theme"`.
- Wrap every `localStorage` read/write in try/catch - private browsing, a full storage quota, or
  a disabled-storage browser setting all make it throw; the page must still function (falling
  back to an in-memory default) rather than crash the whole script.
  ```js
  const STORAGE_KEY = "my-project:settings";
  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") ?? defaultSettings;
    } catch {
      return defaultSettings;
    }
  }
  function saveSettings(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable - state simply won't persist this session, page still works */
    }
  }
  ```
- If the goal genuinely needs data shared ACROSS devices/users (not just persisted on one
  browser), that is a backend feature outside this skill's scope entirely - flag it explicitly
  rather than quietly building a fake multi-user feature on top of single-browser localStorage.

### 5. Always create/maintain a `package.json` - as a metadata manifest, not a dependency list
- Every project this agent builds gets a `package.json` at the project root, even though
  nothing is ever installed into it. Its purpose is project IDENTIFICATION, not dependency
  management: a name, description, and version any tool or human opening the folder later can
  read at a glance.
- Minimum required fields: `name` (kebab-case, matching the project), `version` (start at
  `"1.0.0"` for a fresh project, bump on meaningful later changes), `description` (one sentence,
  what this project is), `private: true` (this is never meant to be published to a registry).
- `"dependencies"` and `"devDependencies"` MUST stay absent or empty (`{}`) - their presence
  with real entries contradicts rule 1's "no npm runtime dependencies" and implies an
  `npm install` step this project does not have. If you referenced a CDN library, list it under
  a plain informational field instead (e.g. `"cdnDependencies": ["lodash-es@4.17.21"]`), never
  under `dependencies`.
- `"scripts"` may stay empty, or may document how a human serves the folder locally (e.g.
  `"start": "npx serve ."`) - that command is a DEV convenience run by a human via `npx`
  (no install), never something this agent's own verification step depends on.
- Update `package.json` whenever the project's name/description meaningfully changes across a
  multi-attempt run - do not leave it describing an earlier, discarded version of the project.

```json
{
  "name": "premium-dashboard-clock",
  "version": "1.0.0",
  "description": "A single-page dashboard with a live clock, timezone picker, and dark/light mode, built as static HTML/CSS/JS.",
  "private": true,
  "author": "",
  "license": "UNLICENSED",
  "dependencies": {},
  "devDependencies": {},
  "cdnDependencies": [],
  "scripts": {
    "start": "npx serve ."
  }
}
```

## Common Mistakes to Avoid
- Running `npm install` for ANY package "to make the timezone logic easier" - use the built-in
  `Intl.DateTimeFormat`/`Intl.supportedValuesOf("timeZone")` APIs, which need no dependency at
  all for exactly this kind of task.
- Writing `import dayjs from "dayjs"` (bare specifier) instead of a pinned CDN URL, or instead
  of using native `Date`/`Intl` - a bare specifier silently fails to resolve in a browser with
  no bundler and breaks the entire script.
- Persisting state with a `fetch()` call to a backend the project doesn't have, or inventing one
  - if nothing else in the plan describes a server, state persistence means `localStorage`.
- Shipping a `package.json` with `"dependencies": { "chart.js": "^4.4.0" }` after loading Chart.js
  via CDN - that field asserts an `npm install` step that never runs here and will mislead
  anyone who later runs `npm install` expecting it to matter.
- Omitting `package.json` entirely because "it's just a static site" - this skill requires one
  regardless, purely as a project manifest.
- Reaching for a framework (even a small one) by default instead of the ~20-40 lines of vanilla
  DOM code the task actually needs.
