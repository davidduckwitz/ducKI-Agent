# 🦆 DucKI Agent - Komplettes Landingpage & API System

**Version 2.0** - Vollständige externe Landingpage mit automatischer Tool/Skill-Installation

## 📦 Was ist enthalten

### ✨ Landingpage (HTML/CSS/JS)
- **Responsive Design** mit Tailwind CSS (CDN)
- **Dark Mode Support**
- **7 Hauptseiten** + dynamische Detailseiten
- **Suchbar & Filterbar** (Tools, Skills)
- **Mobile optimiert**

### 🔌 REST API (PHP 7.4+)
- **17 Tools** - Vollständige Metadaten
- **23+ Skills** - Mit Abhängigkeiten
- **Installation Management** - Automatische Installation
- **Installationshistorie** - Alles protokolliert
- **JSON-basiert** - Einfach zu warten

### 🤖 Agent Integration
- **Automatische Installation** - Agent kann selbst installieren
- **Versionskontrolle** - Abhängigkeiten geprüft
- **Installation-Tracking** - Alle Operationen geloggt
- **TypeScript/JavaScript** - Code-Beispiele inklusive

---

## 📂 Dateistruktur

```
landing/
├── 📄 index.html                 # Hauptseite (Hero, Features)
├── 📄 tools.html                 # Tools-Katalog (1-17)
├── 📄 skills.html                # Skills-Katalog (1-23+)
├── 📄 tool.php                   # Dynamic Tool Details
├── 📄 skill.php                  # Dynamic Skill Details
├── 📄 documentation.html         # Setup & Guides
├── 📄 api-docs.html             # API Reference
├── 📄 about.html                # About/Kontakt/Spenden
│
├── 🗂️ api/
│   ├── 📄 index.php              # API Main Entry Point (Router)
│   ├── 📄 config.php             # Configuration & Response Helpers
│   ├── 🗂️ controllers/
│   │   └── 📄 InstallController.php  # Tool/Skill Installation
│   ├── 🗂️ lib/
│   │   └── 📄 JsonLoader.php     # JSON Search/Filter Utilities
│   └── 🗂️ data/
│       ├── 📄 tools.json         # 17 Tools Metadata
│       ├── 📄 skills.json        # 23+ Skills Metadata
│       └── 📄 installations.json  # Installation History
│
├── 🗂️ assets/
│   ├── 🗂️ css/
│   │   └── 📄 style.css          # Custom Styles & Animations
│   └── 🗂️ js/
│       └── 📄 main.js            # Utilities & Helpers
│
├── 📚 Documentation
│   ├── 📄 README.md              # Landing Page Dokumentation
│   ├── 📄 DEPLOYMENT.md          # Deployment Anleitung (3 Szenarien)
│   ├── 📄 AGENT-INTEGRATION.md   # Agent Integration Guide
│   └── 📄 COMPLETE-SYSTEM.md     # Diese Datei
```

---

## 🚀 Quick Start

### 1. Installation (5 Minuten)

```bash
# Repository klonen
git clone https://github.com/davidduckwitz/ducKI-Agent.git
cd ducKI-Agent/landing

# Kopieren Sie in das Webserver-Verzeichnis
cp -r . /var/www/ducki-landing/

# Permissions setzen
sudo chown -r www-data:www-data /var/www/ducki-landing/
```

### 2. Server-Konfiguration

**Apache (.htaccess):**
```apache
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteRule ^api(.*)$ api/index.php [QSA,L]
</IfModule>
```

**Nginx:**
```nginx
location /api {
    try_files $uri $uri/ /api/index.php?$query_string;
}
```

### 3. Testen

```bash
# Hauptseite
curl -I https://ducki-ai-agent.davidduckwitz.de/

# API Health
curl https://ducki-ai-agent.davidduckwitz.de/api/health

# Tools auflisten
curl https://ducki-ai-agent.davidduckwitz.de/api/tools

# Skill Details
curl https://ducki-ai-agent.davidduckwitz.de/api/skills?search=review
```

---

## 📊 API Referenz

### Endpunkte

