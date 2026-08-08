#!/usr/bin/env bash
#
# DucKI Agent — Universal Installer (macOS / Linux / WSL / Raspberry Pi)
# ---------------------------------------------------------------------
# Erst-Installation UND Reparatur in einem Schritt:
#   - prüft/installiert Voraussetzungen (git, Node >= 20, pnpm >= 9)
#   - klont das Repository (oder aktualisiert ein vorhandenes)
#   - installiert Dependencies und baut das Projekt
#   - richtet optional einen Autostart-Dienst (systemd) ein
#
# One-Liner (Bootstrap):
#   curl -fsSL https://ducki-ai-agent.davidduckwitz.de/install/install.sh | bash
#
# Optionen (Environment-Variablen):
#   DUCKI_REPO   Repo-URL      (Default: https://github.com/davidduckwitz/ducKI-Agent)
#   DUCKI_BRANCH Branch        (Default: main)
#   DUCKI_DIR    Zielordner    (Default: $HOME/ducki-agent)
#   DUCKI_SERVICE=1            systemd-Dienst einrichten (Linux/Raspberry Pi)
#   DUCKI_NONINTERACTIVE=1     keine Rückfragen
#
set -euo pipefail

REPO="${DUCKI_REPO:-https://github.com/davidduckwitz/ducKI-Agent}"
BRANCH="${DUCKI_BRANCH:-main}"
TARGET="${DUCKI_DIR:-$HOME/ducki-agent}"
NODE_MIN=20
PNPM_MIN=9

# ---- hübsche Ausgabe -------------------------------------------------
if [ -t 1 ]; then B="\033[1m"; G="\033[32m"; Y="\033[33m"; R="\033[31m"; C="\033[36m"; N="\033[0m"; else B=""; G=""; Y=""; R=""; C=""; N=""; fi
say()  { printf "${C}==>${N} %s\n" "$*"; }
ok()   { printf "${G}  ✓${N} %s\n" "$*"; }
warn() { printf "${Y}  !${N} %s\n" "$*"; }
die()  { printf "${R}  ✗ %s${N}\n" "$*" >&2; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }

# ---- Plattform erkennen ---------------------------------------------
OS="$(uname -s)"; ARCH="$(uname -m)"
PKG=""
if has apt-get;   then PKG="apt";
elif has dnf;     then PKG="dnf";
elif has pacman;  then PKG="pacman";
elif has brew;    then PKG="brew";
elif has zypper;  then PKG="zypper";
fi
IS_PI=0; [ -f /proc/device-tree/model ] && grep -qi raspberry /proc/device-tree/model 2>/dev/null && IS_PI=1

printf "\n${B}  DucKI Agent Installer${N}\n"
printf "  OS: %s | Arch: %s | PkgMgr: %s%s\n\n" "$OS" "$ARCH" "${PKG:-none}" "$([ $IS_PI = 1 ] && echo ' | Raspberry Pi')"

sudo_run() { if [ "$(id -u)" = 0 ]; then "$@"; elif has sudo; then sudo "$@"; else die "Root-Rechte nötig für: $*"; fi; }

pkg_install() {
  case "$PKG" in
    apt)    sudo_run apt-get update -y && sudo_run apt-get install -y "$@";;
    dnf)    sudo_run dnf install -y "$@";;
    pacman) sudo_run pacman -Sy --noconfirm "$@";;
    zypper) sudo_run zypper install -y "$@";;
    brew)   brew install "$@";;
    *)      die "Bitte manuell installieren: $*";;
  esac
}

# ---- 1) git ----------------------------------------------------------
say "Prüfe git"
if has git; then ok "git $(git --version | awk '{print $3}')"; else
  warn "git fehlt — installiere"; pkg_install git; ok "git installiert"
fi

# ---- 2) Node.js >= 20 ------------------------------------------------
node_major() { node -v 2>/dev/null | sed 's/^v//; s/\..*//'; }
say "Prüfe Node.js (>= $NODE_MIN)"
if has node && [ "$(node_major)" -ge "$NODE_MIN" ] 2>/dev/null; then
  ok "Node $(node -v)"
else
  warn "Node >= $NODE_MIN fehlt — installiere"
  case "$PKG" in
    apt)    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo_run bash - && pkg_install nodejs;;
    dnf)    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo_run bash - && pkg_install nodejs;;
    brew)   pkg_install node@20;;
    *)      pkg_install nodejs || die "Node bitte manuell installieren (>= $NODE_MIN)";;
  esac
  ok "Node $(node -v)"
fi

