# DucKI Node

- Self-hosted coding and Task / Personal agent platform with web UI, REST API, WebSocket streaming, persistent memory, workflow graphs, CronJobs to running prompts/ Tasks / Skills, discord gateway with speech to text, and multi-agent execution.
- Fully Developed in NodeJS! 
- Tested Local with LM Studio & OpenRouter
- Agent / Memory / Skill System / Task Management / KanBan Board / Log System / Discord Gateway -> ALL Full working!
- Lightweight Code for easy Extending!
- Fully Developed in the Heart of Germany, Fulda near Rhön!
- This Agent is for Me and All :-) Contribute via Pull Requests or Tell me Issues / Give me Feedback. 

<img width="1633" height="611" alt="image" src="https://github.com/user-attachments/assets/5a92eeb8-8a88-4082-bfc7-dc2ca2c85cfc" />

## Quick Start

### Linux/macOS/WSL

```bash
pnpm install
cp .env.example .env
pnpm dev
```

### Windows (PowerShell)

```powershell
pnpm install
Copy-Item .env.example .env
pnpm dev
```

After startup:

- Web UI: `http://localhost:3000`
- API: `http://localhost:3001`
- Health check: `http://localhost:3001/health`

## What You Get

| Capability | Description |
| --- | --- |
| Multi-agent runs | Parallel agent executions (chat + tasks + websocket runs) without global lock contention |
| Workflow orchestration | Create/update/run/resume graph workflows from UI and tools |
| Persistent memory | Agent/user memory with profile entries, approvals, and curation actions | Self Updating Memory
| Skills system | Slash-skill loading, auto-skill selection, pin/enable management, markdown skill editor |
| Tooling | Filesystem, HTTP, shell, git, browser automation, skills management, workflow and memory tools |
| Live operations | Agent live metrics and active run monitoring page |
| CronJobs | Run at a specific Time for Tasks / skills and Prompts |

# Donation & Help

Donations are Welcome and help to make this Agent get an Powerfull Assistant for your Life & Work - Thanks a lot.

-PayPal Me: https://www.paypal.me/davidduckwitz

-Bitcoin: 1AinLLwLGvh2Y51a53PAYi5PdPBsLwpU1G


## Getting Started

```bash
pnpm dev
```

Common workflows:

1. Open `/settings` and set provider/model.
2. Open `/skills` and enable only required skills.
3. Use `/chat` for iterative work with tools.
4. Use `/workflow` for graph-based execution.
5. Monitor `/agents` for currently running agents.

## Project Structure

```text
apps/
	server/      Express + Socket.IO API
	web/         React + Vite dashboard
	cli/         CLI entrypoint
packages/
	agent/       Core agent loop, guards, memory integration
	tools/       Tool executors (filesystem, http, shell, git, skills)
	providers/   LLM providers (LM Studio, OpenAI, OpenRouter, Ollama)
	database/    SQLite service + schema
	logger/      Logging helpers
	shared/      Shared types and API helpers
skills/        User and system skill folders (SKILL.md per skill)
storage/       Runtime storage (DB, logs)
```

## CLI and Scripts

