import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Check } from "lucide-react";
import { useI18n } from "../../lib/i18n";

interface InternalTool {
  name: string;
  displayName: string;
  description: string;
  version: string;
  sessionBased: boolean;
  actions: {
    name: string;
    description: string;
    example?: Record<string, unknown>;
  }[];
  documentation: string;
  skillPath: string;
}

const INTERNAL_TOOLS: InternalTool[] = [
  {
    name: "crypto-payment",
    displayName: "💰 Crypto Payment",
    description: "Manage cryptocurrency wallets and transactions - generate addresses, track balances, import private keys",
    version: "1.0.0",
    sessionBased: false,
    skillPath: "skills/crypto-payment/SKILL.md",
    documentation: `Complete cryptocurrency management system supporting Bitcoin, Ethereum, and XRP.

**Key Features:**
- Multi-currency support (BTC, ETH, XRP)
- Address generation with QR codes
- Private key import and management
- Real-time balance tracking via blockchain APIs
- Transaction history and sync
- Portfolio overview and export/import
- API provider integration (Bitref, Etherscan, XRPScan)
- Secure encrypted storage

**Core Actions:**
- create_address: Generate new cryptocurrency address
- list_addresses: Get all addresses for currency
- get_address_by_id: Get single address details with balance
- import_private_key: Import existing private key
- export_address: Export address data (encrypted)
- get_transactions: Fetch transaction history
- sync_transactions: Manual sync with blockchain
- set_api_credentials: Configure blockchain API access
- get_portfolio_summary: Total holdings overview
- test_api_connection: Verify API connectivity`,
    actions: [
      {
        name: "create_address",
        description: "Generate a new cryptocurrency address",
        example: {
          action: "create_address",
          currency: "BTC",
          label: "Main Wallet",
          derivationPath: "m/44'/0'/0'/0/0"
        }
      },
      {
        name: "list_addresses",
        description: "List all addresses for a currency",
        example: {
          action: "list_addresses",
          currency: "ETH"
        }
      },
      {
        name: "get_address_by_id",
        description: "Get address details with current balance",
        example: {
          action: "get_address_by_id",
          addressId: 1
        }
      },
      {
        name: "import_private_key",
        description: "Import a private key and create address",
        example: {
          action: "import_private_key",
          currency: "BTC",
          privateKey: "hex_or_wif_format",
          label: "Imported Key"
        }
      },
      {
        name: "get_portfolio_summary",
        description: "Get total portfolio value and holdings",
        example: {
          action: "get_portfolio_summary"
        }
      },
      {
        name: "set_api_credentials",
        description: "Configure blockchain API access",
        example: {
          action: "set_api_credentials",
          provider: "bitref",
          apiKey: "your_api_key"
        }
      }
    ]
  },
  {
    name: "browser-control",
    displayName: "🌐 Browser Control",
    description: "Control browser automation with persistent sessions - navigate, click, type, screenshot",
    version: "2.0.0",
    sessionBased: true,
    skillPath: "skills/browser-control/SKILL.md",
    documentation: `Session-based browser automation for page inspection and interaction.

**Key Features:**
- Persistent browser sessions (implicit via agentId, explicit via sessionId)
- Navigate to URLs, click elements, type text
- Screenshot capture for visual state verification
- JavaScript evaluation for DOM inspection
- Session cleanup to free resources

**Core Actions:**
- session_create: Start a new browser session
- navigate: Navigate to a URL
- click: Click an element by CSS selector
- type: Type text into a field
- screenshot: Capture page image
- evaluate: Execute JavaScript in page context
- wait: Wait for specified milliseconds
- session_close: End session and cleanup`,
    actions: [
      {
        name: "session_create",
        description: "Initialize a new browser session with implicit agentId or explicit sessionId",
        example: {
          action: "session_create",
          agentId: "my-workflow"
        }
      },
      {
        name: "navigate",
        description: "Navigate to a URL within the session",
        example: {
          action: "navigate",
          sessionId: "session_xyz",
          url: "https://example.com"
        }
      },
      {
        name: "click",
        description: "Click an element by CSS selector",
        example: {
          action: "click",
          sessionId: "session_xyz",
          selector: "button.submit"
        }
      },
      {
        name: "screenshot",
        description: "Capture visual state of current page",
        example: {
          action: "screenshot",
          sessionId: "session_xyz"
        }
      },
      {
        name: "session_close",
        description: "Close session and free browser resources",
        example: {
          action: "session_close",
          sessionId: "session_xyz"
        }
      }
    ]
  },
  {
    name: "tasks",
    displayName: "✓ Tasks / Kanban",
    description: "Manage tasks and kanban board with session-based context - create, list, update tasks",
    version: "2.0.0",
    sessionBased: true,
    skillPath: "skills/tasks-kanban/SKILL.md",
    documentation: `Session-based task and kanban management for organized workflow tracking.

**Key Features:**
- Persistent task session context (maintains board filtering)
- Create, list, update, delete tasks
- Board organization and filtering
- Status tracking (todo, in_progress, done)
- Session context maintains state across operations

**Core Actions:**
- session_create: Start a task management session
- list_tasks: List all tasks (maintains session filter context)
- create_task: Create a new task
- update_task: Update task properties or status
- get_task: Get single task details
- delete_task: Delete a task
- list_boards: List all kanban boards
- session_close: End task session`,
    actions: [
      {
        name: "session_create",
        description: "Initialize task management session",
        example: {
          action: "session_create",
          agentId: "task-manager"
        }
      },
      {
        name: "create_task",
        description: "Create a new task within the session",
        example: {
          action: "create_task",
          sessionId: "session_xyz",
          title: "Fix login bug",
          description: "User cannot reset password",
          status: "todo",
          priority: "high"
        }
      },
      {
        name: "list_tasks",
        description: "List tasks (session maintains filter context)",
        example: {
          action: "list_tasks",
          sessionId: "session_xyz",
          boardId: "board_123"
        }
      },
      {
        name: "update_task",
        description: "Update task status or properties",
        example: {
          action: "update_task",
          sessionId: "session_xyz",
          taskId: 42,
          status: "in_progress"
        }
      },
      {
        name: "session_close",
        description: "End task session",
        example: {
          action: "session_close",
          sessionId: "session_xyz"
        }
      }
    ]
  },
  {
    name: "workflow",
    displayName: "⚙️ Workflow Orchestrator",
    description: "Create and run workflow graphs with session-based execution tracking - automate multi-step processes",
    version: "2.0.0",
    sessionBased: true,
    skillPath: "skills/workflow-orchestrator/SKILL.md",
    documentation: `Session-based workflow orchestration for complex multi-step automation.

**Key Features:**
- Persistent execution sessions track workflow state
- Create reusable workflow definitions
- Run and manage workflow execution
- Track node results within session
- Session context maintains execution history

**Core Actions:**
- session_create: Start workflow execution session
- create_workflow: Define a new workflow
- run_workflow: Execute workflow (state tracked in session)
- get_workflow: Get workflow definition
- update_workflow: Modify workflow
- list_workflows: List all workflows
- delete_workflow: Delete workflow
- session_close: End execution session`,
    actions: [
      {
        name: "session_create",
        description: "Initialize workflow execution session",
        example: {
          action: "session_create",
          agentId: "workflow-executor"
        }
      },
      {
        name: "create_workflow",
        description: "Create a new workflow definition",
        example: {
          action: "create_workflow",
          sessionId: "session_xyz",
          name: "Data Pipeline",
          description: "Fetch and process data",
          nodes: [
            { id: "fetch", type: "browser" },
            { id: "process", type: "coding" },
            { id: "validate", type: "review" }
          ]
        }
      },
      {
        name: "run_workflow",
        description: "Execute workflow (execution tracked in session)",
        example: {
          action: "run_workflow",
          sessionId: "session_xyz",
          workflowId: "wf_123",
          input: { dataSource: "https://example.com" }
        }
      },
      {
        name: "session_close",
        description: "End workflow session and cleanup state",
        example: {
          action: "session_close",
          sessionId: "session_xyz"
        }
      }
    ]
  },
  {
    name: "cronjobs",
    displayName: "⏱️ Cronjobs",
    description: "Schedule and manage time-based automations with session-based monitoring - run tasks on schedule",
    version: "2.0.0",
    sessionBased: true,
    skillPath: "skills/cronjobs/SKILL.md",
    documentation: `Session-based cronjob management for scheduled automation.

**Key Features:**
- Persistent session context for job monitoring
- Create, schedule, and manage cronjobs
- Monitor execution results in session
- Support for various action types (http, workflow, script)
- Test job execution before scheduling

**Core Actions:**
- session_create: Start cronjob management session
- create_cronjob: Schedule a new cronjob
- list_cronjobs: List all scheduled jobs
- run_cronjob: Execute job immediately (for testing)
- update_cronjob: Modify job schedule or config
- get_cronjob: Get job details
- delete_cronjob: Delete scheduled job
- session_close: End session`,
    actions: [
      {
        name: "session_create",
        description: "Initialize cronjob monitoring session",
        example: {
          action: "session_create",
          agentId: "cronjob-manager"
        }
      },
      {
        name: "create_cronjob",
        description: "Schedule a new cronjob",
        example: {
          action: "create_cronjob",
          sessionId: "session_xyz",
          name: "Daily Sync",
          schedule: "0 9 * * *",
          action_type: "http",
          action_config: {
            url: "http://localhost:3001/sync",
            method: "POST"
          }
        }
      },
      {
        name: "run_cronjob",
        description: "Execute job immediately for testing",
        example: {
          action: "run_cronjob",
          sessionId: "session_xyz",
          cronjobId: "cj_123"
        }
      },
      {
        name: "session_close",
        description: "End cronjob management session",
        example: {
          action: "session_close",
          sessionId: "session_xyz"
        }
      }
    ]
  }
];

