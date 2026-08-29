---
name: frontend-scaffold
description: "Vetted starter HTML/CSS/JS boilerplate for a new static website, landing page, or UI built from scratch - use instead of generating markup completely free-form."
category: development
tags: [frontend, html, css, javascript, scaffold, landing-page, ui, responsive, static-site]
priority: medium
dependencies: [coding-system]
related_skills: [coding-system, code-review]
fallback_skills: [code-review]
version: 1.0.0
---

# Frontend Scaffold Skill

## Goal
Give a coding run a working, semantic, accessible, mobile-first starting point for a plain
HTML/CSS/JS site instead of hand-writing markup from a blank file every time. A local/small
model produces far fewer structural mistakes (missing viewport meta, non-semantic `<div>` soup,
a nav toggle that silently does nothing) when it adapts a known-good skeleton than when it
free-generates one token at a time.

## When to Use
- Building a new landing page, marketing site, portfolio, or any small multi-section static site.
- Scaffolding the UI shell (header/nav/hero/footer) for a new frontend project before adding
  page-specific content.
- NOT for a single-page app built with a framework (React/Vue/etc.) - this skeleton is plain
  HTML/CSS/JS on purpose, matching what the browser-verify fallback in this system already
  expects (an `index.html` it can open directly, no build step).

## How to Use It
1. EXPLORE first, as always: check whether `index.html`/`styles.css`/`script.js` (or similarly
   named files) already exist in the project. If they do, adapt what's there instead of
   overwriting it - this skeleton is a starting point for a NEW project, not a template to force
   onto an existing one.
2. Copy the three files below, then ADAPT them to the actual goal: replace the placeholder copy,
   section names, and colors; add or remove sections as the goal requires. Never ship the
   placeholder text verbatim.
3. Keep the structure semantic (`<header>`, `<nav>`, `<main>`, `<section>`, `<footer>`) and the
   CSS custom properties at the top of `styles.css` - changing the project's look later then
   means editing a handful of variables, not hunting through every rule.
4. VERIFY as usual: read the files back, and if a browser tool is available, open `index.html`
   and check the mobile nav toggle actually opens/closes (click it, don't just assume the JS is
   wired correctly from reading the code).

## `index.html`
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
        <span class="nav__toggle-bar"></span>
      </button>
      <ul class="nav__menu" id="nav-menu">
        <li><a href="#features">Features</a></li>
        <li><a href="#about">About</a></li>
        <li><a href="#contact">Contact</a></li>
      </ul>
    </nav>
  </header>

  <main>
    <section class="hero" id="top">
      <h1>Headline goes here</h1>
      <p>One or two sentences describing what this is and why it matters.</p>
      <a class="button" href="#contact">Call to action</a>
    </section>

    <section class="features" id="features">
      <article class="feature">
        <h2>Feature one</h2>
        <p>Short description.</p>
      </article>
      <article class="feature">
        <h2>Feature two</h2>
        <p>Short description.</p>
      </article>
      <article class="feature">
        <h2>Feature three</h2>
        <p>Short description.</p>
      </article>
    </section>

    <section class="about" id="about">
      <h2>About</h2>
      <p>Placeholder content.</p>
    </section>

    <section class="contact" id="contact">
      <h2>Contact</h2>
      <form>
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required />
        <button type="submit">Send</button>
      </form>
    </section>
  </main>

  <footer class="site-footer">
    <p>&copy; 2026 Brand. All rights reserved.</p>
  </footer>

  <script src="script.js" defer></script>
</body>
</html>
```

## `styles.css`
```css
:root {
  --color-bg: #ffffff;
  --color-ink: #1a1a1a;
  --color-muted: #5a5a5a;
  --color-accent: #2563eb;
  --color-border: #e5e7eb;
  --space-1: 0.5rem;
  --space-2: 1rem;
  --space-3: 2rem;
  --space-4: 4rem;
  --max-width: 72rem;
  --radius: 8px;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--color-ink);
  background: var(--color-bg);
  line-height: 1.5;
}
h1, h2 { line-height: 1.15; }
img { max-width: 100%; display: block; }