| Methode | Endpunkt | Beschreibung |
|---------|----------|-------------|
| GET | `/api/health` | Health Check |
| GET | `/api/tools` | Alle Tools auflisten |
| GET | `/api/tools/:id` | Tool Details |
| GET | `/api/skills` | Alle Skills auflisten |
| GET | `/api/skills/:id` | Skill Details |
| GET | `/api/categories` | Alle Kategorien |
| GET | `/api/docs/:id` | Dokumentation |
| POST | `/api/install/tool/:id` | Tool installieren |
| POST | `/api/install/skill/:id` | Skill installieren |
| GET | `/api/installations` | Installationsverlauf |
| DELETE | `/api/uninstall/:id` | Installation entfernen |

### Beispiel: Tool Installation

```bash
curl -X POST https://api.ducki-agent.davidduckwitz.de/api/install/tool/browser
```

**Response:**
```json
{
  "success": true,
  "data": {
    "tool_id": "browser",
    "tool_name": "Browser Automation",
    "version": "1.2.0",
    "installed_at": "2024-07-25T10:00:00+02:00"
  }
}
```

---

## 🛠️ Tools (17)

| Kategorie | Tools |
|-----------|-------|
| **Core** | filesystem |
| **Execution** | browser, git, shell, http, task, plan, weather_summary |
| **Orchestration** | workflow, cronjob |
| **Intelligence** | memory, skill_manage, mcp, tool_factory |
| **Integration** | gateway, history, project |

### Beispiel: Browser Tool
```typescript
// Tool aktivieren
POST /api/install/tool/browser

// Tool verwenden im Agent
{
  action: 'navigate',
  url: 'https://example.com'
}

{
  action: 'click',
  selector: 'button.submit'
}
```

---

## ⭐ Skills (23+)

| Kategorie | Skills |
|-----------|--------|
| **Workflow & Planning** | plan, auto-plan, workflow-orchestrator, plan-import |
| **Code & Development** | coding-system, code-review, test-driven-development, security-skill |
| **Knowledge & Data** | llm-wiki, history-search, shared-workspace-ops, shared-workspace-api-first |
| **System & Utility** | cronjobs, discord, mcp-integration, browser-control, datum-uhrzeit-tag, tool-orchestration, tasks-kanban, json-tool-format, fast-answer |
| **Utilities** | btc-puzzle-solver, btc-puzzle-solve |

### Beispiel: Code Review Skill
```typescript
// Skill aktivieren
POST /api/install/skill/code-review

// Automatisch verwendet für:
// - "Review this code"
// - "Analyze changes"
// - "Check for bugs"
```

---

## 🔐 Sicherheit

### ✅ Implementiert
- CORS Headers
- Input Validation (PHP)
- XSS Protection (HTML escaping)
- HTTPS Ready (SSL/TLS)
- Permissions Check