function ActionExample({ example }: { example: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(example, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      <pre className="rounded bg-black/40 border border-gray-800 p-2 text-[11px] text-gray-200 overflow-auto max-h-40">
        {JSON.stringify(example, null, 2)}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1 rounded bg-gray-800/50 hover:bg-gray-700 transition text-gray-300"
        title="Copy to clipboard"
      >
        {copied ? (
          <Check className="w-3 h-3 text-green-400" />
        ) : (
          <Copy className="w-3 h-3" />
        )}
      </button>
    </div>
  );
}

function ToolCard({ tool }: { tool: InternalTool }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/60 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-3 hover:bg-gray-900/60 transition text-left flex items-start justify-between gap-2"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-gray-100">{tool.displayName}</p>
            <span className="text-xs bg-cyan-500/20 text-cyan-300 px-2 py-0.5 rounded">
              v{tool.version}
            </span>
            {tool.sessionBased && (
              <span className="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded">
                Session-Based
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-1">{tool.description}</p>
        </div>
        <div className="mt-1">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-400" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-800 p-3 space-y-4 bg-gray-900/30">
          {/* Documentation */}
          <div>
            <p className="text-sm font-semibold text-gray-200 mb-2">📖 Documentation</p>
            <p className="text-xs text-gray-300 whitespace-pre-line leading-relaxed">
              {tool.documentation}
            </p>
            <a
              href={`https://github.com/yourusername/ducki-node/tree/main/${tool.skillPath}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-cyan-400 hover:text-cyan-300 mt-2 inline-block"
            >
              → View full Skill documentation
            </a>
          </div>

          {/* Actions */}
          <div>
            <p className="text-sm font-semibold text-gray-200 mb-2">⚡ Available Actions</p>
            <div className="space-y-2">
              {tool.actions.map((action) => (
                <div key={action.name} className="rounded bg-gray-800/40 p-2">
                  <p className="font-mono text-xs text-cyan-300">{action.name}</p>
                  <p className="text-xs text-gray-300 mt-1">{action.description}</p>
                  {action.example && (
                    <div className="mt-2">
                      <p className="text-xs text-gray-400 mb-1">Example:</p>
                      <ActionExample example={action.example} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Session Pattern */}
          <div className="rounded bg-purple-900/20 border border-purple-800/30 p-2">
            <p className="text-xs font-semibold text-purple-300 mb-2">🔄 Session Pattern</p>
            <p className="text-xs text-gray-300 mb-2">
              All internal MCP tools support hybrid sessions for persistent context:
            </p>
            <div className="text-xs text-gray-400 space-y-1">
              <p>
                <strong className="text-purple-300">Implicit Session:</strong> Use agentId to auto-create persistent session
              </p>
              <p>
                <strong className="text-purple-300">Explicit Session:</strong> Pass sessionId for cross-agent coordination
              </p>
              <p>
                <strong className="text-purple-300">Cleanup:</strong> Use session_close to free resources when done
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function InternalMcpToolsShowcase() {
  const { t } = useI18n();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-100 mb-2">🔧 Internal MCP Tools</h2>
        <p className="text-sm text-gray-400 mb-4">
          Built-in session-based tools for browser automation, task management, workflow orchestration, and job scheduling.
          Each tool supports hybrid sessions for both implicit (agentId) and explicit (sessionId) context management.
        </p>
      </div>

      <div className="grid gap-3">
        {INTERNAL_TOOLS.map((tool) => (
          <ToolCard key={tool.name} tool={tool} />
        ))}
      </div>

      <div className="rounded-lg border border-cyan-800/30 bg-cyan-900/10 p-4">
        <p className="text-sm font-semibold text-cyan-300 mb-2">💡 Quick Start: Session Workflow</p>
        <div className="text-xs text-gray-300 space-y-2">
          <p>
            <strong>1. Create Session:</strong> Call <code className="bg-black/40 px-1 rounded text-cyan-400">session_create</code> with your agentId
          </p>
          <p>
            <strong>2. Use sessionId:</strong> Pass returned sessionId in all subsequent operations
          </p>
          <p>
            <strong>3. Maintain Context:</strong> Session stores state (browser instance, task filters, execution results)
          </p>
          <p>
            <strong>4. Cleanup:</strong> Call <code className="bg-black/40 px-1 rounded text-cyan-400">session_close</code> when done
          </p>
        </div>
      </div>
    </div>
  );
}
