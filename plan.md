## 🚀 Detaillierter Entwicklungsplan: DucKI Agent für Node.js
Basierend auf Ihrem Entwicklungsplan und Ihren Präferenzen habe ich einen umfassenden, maßgeschneiderten Plan erstellt.

## 📋 Zusammenfassung der Strategie
Fokus: KI Coding Agent mit lokaler LLM-Unterstützung (LM Studio + OpenRouter)

Prioritäten:

Phasen 1-4: Grundlegendes Framework aufbauen
Phasen 5-6: Wichtige Tools (Filesystem, Browser, HTTP)
Phase 8: Planner für Coding-Agent
Phase 11: Sofortiges Dashboard für sofortiges Testing
Phasen 12-18: Vollständiges Frontend und Fortgeschrittene Features

## 🗓️ Detaillierte Entwicklungsphasen

## Phase 1: Monorepo & Infrastruktur ⏱️ 1-2 Tage
Ziel: Projektstruktur erstellen und grundlegende Tools einrichten

Schritte:

Node.js 22+ Installation und Validierung

pnpm Installation und Workspace Setup

Monorepo-Struktur erstellen:

ducki-node/
├── apps/
│   ├── server/ (Express Server)
│   ├── web/ (React Dashboard)
│   └── cli/ (CLI Tools)
├── packages/
│   ├── shared/ (Typedefinitionen, Utilities)
│   ├── logger/ (Logging-System)
│   ├── database/ (Drizzle ORM Setup)
│   ├── agent/ (Kern-Agent-Logik)
│   ├── planer/ (Planning-Modul)
│   ├── memory/ (Memory-System)
│   ├── tools/ (Tool-System)
│   ├── providers/ (LLM-Provider Interface)
│   ├── mcp/ (MCP Integration)
│   └── scheduler/ (Scheduler)
├── storage/ (Datenbankdateien, Downloads)
├── projects/ (Projektdaten)
├── plugins/ (Plugin-System)
├── docs/ (Dokumentation)
└── tests/ (Test-Dateien)
Copy
TypeScript Konfiguration erstellen (strict Mode, ESM)

ESLint + Prettier Setup

package.json Konfiguration

tsconfig.json erstellen

Logger-System erstellen (strukturierte Logs)

.env.example Datei erstellen

pnpm dev Skript erstellen

Tests: pnpm dev startet erfolgreich

Definition of Done:

✅ Projektstruktur erstellt
✅ TypeScript-Konfiguration (strict, ESM)
✅ pnpm Workspace funktioniert
✅ ESLint + Prettier konfiguriert
✅ Logger-System erstellt
✅ .env Template erstellt
✅ pnpm dev startet ohne Fehler

## Phase 2: Datenbank ⏱️ 1-2 Tage
Ziel: SQLite-Datenbank mit Drizzle ORM erstellen

Technologien:

SQLite
better-sqlite3
Drizzle ORM
Zod (Schema Validierung)
Datenbank-Schema (9 Tabellen):

// packages/database/schema.ts

// conversations: Gespräche speichern
export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  projectId: integer("project_id").references(() => projects.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// messages: Chat-Nachrichten speichern
export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").references(() => conversations.id),
  role: text("role").notNull(), // user, assistant, system, tool
  content: text("content").notNull(),
  toolCallId: text("tool_call_id"),
  toolResult: text("tool_result"),
  createdAt: text("created_at").notNull(),
});

// projects: Projekte verwalten
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  folder: text("folder"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// tasks: Aufgaben verwalten
export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").references(() => projects.id),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull(), // pending, running, completed, failed
  priority: text("priority").notNull(), // low, medium, high
  subtasks: text("subtasks"),
  result: text("result"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// tools: Tool-Definitionen
export const tools = sqliteTable("tools", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  enabled: integer("enabled").notNull().default(1),
  configSchema: text("config_schema"),
  lastUsed: text("last_used"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// memories: Kurzzeit-Memory
export const memories = sqliteTable("memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").references(() => conversations.id),
  type: text("type").notNull(), // short-term, long-term
  content: text("content").notNull(),
  importance: integer("importance").notNull().default(1),
  createdAt: text("created_at").notNull(),
});

// embeddings: Embeddings für Vector Search
export const embeddings = sqliteTable("embeddings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  content: text("content").notNull(),
  embedding: text("embedding").notNull(),
  metadata: text("metadata"),
  createdAt: text("created_at").notNull(),
});

// settings: Einstellungen
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// logs: Log-Aufzeichnungen
export const logs = sqliteTable("logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  level: text("level").notNull(), // error, warn, info, debug
  message: text("message").notNull(),
  context: text("context"),
  timestamp: text("timestamp").notNull(),
});
Copy
Erstellen der Dateien:

packages/database/index.ts
packages/database/schema.ts
packages/database/migrations/
packages/database/index.ts - Database-Klasse erstellen
Tests erstellen für jedes Schema
Definition of Done:

✅ SQLite-Datenbank erstellt
✅ Drizzle ORM konfiguriert
✅ 9 Tabellen mit Zod-Validierung definiert
✅ Migration-System erstellt
✅ Database-Klasse mit CRUD-Operationen
✅ Tests für alle Schemas

## Phase 3: LLM Provider ⏱️ 1-2 Tage
Ziel: Einheitliches Provider-Interface erstellen

Technologien:

TypeScript Generics
OpenAI SDK
OpenRouter SDK
Ollama SDK
LM Studio Integration
Provider Interface:

// packages/providers/base.ts

export interface LLMMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export interface LLMResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMProvider {
  name: string;
  generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse>;
  supportsStreaming(): boolean;
}

export interface GenerateOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

// Implementierungen erstellen
- packages/providers/openai-provider.ts
- packages/providers/openrouter-provider.ts
- packages/providers/ollama-provider.ts
- packages/providers/lmstudio-provider.ts
Copy
Erstellen der Dateien:

Base Interface definieren
Provider Factory erstellen
OpenAI Provider implementieren
OpenRouter Provider implementieren
Ollama Provider implementieren
LM Studio Provider implementieren
Tests für jeden Provider
Definition of Done:

✅ Base Interface definiert
✅ OpenAI Provider implementiert
✅ OpenRouter Provider implementiert
✅ Ollama Provider implementiert
✅ LM Studio Provider implementiert
✅ Unified Factory Pattern
✅ Tests für alle Provider

## Phase 4: Agent Core ⏱️ 2-3 Tage
Ziel: Kern-Agent-System erstellen

Module:

packages/agent/agent.ts - Agent Class
packages/agent/conversation.ts - Conversation Manager
packages/agent/memory.ts - Memory System
packages/agent/planner.ts - Planner
packages/agent/executor.ts - Tool Executor
packages/agent/reasoner.ts - Reasoning
packages/agent/reflection.ts - Self-Reflection
packages/agent/history.ts - History Management
Agent Flow:

User Input → Planner (Plan erstellen)
→ LLM (Plan validieren)
→ Tool Selection (Tools prüfen)
→ Executor (Tools ausführen)
→ LLM (Ergebnisse analysieren)
→ Response (Antwort generieren)
→ Memory (Speichern)
Copy
Erstellen der Dateien:

Agent Class erstellen (Komposition Pattern)
Conversation Manager erstellen
Memory System erstellen (Kurzzeit + Langzeit)
Planner erstellen (Task-Planung)
Executor erstellen (Tool-Ausführung)
Reasoner erstellen
Reflection erstellen
History erstellen
Tests für alle Module
Definition of Done:

✅ Agent Class erstellt
✅ Conversation Manager implementiert
✅ Memory System implementiert
✅ Planner implementiert
✅ Executor implementiert
✅ Reasoner implementiert
✅ Reflection implementiert
✅ History implementiert
✅ Integrationstests

## Phase 5: Tool System ⏱️ 2-3 Tage
Ziel: Wichtige Tools erstellen (Filesystem, Browser, HTTP, Cron)

Tool-Interface:

// packages/tools/types.ts

export interface Tool {
  name: string;
  description: string;
  schema: ZodSchema<any>;
  execute(input: any): Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  data: any;
  error?: string;
  metadata?: {
    toolName: string;
    executionTime: number;
  };
}
Copy
Tools erstellen:

Filesystem Tool

packages/tools/filesystem.ts
Funktionen: read, write, delete, list, mkdir, exists
Browser Tool (Puppeteer)

packages/tools/browser.ts
Funktionen: navigate, screenshot, click, fill, executeScript, download
HTTP Tool

packages/tools/http.ts
Funktionen: get, post, put, delete, upload, download
Cron Tool

packages/tools/cron.ts
Funktionen: schedule, cancel, list, status
Git Tool (optional für Coding-Agent)

packages/tools/git.ts
Funktionen: clone, commit, push, pull, status
Search Tool

packages/tools/search.ts
Funktionen: googleSearch, webSearch
SQLite Tool

packages/tools/sqlite.js
Funktionen: query, execute, createTable
MCP Tool

packages/tools/mcp.ts
Funktionen: listTools, callTool
Erstellen der Dateien:

