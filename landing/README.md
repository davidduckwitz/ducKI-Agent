# DucKI Agent - Landingpage & API

Externe Landingpage mit API für den DucKI Agent.

## 📁 Struktur

```
landing/
├── index.html                    # Hauptseite
├── tools.html                    # Tools-Katalog
├── skills.html                   # Skills-Katalog
├── documentation.html            # Dokumentation
├── api-docs.html                 # API-Dokumentation
├── about.html                    # Über das Projekt
│
├── api/
│   ├── index.php                # API Entry Point
│   ├── config.php               # Konfiguration
│   ├── lib/
│   │   └── JsonLoader.php       # Hilfsfunktionen
│   └── data/
│       ├── tools.json           # Tools-Metadaten (17 Tools)
│       └── skills.json          # Skills-Metadaten (23+ Skills)
│
├── assets/
│   ├── css/
│   │   └── style.css            # Custom Styles
│   └── js/
│       └── main.js              # JavaScript Utilities
│
└── README.md                     # Diese Datei
```

## 🚀 Installation

### Voraussetzungen
- PHP 7.4+ (für die API)
- Webserver (Apache/Nginx)
- Moderne Browser für die Frontend-Seiten

### Deployment

1. **Kopieren Sie die `landing` Verzeichnis auf Ihren Server:**
   ```bash
   scp -r landing/ user@server:/var/www/ducki-landing/
   ```

2. **Konfigurieren Sie den Webserver:**
   ```nginx
   server {
       listen 80;
       server_name ducki-ai-agent.davidduckwitz.de;
       root /var/www/ducki-landing;
       index index.html;

       # PHP API
       location /api {
           try_files $uri $uri/ /api/index.php?$query_string;
       }

       # HTML-Dateien
       location / {
           try_files $uri $uri/ /index.html;
       }
   }
   ```

3. **Aktivieren Sie PHP (falls noch nicht geschehen):**
   ```nginx
   location ~ \.php$ {
       fastcgi_pass unix:/var/run/php/php-fpm.sock;
       fastcgi_index index.php;
       include fastcgi_params;
   }
   ```

## 📚 Seiten

### Hauptseite (`index.html`)
- Hero-Section mit Feature-Übersicht
- Quick Facts (16 Tools, 23+ Skills, etc.)
- Kern-Fähigkeiten
- Besonderheiten
- Architektur-Übersicht
- Quickstart (3 Minuten Setup)
- Support & Spenden

### Tools-Katalog (`tools.html`)
- Alle 17 Tools aufgelistet
- Kategorisiert nach: Core, Execution, Orchestration, Intelligence, Integration
- Suchfunktion
- Filter nach Kategorie
- Links zu Detailseiten

### Skills-Katalog (`skills.html`)
- Alle 23+ Skills aufgelistet
- Kategorisiert nach: Workflow & Planning, Code & Development, Knowledge & Data, System & Utility
- Suchfunktion
- Filter nach Kategorie
- Abhängigkeiten anzeigen

### Dokumentation (`documentation.html`)
- Quickstart
- Ressourcen-Links
- Setup Hinweise
- Architektur-Übersicht
- Provider-Setup
- FAQ

### API-Dokumentation (`api-docs.html`)
- Base URL
- Alle Endpunkte dokumentiert
- Response Format
- Error Handling
- Integration Beispiele (JavaScript, Python)

### Über Projekt (`about.html`)
- Projekbeschreibung
- Developer-Info
- GitHub Links
- Support & Spenden
- Lizenz-Info
- Community

## 🔌 API Endpunkte

### Health Check
```
GET /api/health
```
Status der API und Datendateien.

### Tools
```
GET /api/tools                    # Alle Tools
GET /api/tools/:id                # Spezifisches Tool
GET /api/tools?category=Core      # Nach Kategorie filtern
GET /api/tools?search=filesystem  # Suchen
```

### Skills
```
GET /api/skills                              # Alle Skills
GET /api/skills/:id                          # Spezifisches Skill
GET /api/skills?category=Code & Development # Nach Kategorie filtern
GET /api/skills?search=review                # Suchen
```

### Dokumentation
```
GET /api/docs/:id      # Detaillierte Dokumentation für Tool/Skill
GET /api/categories    # Alle Kategorien
```

### Response Format
```json
{
  "success": true,
  "data": { /* Actual data */ },
  "timestamp": "2024-07-25T10:00:00+02:00"
}
```

## 🎨 Design

- **Framework**: Tailwind CSS (via CDN)
- **Color Scheme**: Blue/Purple with Dark Mode Support
- **Responsive**: Mobile-first Design
- **Accessibility**: WCAG 2.1 AA Standard
- **Performance**: Optimized, no build step required

## 📊 Tool & Skill Kategorien

### Tools
- **Core**: Filesystem
- **Execution**: Browser, Git, Shell, HTTP, Task, Plan, Weather Summary
- **Orchestration**: Workflow, CronJob
- **Intelligence**: Memory, Skill Manage, MCP, Tool Factory
- **Integration**: Browser, Gateway, History, Project

### Skills
- **Workflow & Planning**: Plan, Auto-Plan, Workflow-Orchestrator, Plan-Import
- **Code & Development**: Coding-System, Code-Review, Test-Driven-Development, Security-Skill
- **Knowledge & Data**: LLM-Wiki, History-Search, Shared-Workspace-Ops, Shared-Workspace-API-First
- **System & Utility**: CronJobs, Discord, MCP-Integration, Browser-Control, Date & Time, Tool-Orchestration, Tasks-Kanban, JSON-Tool-Format, Fast-Answer
- **Utilities**: BTC-Puzzle-Solver, BTC-Puzzle-Solve

## 🔐 Security

- Öffentliche API (keine Authentifizierung)
- CORS enabled
- Input Validation in PHP
- XSS Protection via Content Security Policy (empfohlen)

## 📈 SEO

- Semantic HTML
- Meta Tags auf allen Seiten
- Open Graph Tags (optional)
- Structured Data (optional)

## 🌐 Deployment Optionen

### Option 1: Shared Hosting
- Einfaches Upload via FTP
- PHP-Support erforderlich
- Kein Build-Step nötig

### Option 2: VPS/Dedicated Server
- Volle Kontrolle über Konfiguration
- HTTPS empfohlen
- Nginx/Apache konfigurierbar

### Option 3: Docker
```dockerfile
FROM php:8.1-apache
COPY landing/ /var/www/html/
RUN a2enmod rewrite
```

## 📝 Lizenz

MIT Lizenz - Siehe LICENSE in Repository

## 🤝 Beiträge

Contributions sind willkommen! Bitte:
1. Fork das Projekt
2. Erstellen Sie einen Feature-Branch
3. Commiten Sie Ihre Änderungen
4. Push zum Branch
5. Öffnen Sie einen Pull Request

## 💬 Support

- GitHub Issues: https://github.com/davidduckwitz/ducKI-Agent/issues
- Dokumentation: https://www.davidduckwitz.de/ducki-agent

## 🎯 Zukunft

Geplante Features:
- [ ] Dynamische Tool/Skill Installation via Web UI
- [ ] Versionshistorie für Tools/Skills
- [ ] Download-Statistiken
- [ ] Community-Beiträge Portal
- [ ] Newsletter/Updates System
