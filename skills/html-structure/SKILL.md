---
name: html-structure
description: "Rules for the HTML-structure step of a coding plan: build a semantic, accessible skeleton only - no inline styling, no script logic, no premature content polish. Use for a plan step whose own scope is 'create the HTML structure/skeleton', not for styling or scripting steps."
category: development
tags: [html, structure, semantic-html, accessibility, scaffold, boilerplate, markup]
priority: medium
dependencies: [coding-system]
related_skills: [css-styling, vanilla-javascript, frontend-scaffold, coding-system]
fallback_skills: [frontend-scaffold]
version: 1.0.0
---

# HTML Structure Skill

## Goal
Give the coding agent a precise, scope-limited contract for a plan step whose own job is
"build the HTML structure" - and nothing else. In a multi-step plan (structure -> styling ->
scripting -> persistence -> verification), the single most common failure this skill fixes is
scope bleed: the model reads "create index.html" and, since it already knows what the finished
page should look like, writes the complete file - Tailwind classes, `<style>` blocks, inline
`onclick` handlers, `<script>` logic - all in the step that was only ever supposed to produce a
skeleton. That collapses the plan into one giant edit, which is exactly what makes the
checklist look "stuck on step 1" to the user: the step never closes because the model is
silently doing steps 2-4's work inside it, and the per-step attribution the checklist relies on
never sees steps 2-4 become "in_progress" at all.

## When to Use
- The CURRENT plan step's own title/description is about structure: e.g. "create the HTML
  skeleton", "HTML-Struktur und Grundgerüst erstellen", "set up the page markup", "scaffold the
  document".
- NOT when the current step is about styling (see `css-styling`), scripting (see
  `vanilla-javascript`), or content copywriting - even if you can see those steps later in the
  same plan. Load and follow THIS skill only while THAT step is `in_progress`.

## The Contract
1. **Structure only, no presentation.** Write semantic HTML5 elements (`<header>`, `<nav>`,
   `<main>`, `<section>`, `<article>`, `<aside>`, `<footer>`) with the classes/ids/data
   attributes later steps will need to hook into - but no `style="..."` attributes, no
   `<style>` block, and no CSS framework classes (Tailwind/Bootstrap/etc.) beyond a bare
   `class="..."` skeleton if the plan step explicitly says which class names the CSS step will
   target. If in doubt, leave the class attribute off entirely rather than guessing at styling
   intent that belongs to a later step.
2. **No script logic.** A single `<script src="script.js" defer></script>` (or
   `type="module"`) tag right before `</body>` is the correct amount of JavaScript for this
   step - one reference to a file the JS step will populate. Never write inline `onclick=`,
   `<script>` bodies with logic, or event-handling code here; that is the vanilla-javascript
   step's job, not this one.
3. **No placeholder-content polish.** Use short, honest placeholder text (`Headline goes
   here`, `Short description.`) rather than spending this step inventing final marketing copy -
   content quality is not what this step is graded on, and rewriting copy later means editing
   text nodes, not restructuring markup.
4. **Always link the files the plan already names.** If the plan's later steps mention
   `styles.css` and `script.js` (or equivalents), reference them from the skeleton now
   (`<link rel="stylesheet" href="styles.css">`, `<script src="script.js" defer>`) even though
   those files do not exist yet - a 404 on a not-yet-created file is expected and harmless; a
   skeleton that forgets to link them means the later steps' work silently never loads.
5. **Mobile-first meta, every time.** `<meta charset="UTF-8">` and
   `<meta name="viewport" content="width=device-width, initial-scale=1.0">` are structural, not
   styling - include them in this step regardless of what the plan step's one-line description
   says, because nothing later will add them if this step skips them.
6. **Accessibility is structural, not a separate polish pass.** One `<h1>` per page, a logical
   heading order (no skipping from `<h2>` to `<h4>`), `alt` text on every `<img>` (empty
   `alt=""` only for purely decorative images), `<label for>` on every form input, and
   `aria-label`/`aria-expanded` on interactive controls that need them (a nav toggle, an
   accordion). These are markup decisions, so they belong here - do not defer them to a later
   "accessibility check" step that only reviews what already exists.
7. **The moment the skeleton is written and reads correctly, close this step.** Call
   `todo:update` for this step's id before starting any file that belongs to the next step -
   see the coding-discipline instructions in the run prompt for why this matters for the
   checklist.

## Minimal Example (what THIS step alone should produce)
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Page Title</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="site-header">
    <nav class="nav" aria-label="Main">
      <a class="nav__brand" href="#top">Brand</a>
      <button class="nav__toggle" type="button" aria-expanded="false" aria-controls="nav-menu">
        <span class="sr-only">Toggle menu</span>
      </button>
      <ul class="nav__menu" id="nav-menu">
        <li><a href="#features">Features</a></li>
        <li><a href="#contact">Contact</a></li>
      </ul>
    </nav>
  </header>

  <main>
    <section class="hero" id="top">
      <h1>Headline goes here</h1>
      <p>Short description of what this page is.</p>
    </section>

    <section class="features" id="features">
      <article class="feature">
        <h2>Feature one</h2>
        <p>Short description.</p>
      </article>
    </section>
  </main>

  <footer class="site-footer">
    <p>&copy; 2026 Brand. All rights reserved.</p>
  </footer>

  <script src="script.js" defer></script>
</body>
</html>
```
Notice what is deliberately absent: no `<style>`, no `style="..."`, no inline `onclick`, no
color/spacing decisions, no final copy. All of that belongs to later steps.

## Common Mistakes to Avoid
- Writing the CSS classes AND their rules in the same step "to save a round trip" - a class
  name in the markup is fine (it documents intent for the CSS step), a `<style>` block is not.
- Adding a `<script>` body instead of an empty `src` reference "since it's only two lines" -
  even two lines belong in `script.js`, written by the JS step, not inlined here.
- Skipping the viewport meta tag because "the plan step only mentioned the skeleton, not mobile
  support" - the viewport meta IS part of the skeleton; a page missing it is not mobile-first
  regardless of what the CSS step adds later.
- Closing this step as `done` before actually re-reading the file back to confirm it parses and
  the later steps' file references are present.
