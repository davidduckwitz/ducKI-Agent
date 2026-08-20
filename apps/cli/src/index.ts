#!/usr/bin/env node
import "./bootstrap-workspace.js";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, setRootLogger } from "@ducki/logger";
import { getDatabase, type DatabaseService } from "@ducki/database";
import { createDefaultProvider } from "@ducki/providers";
import { Agent, WorkflowEngine, createWorkflowManagementTool } from "@ducki/agent";
import { allTools } from "@ducki/tools";
import { box, renderEvent, promptLabel, responseLabel, errorLine, dim, Spinner } from "./ui.js";
import { listInstalledSkills } from "./skills.js";

// Quiet mode: debug/info log lines (from Agent's internal getRootLogger() calls, e.g. tool
// parser diagnostics) are buffered instead of printed - they only ever surface, dimmed, right
// before a warn/error that they led up to. Keeps the chat transcript free of raw log noise
// while still giving real debugging context the moment something actually fails.
const logger = createLogger({ module: "CLI", quiet: true });
setRootLogger(logger);
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
      await chatCommand(agent, provider.name);
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
    case "skills":
      skillsCommand();
      break;
    default:
      printHelp();
  }
}

async function chatCommand(agent: Agent, providerName: string) {
  const skillCount = listInstalledSkills().length;
  console.log(box("DucKI Agent - Chat Mode", `Provider: ${providerName} | Skills: ${skillCount}`));
  console.log(dim('Tippe "exit" zum Beenden, "/skills" fuer eine Liste, oder "/skill-slug deine Nachricht" um einen Skill direkt aufzurufen.\n'));

  const convId = await agent.startConversation({ name: "CLI Chat" });
  const rl = readline.createInterface({ input, output });

  while (true) {
    const userInput = await rl.question(promptLabel());
    if (userInput.toLowerCase() === "exit") break;
    if (!userInput.trim()) continue;
    if (userInput.trim() === "/skills") {
      skillsCommand();
      continue;
    }

    // Spinning "/" plus elapsed time fills the gap between submitting the question and the
    // first response token - onEvent clears it for each status line (tool_call, plan, ...) so
    // those print cleanly above it, and it resumes on its own on the next tick.
    const spinner = new Spinner();
    spinner.start();
    let printedLabel = false;
    try {
      await agent.run(userInput, {
        stream: true,
        onEvent: (event) => {
          const line = renderEvent(event);
          if (line) {
            spinner.clear();
            console.log(line);
          }
        },
        onChunk: (chunk) => {
          if (!printedLabel) {
            spinner.stop();
            process.stdout.write(responseLabel());
            printedLabel = true;
          }
          process.stdout.write(chunk);
        },
      });
      spinner.stop();
      console.log("\n");
    } catch (error) {
      spinner.stop();
      console.error(errorLine(error instanceof Error ? error.message : String(error)));
    }
  }

  rl.close();
  console.log(dim("\nAuf Wiedersehen!"));
}

async function runCommand(agent: Agent, task: string) {
  if (!task) {
    console.error(errorLine("Bitte eine Aufgabe angeben: ducki run <aufgabe>"));
    process.exit(1);
  }

  console.log(box("Aufgabe", task));
  await agent.startConversation();

  const spinner = new Spinner();
  spinner.start();
  let printedLabel = false;
  const result = await agent.run(task, {
    stream: true,
    onEvent: (event) => {
      const line = renderEvent(event);
      if (line) {
        spinner.clear();
        console.log(line);
      }
    },
    onChunk: (chunk) => {
      if (!printedLabel) {
        spinner.stop();
        process.stdout.write(responseLabel());
        printedLabel = true;
      }
      process.stdout.write(chunk);
    },
  });
  spinner.stop();

  console.log(dim("\n\n---"));
  console.log(dim(`Iterationen: ${result.iterations}`));
  if (result.toolsUsed.length > 0) {
    console.log(dim(`Tools verwendet: ${result.toolsUsed.join(", ")}`));
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

function skillsCommand() {
  const skills = listInstalledSkills();
  console.log(`\nInstallierte Skills (${skills.length}):`);
  for (const skill of skills) {
    console.log(`  - ${skill.slug}: ${skill.description ?? "(keine Beschreibung)"}`);
  }
  console.log('\nAufruf: "/skill-slug deine Nachricht" ruft einen Skill explizit auf (bis zu 5 gestapelt).');
}

function printHelp() {
  console.log(`
DucKI Agent CLI

Verwendung:
  ducki chat          Interaktiver Chat
  ducki run <task>    Aufgabe ausführen
  ducki tasks         Aufgaben anzeigen
  ducki tools         Tools anzeigen
  ducki skills        Skills anzeigen

Im Chat:
  /skills                     Skills auflisten
  /skill-slug deine Nachricht Skill explizit aufrufen (bis zu 5 gestapelt)
  `);
}

main().catch((error) => {
  logger.error("CLI error", { error: String(error) });
  process.exit(1);
});
