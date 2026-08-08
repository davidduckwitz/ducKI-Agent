#!/usr/bin/env bash
#
# DucKI Agent — Updater (macOS / Linux / WSL / Raspberry Pi)
# ---------------------------------------------------------
# Führt exakt die Schritte aus, die auch der In-App-"Update"-Button anstößt,
# plus die für Node-Projekte nötigen Nachschritte:
#   git pull  →  pnpm install  →  pnpm build  →  optional Dienst-Neustart
#
# Aufruf (im Projektordner ODER mit DUCKI_DIR):
#   ./install/update.sh
#   DUCKI_DIR=$HOME/ducki-agent ./install/update.sh
#
set -euo pipefail

TARGET="${DUCKI_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BRANCH="${DUCKI_BRANCH:-$(git -C "$TARGET" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"

if [ -t 1 ]; then B="\033[1m"; G="\033[32m"; C="\033[36m"; N="\033[0m"; else B=""; G=""; C=""; N=""; fi
say() { printf "${C}==>${N} %s\n" "$*"; }
ok()  { printf "${G}  ✓${N} %s\n" "$*"; }

[ -d "$TARGET/.git" ] || { echo "Kein Git-Repo unter $TARGET" >&2; exit 1; }
cd "$TARGET"

say "Aktueller Stand"
BEFORE="$(git rev-parse --short HEAD)"

# Sauberer Worktree wird erwartet (wie in der App); sonst abbrechen.
if [ -n "$(git status --porcelain)" ]; then
  echo "Worktree nicht sauber — bitte committen oder stashen. Abbruch." >&2
  exit 1
fi

say "git pull --ff-only origin $BRANCH"
git fetch origin "$BRANCH"
git pull --ff-only origin "$BRANCH"
AFTER="$(git rev-parse --short HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  ok "Bereits aktuell ($AFTER) — kein Rebuild nötig."
  exit 0
fi
ok "Aktualisiert: $BEFORE → $AFTER"

say "pnpm install"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Dependencies aktuell"

say "pnpm build"
pnpm build
ok "Build abgeschlossen"

# Dienst neu starten, falls als systemd-Service installiert
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^ducki-agent\.service'; then
  say "Starte Dienst neu"
  { sudo systemctl restart ducki-agent && ok "Dienst neu gestartet"; } || true
fi

printf "\n${G}${B}  ✓ Update abgeschlossen (%s)${N}\n\n" "$AFTER"
