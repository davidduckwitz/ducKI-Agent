# DucKI Agent — Installation & Update

Plattformübergreifende Skripte für **Erst-Installation** und **Update**.
Sie kümmern sich um Voraussetzungen (git, Node ≥ 20, pnpm ≥ 9), klonen/aktualisieren
das Repo, installieren Dependencies und bauen das Projekt.

## Ein-Zeilen-Installation (Bootstrap)

| Plattform | Befehl |
|-----------|--------|
| **macOS / Linux / WSL / Raspberry Pi** | `curl -fsSL https://ducki-ai-agent.davidduckwitz.de/install/install.sh \| bash` |
| **Windows** (PowerShell) | `irm https://ducki-ai-agent.davidduckwitz.de/install/install.ps1 \| iex` |

> Die Skripte liegen sowohl im Repo unter `install/` als auch (gespiegelt) auf der
> Landingpage unter `/install/`, damit sie **ohne** vorherigen Clone abrufbar sind.

## Manuell

```bash
git clone https://github.com/davidduckwitz/ducKI-Agent
cd ducKI-Agent
./install/install.sh          # bzw. .\install\install.ps1 unter Windows
```

## Update

Entspricht dem In-App-**„Update"**-Button (`git pull --ff-only`) **plus** den für
Node nötigen Nachschritten `pnpm install` + `pnpm build` (+ optional Dienst-Neustart).

```bash
./install/update.sh           # macOS / Linux / WSL / Raspberry Pi
.\install\update.ps1          # Windows
```

## Konfiguration (Env-Variablen)

| Variable | Default | Bedeutung |
|----------|---------|-----------|
| `DUCKI_REPO` | `https://github.com/davidduckwitz/ducKI-Agent` | Repository-URL |
| `DUCKI_BRANCH` | `main` | Branch |
| `DUCKI_DIR` | `~/ducki-agent` bzw. `%USERPROFILE%\ducki-agent` | Zielordner |
| `DUCKI_SERVICE` | – | `1` → systemd-Autostart-Dienst (Linux/Raspberry Pi) |
| `DUCKI_NONINTERACTIVE` | – | `1` → keine Rückfragen |

## Voraussetzungen, die automatisch installiert werden

- **git**
- **Node.js ≥ 20** (via NodeSource / winget / Homebrew)
- **pnpm ≥ 9** (via corepack)

## Raspberry Pi

Das POSIX-Skript erkennt den Pi automatisch (`/proc/device-tree/model`) und nutzt
`apt`. Empfohlen: 64-bit Raspberry Pi OS (arm64) und Pi 4/5 mit ≥ 4 GB RAM für den Build.