.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap; border: 0;
}

.site-header {
  border-bottom: 1px solid var(--color-border);
  position: sticky;
  top: 0;
  background: var(--color-bg);
  z-index: 10;
}
.nav {
  max-width: var(--max-width);
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2);
}
.nav__brand { font-weight: 700; text-decoration: none; color: var(--color-ink); }
.nav__menu {
  list-style: none;
  display: flex;
  gap: var(--space-3);
  margin: 0; padding: 0;
}
.nav__menu a { text-decoration: none; color: var(--color-ink); }

.nav__toggle {
  display: none;
  background: none;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: var(--space-1);
  cursor: pointer;
}
.nav__toggle-bar,
.nav__toggle-bar::before,
.nav__toggle-bar::after {
  display: block;
  width: 20px;
  height: 2px;
  background: var(--color-ink);
  position: relative;
}
.nav__toggle-bar::before { content: ""; position: absolute; top: -6px; }
.nav__toggle-bar::after { content: ""; position: absolute; top: 6px; }

@media (max-width: 640px) {
  .nav__toggle { display: block; }
  .nav__menu {
    display: none;
    position: absolute;
    top: 100%;
    left: 0; right: 0;
    flex-direction: column;
    gap: 0;
    background: var(--color-bg);
    border-bottom: 1px solid var(--color-border);
    padding: var(--space-2);
  }
  /* JS toggles this class on nav__menu - see script.js. Do not rely on :hover/:focus
     tricks for a real mobile menu, they don't work well with touch. */
  .nav__menu.is-open { display: flex; }
  .nav__menu li { padding: var(--space-1) 0; }
}

.hero {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: var(--space-4) var(--space-2);
  text-align: center;
}
.hero h1 { font-size: clamp(2rem, 5vw, 3.5rem); margin-bottom: var(--space-2); }
.hero p { color: var(--color-muted); max-width: 40rem; margin: 0 auto var(--space-3); }
.button {
  display: inline-block;
  background: var(--color-accent);
  color: white;
  text-decoration: none;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius);
  font-weight: 600;
}

.features {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: var(--space-3) var(--space-2);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-3);
}
.feature { padding: var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius); }

.about, .contact {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: var(--space-3) var(--space-2);
}
.contact form { display: flex; gap: var(--space-1); flex-wrap: wrap; align-items: end; }
.contact label { display: block; font-size: 0.875rem; margin-bottom: var(--space-1); }
.contact input {
  padding: var(--space-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
}
.contact button {
  background: var(--color-accent);
  color: white;
  border: none;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius);
  cursor: pointer;
}

.site-footer {
  border-top: 1px solid var(--color-border);
  padding: var(--space-2);
  text-align: center;
  color: var(--color-muted);
  font-size: 0.875rem;
}
```

## `script.js`
```js
// Mobile nav toggle. Reads/writes aria-expanded so screen readers track the state, and
// toggles a class (not inline styles) so the CSS above stays the single source of truth for
// what "open" looks like.
document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.querySelector(".nav__toggle");
  const menu = document.getElementById("nav-menu");
  if (!toggle || !menu) return;

  toggle.addEventListener("click", () => {
    const isOpen = menu.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(isOpen));
  });

  // Close the menu after a link is clicked (mobile), so navigating doesn't leave it open.
  menu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      menu.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
});
```

## Common Mistakes to Avoid
- Do not inline styles/scripts back into `index.html` "for simplicity" - keep the three-file
  split so a later edit to styling doesn't require touching markup.
- Do not attach the nav-toggle click listener before checking the elements exist (`if (!toggle
  || !menu) return;` above) - a page that reuses this skeleton without the toggle button would
  otherwise throw on load and silently break every other script queued after it.
- Do not remove the `viewport` meta tag or the mobile breakpoint - a scaffold missing either is
  not actually mobile-first, regardless of how the desktop view looks.