### 🛡️ Empfehlungen
- SSL/TLS Zertifikat (Let's Encrypt kostenlos)
- Firewall (nur 80/443 öffnen)
- WAF (Web Application Firewall)
- Regular Updates

---

## 📱 Responsive Design

```
Desktop (1280px+)
├─ Navigation oben
├─ 3-spaltig Layout
└─ Sidebar für Info-Cards

Tablet (768px - 1279px)
├─ Navigation oben
├─ 2-spaltig Layout
└─ Collapsible Sidebar

Mobile (<768px)
├─ Hamburger Menu
├─ 1-spaltig Layout
└─ Stacked Cards
```

---

## 🌙 Dark Mode

Automatisch basierend auf Systemeinstellung:
```css
@media (prefers-color-scheme: dark) {
  /* Dark mode styles */
}
```

Benutzer können auch manuell umschalten via `localStorage`.

---

## ⚡ Performance

### Page Load
- **HTML:** ~50KB
- **CSS:** via CDN (Tailwind)
- **JS:** ~15KB
- **JSON:** ~30KB (cached)

### Optimization
- ✅ Minification ready
- ✅ Gzip compression
- ✅ Caching headers
- ✅ Lazy loading support
- ✅ CDN optimiert

---

## 🔄 Integration mit Agent

### TypeScript Example
```typescript
import fetch from 'node-fetch';

class DucKISkillInstaller {
  private apiUrl = 'https://api.ducki-agent.davidduckwitz.de/api';

  async installSkill(skillId: string) {
    const res = await fetch(`${this.apiUrl}/install/skill/${skillId}`, {
      method: 'POST'
    });
    return res.json();
  }
}

// Verwendung
const installer = new DucKISkillInstaller();
await installer.installSkill('code-review');
```

### Python Example
```python
import requests

api_url = 'https://api.ducki-agent.davidduckwitz.de/api'

# Skill installieren
response = requests.post(f'{api_url}/install/skill/code-review')
print(response.json())

# Tools auflisten
tools = requests.get(f'{api_url}/tools').json()
for tool in tools['data']['tools']:
    print(f"{tool['name']} - {tool['version']}")
```

---

## 📋 Checkliste für Live-Deployment

- [ ] Domain konfiguriert (DNS A Record)
- [ ] SSL/TLS Zertifikat installiert
- [ ] Dateien hochgeladen
- [ ] Permissions gesetzt (755 dirs, 644 files)
- [ ] .htaccess / Nginx Config aktiv
- [ ] API getestet (curl /health)
- [ ] Landingpage lädt (Browser)
- [ ] Tools & Skills suchbar
- [ ] Installation funktioniert
- [ ] Logs überwachen
- [ ] Backup konfiguriert

---

## 🐛 Troubleshooting

### API gibt 404 zurück
```bash
# Apache
sudo a2enmod rewrite
sudo systemctl restart apache2

# Nginx
sudo nginx -t && sudo systemctl reload nginx
```

### JSON-Dateien fehlen
```bash
# Erstellen
touch api/data/installations.json
echo '{"installations":[]}' > api/data/installations.json
chmod 644 api/data/installations.json
```

### PHP wird nicht ausgeführt
```bash
# Checker PHP
php -v
which php-fpm

# Permissions
chmod 644 *.php api/*.php
```

---

## 📈 Metriken & Monitoring

### Wichtige Metriken
- API Response Time (sollte <100ms sein)
- Erfolgreiche Installationen (log-basiert)
- Tool/Skill Popularität (via API Usage)
- Page Load Time (via Browser)

### Log-Dateien
```bash
# Apache Logs
tail -f /var/log/apache2/ducki-agent-access.log
tail -f /var/log/apache2/ducki-agent-error.log

# Nginx Logs
tail -f /var/log/nginx/ducki-agent-access.log
tail -f /var/log/nginx/ducki-agent-error.log
```

---

## 🔗 Links

| Link | Zweck |
|------|-------|
| [Startseite](/) | Hauptseite |
| [Tools](tools.html) | Tools-Katalog |
| [Skills](skills.html) | Skills-Katalog |
| [Doku](documentation.html) | Setup & Guides |
| [API Docs](api-docs.html) | API Referenz |
| [Über uns](about.html) | About/Kontakt |
| [GitHub](https://github.com/davidduckwitz/ducKI-Agent) | Source Code |
| [Agent Integration](AGENT-INTEGRATION.md) | Integration Guide |

---

## 📞 Support

- **Email:** davidduckwitz@googlemail.com
- **GitHub Issues:** https://github.com/davidduckwitz/ducKI-Agent/issues
- **Website:** https://www.davidduckwitz.de/

---

## 📜 Lizenz

MIT License - Frei verwendbar, modifizierbar und weiterverteilbar

## 🙏 Danksagungen

Gebaut mit ❤️ von David Duckwitz in Fulda, Hessen, Deutschland

---

## Version History

### v2.0 (2024-07-25) ✨ NEW
- ✅ Vollständige Landingpage mit allen Seiten
- ✅ Dynamische PHP-Detailseiten
- ✅ Installation Management API
- ✅ Agent Integration Dokumentation
- ✅ Deployment Anleitung (3 Szenarien)
- ✅ Suchfunktion & Filterung
- ✅ Dark Mode Support

### v1.0 (2024-07)
- Basis-HTML Seiten
- Tools & Skills JSON

---

**Bereit zu starten? Siehe [DEPLOYMENT.md](DEPLOYMENT.md) für vollständige Anleitung.**
