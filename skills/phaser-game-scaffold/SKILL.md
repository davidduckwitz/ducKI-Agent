---
name: phaser-game-scaffold
description: "Vetted starter boilerplate for a new 2D browser game with Phaser 3 (CDN, no build step) - a working scene/game-loop skeleton to adapt instead of assembling Phaser wiring from scratch."
category: development
tags: [frontend, game, phaser, phaser3, javascript, scaffold, canvas, 2d-game, sprite]
priority: medium
dependencies: [coding-system]
related_skills: [coding-system, frontend-scaffold, code-review]
fallback_skills: [code-review]
version: 1.0.0
---

# Phaser Game Scaffold Skill

## Goal
Give a coding run a small, genuinely working Phaser 3 game skeleton (loads, shows a sprite,
responds to input) instead of hand-assembling `Phaser.Game` config, scene lifecycle methods, and
the preload/create/update wiring from memory - the part most prone to a silent black-screen
failure (wrong config key, scene never added, asset path off by one directory) when generated
free-form.

## When to Use
- Starting a new browser game, arcade-style prototype, or anything the user describes with
  "sprite", "scene", "game loop", "canvas game", or names Phaser directly.
- Adding a NEW scene to an existing Phaser project (e.g. a menu or game-over scene) - reuse the
  scene class shape below even if the overall game already exists.
- NOT for a 3D game, a game needing a bundler-based asset pipeline, or a framework other than
  Phaser - this skeleton deliberately uses the CDN `<script>` tag with no build step, matching
  the plain-static-file projects this system's browser-verify fallback already expects (open
  `index.html` directly, no `npm install`/build required).

## How to Use It
1. EXPLORE first: check for an existing `index.html`/`main.js`/`scenes/` before scaffolding a
   second game loop into a project that already has one.
2. Copy the three files below into the project (`index.html`, `main.js`, `scenes/GameScene.js`),
   then adapt: rename the scene, replace the placeholder asset key/path with what the goal
   actually needs, and extend `create()`/`update()` with the real game logic.
3. Real art assets go under `assets/` (images, spritesheets, audio) - reference them by a
   RELATIVE path from `index.html` (e.g. `assets/duck.png`), never an absolute path; this project
   is served from a per-project URL, not the site root (same rule as `frontend-scaffold`'s
   favicon note - an absolute `/assets/...` path 404s here even though the file exists).
4. If no real art asset exists yet, use `this.add.rectangle(...)` or Phaser's built-in
   `generateTexture`/color-fill sprites as a visible placeholder rather than referencing an image
   file that doesn't exist yet - a missing-texture console error is easy to miss, a visibly wrong
   colored box is not.
5. VERIFY with the browser tool: open `index.html`, take a screenshot, and check the browser
   console for errors (a 404 on the asset path or "Cannot read property of undefined" from a
   scene added before its class was defined are the two most common failures here).
6. As the game grows past one scene, split further scenes into their own file under `scenes/`
   (e.g. `scenes/BootScene.js`, `scenes/MenuScene.js`), each following the same class shape as
   `GameScene.js` below, and list every scene file as its own `<script>` tag in `index.html`
   BEFORE `main.js` (script order matters: a class must be defined before `main.js` references it).

## `index.html`
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Game</title>
  <style>
    html, body { margin: 0; padding: 0; background: #1a1a1a; display: flex; justify-content: center; }
    canvas { image-rendering: pixelated; }
  </style>
</head>
<body>
  <div id="game"></div>
  <!-- Phaser itself, then every scene class, THEN main.js (which references those classes) -->
  <script src="https://cdn.jsdelivr.net/npm/phaser@3.70.0/dist/phaser.min.js"></script>
  <script src="scenes/GameScene.js"></script>
  <script src="main.js"></script>
</body>
</html>
```

## `main.js`
```js
// Central game config. Scene classes (GameScene, and any later BootScene/MenuScene/...) must
// already be defined by the time this file runs - see the <script> order in index.html.
const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  parent: "game",
  backgroundColor: "#2d2d2d",
  physics: {
    default: "arcade",
    arcade: { gravity: { y: 0 }, debug: false },
  },
  scene: [GameScene],
};

new Phaser.Game(config);
```

## `scenes/GameScene.js`
```js
// Classic Phaser 3 scene lifecycle: preload() loads assets, create() builds the initial scene
// graph (runs once), update() runs every frame. Keep heavy logic out of update() where possible -
// it runs ~60 times per second.
class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: "GameScene" });
  }

  preload() {
    // Replace with a real asset once one exists - relative to index.html, never a leading "/".
    // this.load.image("player", "assets/duck.png");
  }

  create() {
    // Placeholder sprite (a colored rectangle) so the scene is visibly correct even before a
    // real asset is added - swap for `this.add.sprite(x, y, "player")` once preload() loads one.
    this.player = this.add.rectangle(400, 300, 32, 32, 0xffcc00);
    this.physics.add.existing(this.player);

    this.cursors = this.input.keyboard.createCursorKeys();
  }

  update() {
    const speed = 200;
    const body = this.player.body;
    body.setVelocity(0);

    if (this.cursors.left.isDown) body.setVelocityX(-speed);
    else if (this.cursors.right.isDown) body.setVelocityX(speed);

    if (this.cursors.up.isDown) body.setVelocityY(-speed);
    else if (this.cursors.down.isDown) body.setVelocityY(speed);
  }
}
```

## Common Mistakes to Avoid
- Do not put `scenes/GameScene.js` (or any scene file) AFTER `main.js` in `index.html` - `main.js`
  references the class by name at load time, so the class must already exist.
- Do not reference an asset path with a leading `/` - it resolves against the site root, not this
  project's own folder (see `frontend-scaffold`'s favicon note for the same underlying rule).
- Do not add `this.physics.add.existing(...)` calls in `update()` - that re-creates a physics body
  every frame instead of once in `create()`, and will visibly break movement/collisions.
- Do not assume a missing asset fails loudly - a wrong image path shows a blank/missing texture,
  not a crash. Always screenshot-check after wiring in a new asset.
