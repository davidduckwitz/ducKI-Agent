# DucKI Agent - Tool & Skill Installation API

Vollständige Integration für automatische Installation von Tools und Skills im DucKI Agent.

## 🔌 API Endpoints

### Base URL
```
https://api.ducki-agent.davidduckwitz.de/api
```

## Installation Endpoints

### Tools Installieren
```
POST /install/tool/:tool_id
```

**Beispiel:**
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
    "installation_id": "tool-browser-1726234856",
    "installed_at": "2024-07-25T10:00:00+02:00"
  },
  "timestamp": "2024-07-25T10:00:00+02:00"
}
```

### Skills Installieren
```
POST /install/skill/:skill_id
```

**Beispiel:**
```bash
curl -X POST https://api.ducki-agent.davidduckwitz.de/api/install/skill/code-review
```

**Response:**
```json
{
  "success": true,
  "data": {
    "skill_id": "code-review",
    "skill_name": "Code Review",
    "version": "1.0.0",
    "dependencies": ["test-driven-development", "plan"],
    "installation_id": "skill-code-review-1726234856",
    "installed_at": "2024-07-25T10:00:00+02:00"
  },
  "timestamp": "2024-07-25T10:00:00+02:00"
}
```

## Verwaltungs-Endpoints

### Installationshistorie Abrufen
```
GET /installations?type=tool&limit=50
```

Parameter:
- `type` (optional): "tool" oder "skill" zum Filtern
- `limit` (optional): Maximale Ergebnisse (Standard: 50)

**Response:**
```json
{
  "success": true,
  "data": {
    "installations": [
      {
        "id": "tool-browser-1726234856",
        "type": "tool",
        "item_id": "browser",
        "item_name": "Browser Automation",
        "version": "1.2.0",
        "status": "installed",
        "installed_at": "2024-07-25T10:00:00+02:00",
        "source": "https://github.com/davidduckwitz/ducKI-Agent/tree/main/packages/tools/src/browser",
        "auto_install": true
      }
    ],
    "total": 1
  }
}
```

### Installation Entfernen
```
DELETE /uninstall/:installation_id
POST /uninstall/:installation_id
```

**Beispiel:**
```bash
curl -X DELETE https://api.ducki-agent.davidduckwitz.de/api/uninstall/tool-browser-1726234856
```

## Integration im Agent

### TypeScript/JavaScript Integration

```typescript
// Agent Tool für Installation
class ToolInstaller {
  private apiUrl = 'https://api.ducki-agent.davidduckwitz.de/api';