# ---- 3) pnpm >= 9 (via corepack) ------------------------------------
# Zwei Stolpersteine bei system-weitem Node (NodeSource/Raspberry Pi):
#   a) `corepack enable` legt einen Symlink neben die node-Binary
#      (z. B. /usr/bin/pnpm) → gehört root, ohne sudo EACCES.
#   b) `pnpm@latest` (>= 11) verlangt Node >= 22.13 (nutzt node:sqlite).
#      Auf Node 20 → ERR_UNKNOWN_BUILTIN_MODULE. Deshalb passende Version wählen.
say "Prüfe pnpm (>= $PNPM_MIN)"
# pnpm-Zielversion an Node-Major koppeln (Override via DUCKI_PNPM_VERSION)
if [ -n "${DUCKI_PNPM_VERSION:-}" ]; then PNPM_PKG="pnpm@${DUCKI_PNPM_VERSION}";
elif [ "$(node_major)" -ge 22 ] 2>/dev/null; then PNPM_PKG="pnpm@latest";
else PNPM_PKG="pnpm@10"; fi

# "pnpm vorhanden" heißt nur: läuft es AUCH? Ein defekter corepack-Shim
# (falsche pnpm-Version) existiert zwar, bricht aber ab → neu einrichten.
pnpm_works() { pnpm --version >/dev/null 2>&1; }

if ! pnpm_works; then
  if has corepack; then
    say "Installiere $PNPM_PKG (kompatibel zu Node $(node -v))"
    # 1) mit Root-Rechten in den System-bin-Pfad (deckt EACCES auf /usr/bin ab)
    if sudo_run corepack enable 2>/dev/null; then
      corepack prepare "$PNPM_PKG" --activate 2>/dev/null || true
    fi
    # 2) Fallback: in ein benutzerschreibbares Verzeichnis im PATH installieren
    if ! has pnpm; then
      mkdir -p "$HOME/.local/bin"
      corepack enable --install-directory "$HOME/.local/bin" 2>/dev/null || true
      corepack prepare "$PNPM_PKG" --activate 2>/dev/null || true
      case ":$PATH:" in *":$HOME/.local/bin:"*) : ;; *) export PATH="$HOME/.local/bin:$PATH"; warn "PATH um \$HOME/.local/bin ergänzt (ggf. dauerhaft in ~/.bashrc eintragen)";; esac
    fi
  fi
  # 3) letzter Fallback: npm global (ebenfalls versionsgepinnt)
  pnpm_works || sudo_run npm install -g "$PNPM_PKG" 2>/dev/null || npm install -g "$PNPM_PKG"
fi
pnpm_works && ok "pnpm $(pnpm -v)" || die "pnpm-Installation fehlgeschlagen"

# ---- 4) Repo klonen / aktualisieren ---------------------------------
if [ -d "$TARGET/.git" ]; then
  say "Vorhandene Installation gefunden → aktualisiere ($TARGET)"
  git -C "$TARGET" fetch origin "$BRANCH"
  git -C "$TARGET" checkout "$BRANCH"
  git -C "$TARGET" pull --ff-only origin "$BRANCH"
else
  say "Klone $REPO ($BRANCH) → $TARGET"
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$TARGET"
fi
ok "Quellcode bereit"

# ---- 5) Dependencies + Build ----------------------------------------
cd "$TARGET"
say "Installiere Dependencies (pnpm install)"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Dependencies installiert"

say "Baue Projekt (pnpm build)"
pnpm build
ok "Build abgeschlossen"

# ---- 6) optional: systemd-Dienst ------------------------------------
if [ "$OS" = "Linux" ] && { [ "${DUCKI_SERVICE:-0}" = "1" ] || { [ "${DUCKI_NONINTERACTIVE:-0}" != "1" ] && [ -t 0 ] && read -r -p "Autostart-Dienst (systemd) einrichten? [y/N] " a && [ "${a:-N}" = "y" ]; }; }; then
  SVC=/etc/systemd/system/ducki-agent.service
  say "Richte systemd-Dienst ein → $SVC"
  sudo_run bash -c "cat > '$SVC'" <<EOF
[Unit]
Description=DucKI Agent
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$TARGET
ExecStart=$(command -v pnpm) dev
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
  sudo_run systemctl daemon-reload
  sudo_run systemctl enable --now ducki-agent
  ok "Dienst 'ducki-agent' aktiv (Logs: journalctl -u ducki-agent -f)"
fi

printf "\n${G}${B}  ✓ Installation abgeschlossen${N}\n"
printf "  Ordner:  %s\n" "$TARGET"
printf "  Starten: ${B}cd %s && pnpm dev${N}\n\n" "$TARGET"