Tool Interface definieren
Base Tool Class erstellen
Filesystem Tool implementieren
Browser Tool implementieren
HTTP Tool implementieren
Cron Tool implementieren
Git Tool implementieren
Search Tool implementieren
SQLite Tool implementieren
MCP Tool implementieren
Tool Registry erstellen
Tests für alle Tools
Definition of Done:

✅ Tool Interface definiert
✅ Base Tool Class erstellt
✅ Filesystem Tool implementiert
✅ Browser Tool implementiert
✅ HTTP Tool implementiert
✅ Cron Tool implementiert
✅ Tool Registry erstellt
✅ Tests für alle Tools

## Phase 6: MCP Integration ⏱️ 1-2 Tage
Ziel: MCP SDK Integration

Schritte:

MCP SDK Installation
MCP Server Registry erstellen
Tools abrufen und registrieren
Streaming implementieren
Reconnect-Logik
Erstellen der Dateien:

packages/mcp/client.ts - MCP Client
packages/mcp/server.ts - MCP Server
packages/mcp/registry.ts - Tool Registry
Tests erstellen
Definition of Done:

✅ MCP SDK integriert
✅ MCP Client erstellt
✅ MCP Server erstellt
✅ Tool Registry erstellt
✅ Streaming funktioniert
✅ Reconnect implementiert
✅ Tests

## Phase 7: Memory System ⏱️ 1-2 Tage
Ziel: Erweitertes Memory System

Features:

Kurzzeit-Memory (Conversation)
Langzeit-Memory (Persistent)
Embeddings (Vector Search)
Zusammenfassungen
Erstellen der Dateien:

packages/memory/index.ts
packages/memory/knowledge-base.ts
packages/memory/embeddings.ts
packages/memory/summarizer.ts
Tests
Definition of Done:

✅ Kurzzeit-Memory implementiert
✅ Langzeit-Memory implementiert
✅ Embeddings erstellt
✅ Vector Search implementiert
✅ Zusammenfassungen implementiert
✅ Tests

## Phase 8: Planner ⏱️ 1-2 Tage
Ziel: Task-Planung und -Aufteilung

Features:

Task-Aufteilung
Subtasks
Prioritäten
Abhängigkeiten
Erstellen der Dateien:

packages/planer/planner.ts
packages/planer/task-graph.ts
Tests
Definition of Done:

✅ Planner implementiert
✅ Task-Aufteilung
✅ Subtasks erstellen
✅ Prioritäten
✅ Abhängigkeiten
✅ Tests

## Phase 9: Scheduler ⏱️ 1-2 Tage
Ziel: Cron, Queue, Retry

Features:

Cron Jobs
Task Queue
Retry Mechanism
Wiederholungen
Erstellen der Dateien:

packages/scheduler/cron.ts
packages/scheduler/queue.ts
packages/scheduler/retry.ts
Tests
Definition of Done:

✅ Cron implementiert
✅ Queue implementiert
✅ Retry implementiert
✅ Tests

## Phase 10: Browser Automation ⏱️ 2-3 Tage
Ziel: Puppeteer Integration

Features:

Navigation
Screenshots
DOM Manipulation
Cookies
Downloads
PDF
Formulare
Login
Erstellen der Dateien:

packages/browser/index.ts
packages/browser/page-manager.ts
packages/browser/context-manager.ts
Tests
Definition of Done:

✅ Puppeteer integriert
✅ Navigation
✅ Screenshots
✅ DOM Manipulation
✅ Cookies
✅ Downloads
✅ PDF
✅ Formulare
✅ Login
✅ Tests

## Phase 11: Dashboard ⏱️ 4-6 Tage (SOFORT FOKUS)
Ziel: React Dashboard für sofortiges Testing

Technologien:

React 18
TypeScript
Tailwind CSS
React Router
Zustand
Socket.io Client
Komponenten:

apps/web/src/App.tsx
apps/web/src/components/dashboard/Dashboard.tsx
apps/web/src/components/chat/ChatContainer.tsx
apps/web/src/components/memory/MemoryBrowser.tsx
apps/web/src/components/projects/ProjectManager.tsx
apps/web/src/components/tasks/TaskManager.tsx
apps/web/src/components/settings/Settings.tsx
apps/web/src/components/tools/ToolRegistry.tsx
apps/web/src/components/logs/LogViewer.tsx
apps/web/src/lib/store.ts (Zustand)
apps/web/src/lib/api.ts (Socket.io)
apps/web/src/lib/utils.ts
Erstellen der Dateien:

React App Setup
Routing erstellen
Dashboard erstellen
Chat Component erstellen
Memory Browser erstellen
Project Manager erstellen
Task Manager erstellen
Settings erstellen
Tool Registry erstellen
Log Viewer erstellen
Store erstellen
API Client erstellen
Definition of Done:

✅ React App erstellt
✅ Routing implementiert
✅ Dashboard erstellt
✅ Chat Component erstellt
✅ Memory Browser erstellt
✅ Project Manager erstellt
✅ Task Manager erstellt
✅ Settings erstellt
✅ Tool Registry erstellt
✅ Log Viewer erstellt
✅ Store erstellt
✅ API Client erstellt
✅ Dashboard funktioniert

## Phase 12: Plugin System ⏱️ 2-3 Tage
Ziel: Erweitertes Plugin-System

API:

init()
registerTools()
shutdown()
Erstellen der Dateien:

packages/plugin/index.ts
packages/plugin/loader.ts
packages/plugin/hooks.ts
Tests
Definition of Done:

✅ Plugin API definiert
✅ Plugin Loader erstellt
✅ init() Hook
✅ registerTools() Hook
✅ shutdown() Hook
✅ Tests

## Phase 13: CLI ⏱️ 1-2 Tage
Ziel: CLI Tools

Befehle:

agent chat - Chat mit Agenten
agent run - Agenten ausführen
agent project - Projektverwaltung
agent task - Task-Verwaltung
agent memory - Memory
agent tools - Tool-Verwaltung
Erstellen der Dateien:

apps/cli/src/commands/chat.ts
apps/cli/src/commands/run.ts
apps/cli/src/commands/project.ts
apps/cli/src/commands/task.ts
apps/cli/src/commands/memory.ts
apps/cli/src/commands/tools.ts
apps/cli/src/index.ts
Definition of Done:

✅ CLI erstellt
✅ agent chat implementiert
✅ agent run implementiert
✅ agent project implementiert
✅ agent task implementiert
✅ agent memory implementiert
✅ agent tools implementiert
✅ Tests

## Phase 14: REST API ⏱️ 2-3 Tage
Ziel: REST API Endpunkte

Endpunkte:

/chat - Chat
/tasks - Tasks
/projects - Projekte
/tools - Tools
/providers - Provider
/memory - Memory
/settings - Einstellungen
/logs - Logs
Erstellen der Dateien:

apps/server/src/index.ts
apps/server/src/routes/chat.ts
apps/server/src/routes/tasks.ts
apps/server/src/routes/projects.ts
apps/server/src/routes/tools.ts
apps/server/src/routes/providers.ts
apps/server/src/routes/memory.ts
apps/server/src/routes/settings.ts
apps/server/src/routes/logs.ts
apps/server/src/middleware/error-handler.ts
apps/server/src/middleware/auth.ts
Definition of Done:

✅ Express Server erstellt
✅ Routing implementiert
✅ Chat Endpunkt
✅ Tasks Endpunkt
✅ Projects Endpunkt
✅ Tools Endpunkt
✅ Providers Endpunkt
✅ Memory Endpunkt
✅ Settings Endpunkt
✅ Logs Endpunkt
✅ Error Handler
✅ Tests

## Phase 15: WebSocket ⏱️ 2-3 Tage
Ziel: WebSocket Integration

Features:

Live Status
Token Stream
Logs
Task Updates
Erstellen der Dateien:

apps/server/src/websocket/index.ts
apps/server/src/websocket/chat.ts
apps/server/src/websocket/logs.ts
apps/server/src/websocket/tasks.ts
Tests
Definition of Done:

✅ WebSocket Server erstellt
✅ Chat Socket
✅ Logs Socket
✅ Tasks Socket
✅ Token Stream
✅ Tests

## Phase 16: Multi-Agent ⏱️ 3-5 Tage
Ziel: Multi-Agent System

Agenten:

Manager Agent
Research Agent
Coding Agent (Fokus!)
Browser Agent
Review Agent
Erstellen der Dateien:

packages/agent/manager.ts
packages/agent/research.ts
packages/agent/coding.ts (Fokus!)
packages/agent/browser.ts
packages/agent/review.ts
packages/agent/shared-memory.ts
Tests
Definition of Done:

✅ Manager Agent erstellt
✅ Research Agent erstellt
✅ Coding Agent erstellt
✅ Browser Agent erstellt
✅ Review Agent erstellt
✅ Shared Memory implementiert
✅ Task Delegation
✅ Tests

## Phase 17: Tests ⏱️ 4-6 Tage
Ziel: Vollständiges Testsystem

Technologien:

Vitest
Unit Tests
Integration Tests
E2E Tests
Erstellen der Dateien:

tests/unit/agent.test.ts
tests/unit/memory.test.ts
tests/unit/tools.test.ts
tests/unit/providers.test.ts
tests/unit/database.test.ts
tests/integration/chat.test.ts
tests/integration/tasks.test.ts
tests/e2e/coding-agent.test.ts
tests/e2e/browser-agent.test.ts
vitest.config.ts
Definition of Done:

✅ Vitest konfiguriert
✅ Unit Tests (Agent, Memory, Tools, Providers, Database)
✅ Integration Tests (Chat, Tasks)
✅ E2E Tests (Coding Agent, Browser Agent)
✅ Code Coverage > 80%
✅ Tests durchlaufen

## Phase 18: Vollständiges Frontend ⏱️ 7-10 Tage
Ziel: Vollständige Web-Oberfläche

Technologien:

React
TypeScript
Tailwind CSS
React Router
TanStack Query
Zustand
Monaco Editor
Socket.io Client
Komponenten:

Dashboard mit Systemstatus
Chat mit allen Agenten
Projektverwaltung
Task-Manager
Prompt-Editor
Tool-Verwaltung
MCP-Server-Verwaltung
LLM-Provider-Verwaltung
Modell-Auswahl und Parameter
Memory-Browser
Wissensdatenbank
Plugin-Manager
Scheduler- und Cron-Verwaltung
Benutzer- und Rollenverwaltung
Einstellungen
API-Key-Verwaltung
Dateimanager
Live-Konsole und Logviewer
Token-Streaming
Agent-Monitoring
Multi-Agent-Steuerung
Workflow-Editor
Backup- und Restore
System-Updates
Theme (Hell/Dunkel)
Internationalisierung (i18n)
UI-Komponenten:

Drag-and-Drop Workflow Builder
JSON-Editor
Prompt-Editor mit Syntax-Highlighting
Tabellen mit Filter- und Suchfunktion
Live-Diagramme für CPU, RAM und Tokenverbrauch
Benachrichtigungen
Rechteverwaltung
Definition of Done:

✅ Alle Komponenten erstellt
✅ Alle Features implementiert
✅ Responsive Design
✅ Echtzeit-Aktualisierung (WebSocket)
✅ Theme (Hell/Dunkel)
✅ i18n
✅ Tests

## 🎯 Zusammenfassung der Prioritäten
MVP (Minimum Viable Product) - Phasen 1-4:
Monorepo Setup
Datenbank
LLM Provider
Agent Core
Wichtige Tools (Phasen 5-6):
Filesystem Tool
Browser Tool
HTTP Tool
MCP Integration
Dashboard (Phase 11):
Sofortiges Testing möglich
Coding Agent Fokus:
Phase 4: Planner
Phase 5: Git Tool
Phase 10: Browser Tool
Phase 16: Coding Agent
Langfristig (Phasen 12-18):
Plugin System
CLI
REST API
WebSocket
Multi-Agent
Vollständiges Frontend
📊 Empfohlene Zeitschätzung
Gesamtzeit: ~4-6 Wochen (40-60 Stunden)

Phasen 1-4: 1-1.5 Wochen
Phasen 5-8: 1-1.5 Wochen
Phase 11 (Dashboard): 4-6 Tage
Phasen 12-18: 2-2.5 Wochen
🚀 Next Steps (Konkrete ersten Schritte)
Sofortige Aktionen:

Node.js 22+ Installation (falls nicht vorhanden)
pnpm Installation: npm install -g pnpm
Projekt erstellen:
mkdir ducki-node
cd ducki-node
pnpm init
Copy
pnpm Workspace erstellen: pnpm-workspace.yaml
Package.json konfigurieren
TypeScript Konfiguration erstellen
Struktur erstellen (Verzeichnisse und Dateien)
Wöchentliche Planung:

Woche 1: Phase 1 + Phase 2
Woche 2: Phase 3 + Phase 4
Woche 3: Phase 5 + Phase 6 + Phase 7
Woche 4: Phase 8 + Phase 9 + Phase 10 + Phase 11 (Dashboard)
📚 Ressourcen
Node.js 22 Documentation
pnpm Workspace
TypeScript Documentation
Drizzle ORM
Express
React
Tailwind CSS
Puppeteer
OpenAI SDK
OpenRouter
Ollama
Zod
Vitest
Zustand
React Router
TanStack Query

## ✅ Definition of Done für das gesamte Projekt
 Alle Tests erfolgreich
 ESLint fehlerfrei
 TypeScript fehlerfrei
 API dokumentiert
 Dashboard funktionsfähig
 Module isoliert testbar
 Dokumentation gepflegt
 Coding Agent funktionsfähig
 Browser Tool funktionsfähig
 LM Studio Provider funktionsfähig
 OpenRouter Provider funktionsfähig