  async installTool(toolId: string): Promise<any> {
    const response = await fetch(`${this.apiUrl}/install/tool/${toolId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    return response.json();
  }

  async installSkill(skillId: string): Promise<any> {
    const response = await fetch(`${this.apiUrl}/install/skill/${skillId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    return response.json();
  }

  async getInstallations(type?: string): Promise<any> {
    const query = type ? `?type=${type}` : '';
    const response = await fetch(`${this.apiUrl}/installations${query}`);
    return response.json();
  }

  async uninstall(installationId: string): Promise<any> {
    const response = await fetch(`${this.apiUrl}/uninstall/${installationId}`, {
      method: 'DELETE'
    });
    return response.json();
  }
}

// Usage
const installer = new ToolInstaller();

// Install Tool
const toolResult = await installer.installTool('browser');
console.log(`Installed: ${toolResult.data.tool_name} v${toolResult.data.version}`);

// Install Skill
const skillResult = await installer.installSkill('code-review');
console.log(`Installed: ${skillResult.data.skill_name} v${skillResult.data.version}`);

// List Installations
const installations = await installer.getInstallations();
console.log(`Total installations: ${installations.data.total}`);
```

### Automation Tool Definition

```yaml
name: "tool-installer"
description: "Install or manage DucKI Agent tools and skills remotely"
category: "integration"
parameters:
  action:
    type: "string"
    enum: ["install-tool", "install-skill", "list", "uninstall"]
    description: "Action to perform"
  item_id:
    type: "string"
    description: "Tool or Skill ID"
  installation_id:
    type: "string"
    description: "Installation ID for uninstall"
```

### Agent Skill für Automatische Installation

```python
# Python Agent Skill
class AutoInstallSkill:
    def __init__(self, api_url="https://api.ducki-agent.davidduckwitz.de/api"):
        self.api_url = api_url

    def install_tool(self, tool_id: str) -> dict:
        """Automatisch ein Tool installieren"""
        response = requests.post(f"{self.api_url}/install/tool/{tool_id}")
        return response.json()

    def install_skill(self, skill_id: str) -> dict:
        """Automatisch ein Skill installieren"""
        response = requests.post(f"{self.api_url}/install/skill/{skill_id}")
        return response.json()

    def list_installations(self, item_type: str = None) -> dict:
        """Alle Installationen auflisten"""
        url = f"{self.api_url}/installations"
        if item_type:
            url += f"?type={item_type}"
        response = requests.get(url)
        return response.json()

    def uninstall(self, installation_id: str) -> dict:
        """Installation entfernen"""
        response = requests.delete(f"{self.api_url}/uninstall/{installation_id}")
        return response.json()

# Verwendung
installer = AutoInstallSkill()

# Tool installieren
result = installer.install_tool("browser")
if result['success']:
    print(f"✓ Installed: {result['data']['tool_name']}")

# Skill mit Abhängigkeiten installieren
result = installer.install_skill("code-review")
if result['success']:
    print(f"✓ Installed: {result['data']['skill_name']}")
    print(f"  Dependencies: {', '.join(result['data']['dependencies'])}")
```

## Verfügbare Tools (17)

```
Core:
- filesystem

Execution:
- browser, git, shell, http, task, plan, weather_summary

Orchestration:
- workflow, cronjob

Intelligence:
- memory, skill_manage, mcp, tool_factory

Integration:
- gateway, history, project
```

## Verfügbare Skills (23+)

```
Workflow & Planning:
- plan, auto-plan, workflow-orchestrator, plan-import

Code & Development:
- coding-system, code-review, test-driven-development, security-skill

Knowledge & Data:
- llm-wiki, history-search, shared-workspace-ops, shared-workspace-api-first

System & Utility:
- cronjobs, discord, mcp-integration, browser-control, datum-uhrzeit-tag
- tool-orchestration, tasks-kanban, json-tool-format, fast-answer

Utilities:
- btc-puzzle-solver, btc-puzzle-solve
```

## Error Handling

### Fehler-Response Format
```json
{
  "error": true,
  "code": "TOOL_NOT_FOUND",
  "message": "Tool nicht gefunden: unknown-tool",
  "timestamp": "2024-07-25T10:00:00+02:00"
}
```

### Mögliche Error-Codes
- `TOOL_NOT_FOUND` - Tool ID existiert nicht
- `SKILL_NOT_FOUND` - Skill ID existiert nicht
- `INSTALL_ERROR` - Installation fehlgeschlagen
- `UNINSTALL_ERROR` - Deinstallation fehlgeschlagen
- `NOT_FOUND` - Installation nicht gefunden
- `METHOD_NOT_ALLOWED` - Falscher HTTP Method

## Verwendungsbeispiele

### Automatische Tool-Installation beim Agent-Start

```typescript
// In Agent Initialization
async function initializeAgent() {
  const installer = new ToolInstaller();
  
  // Required Tools installieren
  const requiredTools = ['filesystem', 'git', 'shell'];
  
  for (const toolId of requiredTools) {
    try {
      const result = await installer.installTool(toolId);
      console.log(`✓ ${result.data.tool_name} installiert`);
    } catch (error) {
      console.error(`✗ Installation fehlgeschlagen: ${error.message}`);
    }
  }
}
```

### Skill Auto-Aktivierung basierend auf Aufgabe

```typescript
// Skill automatisch aktivieren basierend auf Anfrage
async function selectSkillsForTask(taskDescription: string) {
  const installer = new ToolInstaller();
  
  const skillMap = {
    'code review': 'code-review',
    'test': 'test-driven-development',
    'security': 'security-skill',
    'planning': 'plan',
    'workflow': 'workflow-orchestrator'
  };
  
  for (const [keyword, skillId] of Object.entries(skillMap)) {
    if (taskDescription.toLowerCase().includes(keyword)) {
      const result = await installer.installSkill(skillId);
      console.log(`✓ Aktiviert: ${result.data.skill_name}`);
    }
  }
}
```

### Versionskontrolle und Updates

```typescript
async function checkAndUpdateTools() {
  const installer = new ToolInstaller();
  const installations = await installer.getInstallations('tool');
  
  for (const installation of installations.data.installations) {
    console.log(`${installation.item_name} v${installation.version}`);
    
    // Bei Bedarf neu installieren für Updates
    if (installation.status === 'outdated') {
      await installer.installTool(installation.item_id);
    }
  }
}
```

## Sicherheit

- ✅ Keine Authentifizierung erforderlich (offen für alle)
- ✅ Installation ist idempotent (mehrfache Installation ist sicher)
- ✅ Abhängigkeiten werden automatisch geprüft
- ✅ Installations-Historie wird protokolliert

## Rate Limiting

Aktuell nicht implementiert. Empfehlungen:
- Max 10 Installationen pro Minute
- Max 100 Anfragen pro Minute pro IP
- Caching von Metadaten für 1 Stunde

## Feedback & Bugs

Probleme? GitHub Issues:
https://github.com/davidduckwitz/ducKI-Agent/issues

## Lizenz

MIT - Frei verwendbar und modifizierbar