```bash
pnpm dev
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

CLI examples:

```bash
pnpm --filter @ducki/cli dev chat
pnpm --filter @ducki/cli dev run "implement health endpoint"
pnpm --filter @ducki/cli dev tools
```

## Configuration

Settings are stored in DB via `/api/settings` and can be edited from `/settings`.

Important agent controls:

- `AGENT_MAX_ITERATIONS`
- `AGENT_TIMEOUT_MS`
- `AGENT_MAX_TOOL_FAILURES`
- `AGENT_MAX_REPEATED_TOOL_CALL`
- `AGENT_AUTO_MEMORY`
- `AGENT_AUTO_SKILL_SELECTION`
- `AGENT_AUTO_SKILL_THRESHOLD`
- `AGENT_AUTO_SKILL_MARGIN`
- `AGENT_AUTO_SKILL_MIN_INPUT_LEN`
- `AGENT_AUTO_SKILL_MIN_OVERLAP`

Provider controls:

- `DEFAULT_PROVIDER`
- `*_MODEL`, `*_BASE_URL`, `*_API_KEY`

Discord gateway and local STT controls:

- `DISCORD_GATEWAY_ENABLED`
- `DISCORD_BOT_TOKEN` (or gateway `authToken` in `/gateway` config)
- `DISCORD_GUILD_ID` (optional)
- `DISCORD_ALLOWED_USER_ID` (optional)
- `DISCORD_VOICE_STT_PROVIDER` (`local`, `nodejs-whisper`, `silero`, `ollama`, `openai`)
- `DISCORD_VOICE_STT_COMMAND` / `DISCORD_VOICE_STT_ARGS` (for provider `local`)
- `LOCAL_STT_COMMAND` / `LOCAL_STT_ARGS` / `LOCAL_STT_TIMEOUT_MS`
- `DEFAULT_SPEECH_TO_TEXT_PROVIDER`
- `NODEJS_WHISPER_MODEL_NAME` / `NODEJS_WHISPER_MODEL_ROOT_PATH`
- `NODEJS_WHISPER_AUTO_DOWNLOAD` / `NODEJS_WHISPER_USE_CUDA`
- `NODEJS_WHISPER_LANGUAGE` / `NODEJS_WHISPER_TIMEOUT_MS`

Example for local STT binary (`whisper.cpp` style):

```bash
DISCORD_VOICE_STT_PROVIDER=local
LOCAL_STT_COMMAND=whisper-cli
LOCAL_STT_ARGS=-m C:/models/ggml-base.en.bin -f {input}
```

Supported placeholders for local STT args:

- `{input}` temporary input audio file path
- `{output}` temporary transcript output file path
- `{outputBase}` temporary output file base path
- `{language}` language hint (if provided)

### Whisper installation (Windows)

Recommended setup for Discord voice transcription without external cloud STT:

1. Install `nodejs-whisper` in the workspace (already included in this project).
2. Install CMake:
	 - `winget install -e --id Kitware.CMake`
3. Ensure Visual C++ Build Tools are available (required by `cmake --build`).
4. In Settings (`/settings`), set:

```bash
DISCORD_VOICE_STT_PROVIDER=nodejs-whisper
DEFAULT_SPEECH_TO_TEXT_PROVIDER=nodejs-whisper
NODEJS_WHISPER_MODEL_NAME=base
NODEJS_WHISPER_AUTO_DOWNLOAD=true
NODEJS_WHISPER_LANGUAGE=auto
NODEJS_WHISPER_TIMEOUT_MS=180000
```

Optional local command fallback (used if configured):

```bash
LOCAL_STT_COMMAND=C:/tools/whispercpp/whisper-cli.exe
LOCAL_STT_ARGS=-m C:/tools/whispercpp/models/ggml-base.bin -f {input} -otxt -of {outputBase} -l de
LOCAL_STT_INPUT_EXT=ogg
LOCAL_STT_TIMEOUT_MS=180000
```

Notes:

- On first run, `nodejs-whisper` may download a model and build `whisper.cpp`.
- Build output executable is typically:
	- `node_modules/.pnpm/nodejs-whisper@0.3.0/node_modules/nodejs-whisper/cpp/whisper.cpp/build/bin/Release/whisper-cli.exe`
- If Discord voice message processing is rate-limited by LLM provider (`429`), the system still returns the raw transcript when available.

## API Overview

Core endpoints:

- `POST /api/chat`
- `GET /api/chat/conversations`
- `GET /api/chat/conversations/:id/messages`
- `GET /api/workflows`
- `POST /api/workflows`
- `POST /api/workflows/:id/run`
- `GET /api/memory`
- `POST /api/memory/actions`
- `GET /api/skills`
- `GET /api/shared/files`
- `GET /api/agents/live`
- `GET /api/logs`

## WebSocket Events

Client -> server:

- `chat:message`
- `chat:stop`
- `agent:status`

Server -> client:

- `chat:start`
- `chat:chunk`
- `chat:event`
- `chat:complete`
- `chat:error`
- `agent:status`
- `agent:metrics`

## Skills and Memory

- Skills live in `skills/<slug>/SKILL.md`.
- Enable/disable skills in `/skills`.
- Agent can auto-select relevant skills when enabled.
- Memory supports add/replace/remove/batch/approval flows.

## Browser Tool

The `browser` tool (in `packages/tools/src/browser.ts`) supports browser automation via Puppeteer Core and runs in an isolated worker process.

Implemented actions:

- `detect`
- `launch`
- `list_pages`
- `goto`
- `click`
- `type`
- `press`
- `wait`
- `evaluate`
- `screenshot`
- `cookies_get`
- `cookies_set`
- `cookies_clear`
- `form_fill`
- `login`
- `pdf`
- `download`
- `close`

Operational notes:

- Browser execution is isolated in a child process (IPC). Puppeteer runtime failures return tool errors and should not terminate the agent process.
- On Windows, browser detection checks env vars and common install paths for Edge/Chrome/Chromium.
- For `download`, use `saveDir` for deterministic storage and verify resulting files in that directory.

Minimal flow example:

1. `detect`
2. `launch` (optional `url`)
3. Interact with `goto`/`click`/`type`/`form_fill`/`login`
4. Capture artifacts with `screenshot` or `pdf`
5. `close`

## MCP Integration

The project includes MCP runtime integration with server registry, reconnect handling, streaming, and a dedicated UI page (`/mcp`).

Core capabilities:

- Configure MCP servers (`id`, `name`, `url`, `enabled`) and persist settings.
- Automatic runtime sync/reload of configured servers.
- Reconnect tracking (`connected`, `reconnectAttempts`) and discovered tool counts.
- List discovered remote tools across connected MCP servers.
- Execute remote MCP tools via one-shot calls.
- Execute remote MCP tools via SSE stream with live output.
- Stop active streams from UI.
- Inspect streamed chunks with per-chunk timestamps in UI.

Server API endpoints:

- `GET /api/mcp/servers`
- `PUT /api/mcp/servers`
- `POST /api/mcp/servers/reload`
- `GET /api/mcp/tools`
- `POST /api/mcp/tools/call`
- `POST /api/mcp/tools/stream`

UI flow (`/mcp`):

1. Add or update MCP servers.
2. Click reload to sync runtime.
3. Verify connected status and tool discovery.
4. Call tools directly or start stream mode.
5. Stop stream if needed and review chunk timeline.

## Development Notes

- Workspace uses `pnpm` with TypeScript project references.
- Route-heavy pages are lazy-loaded in web app.
- Server logs requests/errors to DB and exposes `/api/logs`.
- Shared workspace APIs are under `/api/shared/*`.
- Sidebar `Live Agenten` card shows Discord gateway runtime state (green/red) with tooltip (`lastError` when inactive).
- Discord inbound lifecycle can set reactions on source messages: `👀` on receive, `✅` on success, `⚠️` on failure.

## Troubleshooting

If server fails to start:

1. Ensure port `3001` is free.
2. Run `pnpm --filter @ducki/server run start`.
3. Check `/api/logs` and console output.

If Discord gateway is inactive (red indicator):

1. Check `/api/agents/live` -> `gateway.discord.lastError`.
2. Verify bot token source (`DISCORD_BOT_TOKEN` or `/gateway` config `authToken`).
3. Confirm Discord bot has permissions: View Channel, Read Message History, Add Reactions, Send Messages.

If Discord reactions are missing on inbound messages:

1. Confirm inbound payload includes `sourceMessageId` (WS bridge sends this automatically).
2. Verify channel permissions for reactions.
3. Inspect `/api/logs` for `reaction_set` / `reaction_error` gateway events.

If local voice transcription fails:

1. Ensure `LOCAL_STT_COMMAND` points to an installed local binary.
2. Check `LOCAL_STT_ARGS` placeholders and quoting for Windows paths.
3. Validate command manually with a local audio file before running `pnpm dev`.

If `nodejs-whisper` fails with `cmake` or `whisper-cli` errors:

1. Verify CMake is installed and reachable:
	- `cmake --version`
2. If CMake was just installed, restart terminal/dev server.
3. Confirm Build Tools are installed (Visual Studio Build Tools with C++ workload).
4. If the log shows `whisper-cli executable not found`, run one clean rebuild:

```powershell
$root = Join-Path (Resolve-Path .) "node_modules/.pnpm/nodejs-whisper@0.3.0/node_modules/nodejs-whisper/cpp/whisper.cpp"
& "C:\Program Files\CMake\bin\cmake.exe" -S $root -B (Join-Path $root "build")
& "C:\Program Files\CMake\bin\cmake.exe" --build (Join-Path $root "build") --config Release
```

If skills are not visible:

1. Verify files exist under `skills/<slug>/SKILL.md`.
2. Confirm `SKILLS_PATH` (or fallback resolution) points to workspace `skills`.
3. Restart server after path/config changes.

## Contributing

1. Create a feature branch.
2. Run `pnpm typecheck` and relevant tests.
3. Open PR with a short change summary and validation steps.

## License

MIT (see `LICENSE` if present).
