#!/usr/bin/env node
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@ducki/logger";
import { getDatabase, type DatabaseService } from "@ducki/database";
import { createDefaultProvider } from "@ducki/providers";
import { Agent, WorkflowEngine, createWorkflowManagementTool } from "@ducki/agent";
import { allTools } from "@ducki/tools";

const logger = createLogger({ module: "CLI" });
const moduleDir = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(moduleDir, "../../../.env") });
loadEnv({ path: resolve(moduleDir, "../../../.env.local"), override: false });

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "chat";

  const db = await getDatabase();
  const provider = createDefaultProvider();
  const agent = new Agent(provider, db);
  const workflowEngine = new WorkflowEngine(provider, db, agent.executor);

  for (const tool of allTools) {
    agent.executor.registerTool(tool);
  }
  agent.executor.registerTool(createWorkflowManagementTool(workflowEngine));

  switch (command) {
    case "chat":
      await chatCommand(agent);
      break;
    case "run":
      await runCommand(agent, args.slice(1).join(" "));
      break;
    case "tasks":
      await tasksCommand(db);
      break;
    case "tools":
      toolsCommand(agent);
      break;
    default:
      printHelp();
  }
}

async function chatCommand(agent: Agent) {
  console.log("\x1b[36m╔════════════════════════════════╗\x1b[0m");
  console.log("\x1b[36m║     DucKI Agent - Chat Mode    ║\x1b[0m");
  console.log("\x1b[36m╚════════════════════════════════╝\x1b[0m");
  console.log('Tippe "exit" zum Beenden.\n');

  const convId = await agent.startConversation({ name: "CLI Chat" });
  const rl = readline.createInterface({ input, output });

  while (true) {
    const userInput = await rl.question("\x1b[32mDu: \x1b[0m");
    if (userInput.toLowerCase() === "exit") break;
    if (!userInput.trim()) continue;

    process.stdout.write("\x1b[33mDucKI: \x1b[0m");

    try {
      const result = await agent.run(userInput, {
        stream: true,
        onChunk: (chunk) => process.stdout.write(chunk),
      });
      console.log("\n");
    } catch (error) {
      console.error("\x1b[31mFehler:\x1b[0m", error instanceof Error ? error.message : String(error));
    }
  }

  rl.close();
  console.log("\nAuf Wiedersehen!");
}

async function runCommand(agent: Agent, task: string) {
  if (!task) {
    console.error("Bitte eine Aufgabe angeben: ducki run <aufgabe>");
    process.exit(1);
  }

  console.log(`\nFühre aus: ${task}\n`);
  await agent.startConversation();

  const result = await agent.run(task, {
    stream: true,
    onChunk: (chunk) => process.stdout.write(chunk),
  });

  console.log("\n\n---");
  console.log(`Iterationen: ${result.iterations}`);
  if (result.toolsUsed.length > 0) {
    console.log(`Tools verwendet: ${result.toolsUsed.join(", ")}`);
  }
}

async function tasksCommand(db: DatabaseService) {
  const tasks = await db.listTasks();
  if (tasks.length === 0) {
    console.log("Keine Aufgaben vorhanden.");
    return;
  }
  console.log("\nAufgaben:");
  for (const task of tasks) {
    console.log(`  [${task.status.padEnd(10)}] ${task.title}`);
  }
}

function toolsCommand(agent: Agent) {
  const tools = agent.executor.listTools();
  console.log("\nVerfügbare Tools:");
  for (const tool of tools) {
    console.log(`  - ${tool.name}: ${tool.description}`);
  }
}

function printHelp() {
  console.log(`
DucKI Agent CLI

Verwendung:
  ducki chat          Interaktiver Chat
  ducki run <task>    Aufgabe ausführen
  ducki tasks         Aufgaben anzeigen
  ducki tools         Tools anzeigen
  `);
}

main().catch((error) => {
  logger.error("CLI error", { error: String(error) });
  process.exit(1);
});
