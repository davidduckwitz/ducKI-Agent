---
name: css-styling
description: "Rules for the CSS/styling step of a coding plan: theme via CSS custom properties, mobile-first responsive breakpoints, dark/light mode, and premium visual polish (glow/shadow/gradient effects) - scoped strictly to presentation, never markup or logic. Use for a plan step whose own scope is styling, not structure or scripting."
category: development
tags: [css, styling, design, responsive, dark-mode, tailwind, theming, accessibility]
priority: medium
dependencies: [coding-system]
related_skills: [html-structure, vanilla-javascript, frontend-scaffold, coding-system]
fallback_skills: [frontend-scaffold]
version: 1.0.0
---

# CSS Styling Skill

## Goal
Give the coding agent a precise, scope-limited contract for a plan step whose own job is
"style the page" - after the structure step already produced the markup, and before or
alongside the JavaScript step wires up interactivity. The step should turn a bare skeleton into
a finished visual design without touching markup structure or adding behavior logic, so that
each plan step stays independently reviewable and closeable.

## When to Use
- The CURRENT plan step's own title/description is about visuals: e.g. "Tailwind CSS Styling
  implementieren", "implement the stylesheet", "dark/light mode", "responsive design", "premium
  dashboard look", "glow effects".
- NOT when the current step is HTML structure (see `html-structure`) or JavaScript behavior
  (see `vanilla-javascript`) - even if the visual design depends on a class toggled by JS (e.g.
  `.is-dark`). Write the CSS RULES for that class here; the JS that toggles the class belongs to
  the scripting step.

## The Contract
1. **Theme via CSS custom properties, not scattered literals.** Define every color, spacing
   unit, radius, and font-size the design needs as `--variables` on `:root` (and a
   `[data-theme="dark"]`/`.dark` override block for dark mode - see below). Every rule below
   that block should reference `var(--...)`, never a hard-coded hex value repeated across
   selectors - a later re-theme then means editing a handful of variables, not hunting through
   every rule.
2. **Mobile-first breakpoints.** Write the unprefixed rules for the smallest viewport first,
   then layer `@media (min-width: ...)` overrides upward (640px/768px/1024px/1280px are
   reasonable defaults unless the plan specifies otherwise) - never the other way around
   (desktop-first with `max-width` overrides), which tends to leave small-viewport styles as an
   afterthought.
3. **Dark/light mode as a data attribute or class, driven by CSS variables.** Prefer:
   ```css
   :root {
     --color-bg: #ffffff;
     --color-ink: #0f172a;
     --color-accent: #2563eb;
   }
   [data-theme="dark"] {
     --color-bg: #0f172a;
     --color-ink: #e2e8f0;
     --color-accent: #60a5fa;
   }
   body { background: var(--color-bg); color: var(--color-ink); }
   ```
   over `prefers-color-scheme` alone when the plan step calls for a user-controlled toggle (a
   media query cannot be toggled by a button click; the JS step needs an attribute/class it can
   flip). Still add a `@media (prefers-color-scheme: dark)` fallback under `:root:not([data-theme])`
   so the page respects system preference before the user has made an explicit choice, exactly
   the pattern used for artifacts elsewhere in this system.
4. **"Premium" visual effects, done cheaply.** A glow effect is a `box-shadow`/`filter:
   drop-shadow(...)` with a color pulled from `var(--color-accent)`, not an image asset. A
   gradient background is `background: linear-gradient(...)` using theme variables, not a
   hard-coded pair of colors that breaks dark mode. Keep effects GPU-cheap: prefer
   `transform`/`opacity`/`box-shadow` transitions over animating `width`/`height`/`top`/`left`,
   which forces layout recalculation on every frame.
5. **Never touch markup or add behavior.** Do not add/remove/rename HTML elements or classes
   the structure step already wrote (if a hook class is missing, that is a structure-step gap -
   flag it, do not silently patch markup from inside a styling step). Do not write
   `<script>`/`onclick` - `:hover`/`:focus`/`:checked`/`:target` pseudo-classes cover pure-CSS
   interactivity; anything needing JS state belongs to the scripting step, which this step
   should assume will toggle a class or attribute this CSS already has a rule for.
6. **Accessible by default, not as an afterthought.** Maintain at least 4.5:1 contrast between
   text and background in BOTH themes (verify the dark-mode override doesn't wash out `--color-
   ink` against `--color-bg`), keep a visible `:focus-visible` outline (never `outline: none`
   without a replacement focus style), and respect
   `@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none
   !important; } }` for any non-essential animation/glow-pulse effect.
7. **Close the step the moment the stylesheet is written and visually checked** (read it back,
   and if a browser tool is available, actually look at both themes/breakpoints) - do not wait
   for the JS step or the final verification command before marking THIS step done.

## Reference Skeleton (theme + responsive + dark mode)
```css
:root {
  --color-bg: #ffffff;
  --color-ink: #0f172a;
  --color-muted: #64748b;
  --color-accent: #2563eb;
  --color-border: #e2e8f0;
  --space-1: 0.5rem;
  --space-2: 1rem;
  --space-3: 2rem;
  --space-4: 4rem;
  --radius: 12px;
  --shadow-glow: 0 0 24px color-mix(in srgb, var(--color-accent) 45%, transparent);
}

[data-theme="dark"] {
  --color-bg: #0b1220;
  --color-ink: #e2e8f0;
  --color-muted: #94a3b8;
  --color-accent: #60a5fa;
  --color-border: #1e293b;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    --color-bg: #0b1220;
    --color-ink: #e2e8f0;
    --color-muted: #94a3b8;
    --color-accent: #60a5fa;
    --color-border: #1e293b;
  }
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-ink);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.5;
  transition: background 0.2s ease, color 0.2s ease;
}

:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }

.card {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: var(--space-3);
}
.card--glow { box-shadow: var(--shadow-glow); }

@media (min-width: 768px) {
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--space-3); }
}
@media (min-width: 1024px) {
  .grid { grid-template-columns: repeat(3, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
```

## Common Mistakes to Avoid
- Hard-coding a second set of colors for dark mode instead of overriding the SAME variables -
  doubles maintenance and drifts the two themes apart over time.
- Desktop-first CSS (`@media (max-width: ...)` overrides on top of unprefixed desktop rules) -
  produces worse results on the majority-mobile traffic this system's static sites are usually
  built for.
- Adding a theme-toggle `<script>` block inside the stylesheet step "just to get it working" -
  write the CSS rule for `[data-theme="dark"]`, leave the actual toggle (reading/writing
  `localStorage`, flipping the attribute) to the `vanilla-javascript` step.
- `outline: none` without a `:focus-visible` replacement - passes a visual QA glance but fails
  keyboard navigation immediately.
- Animating layout properties (`width`, `top`, `margin`) for a "premium" glow/hover effect
  instead of `transform`/`box-shadow`/`opacity` - causes visible jank, especially on lower-end
  devices.
