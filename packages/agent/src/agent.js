import { getRootLogger } from "@ducki/logger";
import { ConversationManager } from "./conversation.js";
import { MemorySystem } from "./memory.js";
import { Planner } from "./planner.js";
import { Executor } from "./executor.js";
import { Reasoner } from "./reasoner.js";
import { Reflection } from "./reflection.js";
import { History } from "./history.js";
import { createWorkflowTools } from "./workflow-tools.js";
const DEFAULT_SYSTEM_PROMPT = `You are DucKI, an intelligent AI coding and task agent. You are helpful, accurate, and professional.
Use the available tools to create and manage projects and tasks, then work them through to completion.
When a request needs execution, plan first, create or update project/task records as needed, then use tools to carry out the work.
Always think step-by-step, keep state in the database, and return concise progress updates.
When you want to call a tool, emit exactly [TOOL:name({json})] with valid JSON arguments.`;
export class Agent {
    provider;
    db;
    name;
    status = "idle";
    systemPrompt;
    maxIterations;
    timeoutMs;
    enableReflection;
    enablePlanning;
    conversation;
    memory;
    planner;
    executor;
    reasoner;
    reflection;
    history;
    logger;
    constructor(provider, db, options = {}) {
        this.provider = provider;
        this.db = db;
        this.name = options.name ?? "DucKI";
        this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
        this.maxIterations = options.maxIterations ?? parseInt(process.env["AGENT_MAX_ITERATIONS"] ?? "50");
        this.timeoutMs = options.timeoutMs ?? parseInt(process.env["AGENT_TIMEOUT_MS"] ?? "300000");
        this.enableReflection = options.enableReflection ?? false;
        this.enablePlanning = options.enablePlanning ?? true;
        this.logger = getRootLogger().child(`Agent:${this.name}`);
        this.conversation = new ConversationManager(db, this.logger);
        this.memory = new MemorySystem(db, this.logger);
        this.planner = new Planner(provider, this.logger);
        this.executor = new Executor(this.logger);
        for (const tool of createWorkflowTools(db)) {
            this.executor.registerTool(tool);
        }
        this.reasoner = new Reasoner(provider, this.logger);
        this.reflection = new Reflection(provider, this.logger);
        this.history = new History();
    }
    async startConversation(options = {}) {
        return this.conversation.start(options);
    }
    async loadConversation(id) {
        return this.conversation.load(id);
    }
    async run(userInput, options = {}) {
        if (this.status === "running") {
            throw new Error("Agent is already running");
        }
        this.status = "running";
        const toolsUsed = [];
        let iterations = 0;
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Agent timeout")), this.timeoutMs));
        try {
            const result = await Promise.race([
                this.runLoop(userInput, toolsUsed, iterations, options),
                timeoutPromise,
            ]);
            this.status = "idle";
            return result;
        }
        catch (error) {
            this.status = "error";
            throw error;
        }
    }
    async runLoop(userInput, toolsUsed, iterations, options) {
        // Add user message
        const userMessage = { role: "user", content: userInput };
        this.conversation.addMessage(userMessage);
        this.history.add(userMessage);
        const memoryContext = this.memory.buildSystemContext(this.conversation.id);
        const availableTools = this.executor.listTools();
        const toolContext = availableTools.length > 0
            ? `\n\n## Available Tools\n${availableTools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")}`
            : "";
        const planContext = this.enablePlanning
            ? await this.planner.createPlan(userInput, availableTools.map((tool) => tool.name))
            : undefined;
        const systemMessage = {
            role: "system",
            content: this.systemPrompt +
                toolContext +
                (planContext ? `\n\n## Working Plan\n${JSON.stringify(planContext, null, 2)}` : "") +
                memoryContext +
                "\n\n## Task Rules\n- Create a project before creating project-specific tasks when the work should be tracked long-term.\n- Mark a task running before execution and completed or failed when finished.\n- Persist results in the database so the UI can show progress.\n- Use tools whenever state must change.",
        };
        let finalResponse = "";
        while (iterations < this.maxIterations) {
            iterations++;
            this.logger.debug("Agent iteration", { iteration: iterations });
            const messages = [systemMessage, ...this.conversation.getMessages()];
            // Generate response
            let response;
            if (options.stream && this.provider.supportsStreaming()) {
                const result = await this.provider.generateStream(messages, {}, options.onChunk);
                response = result.content;
            }
            else {
                const result = await this.provider.generate(messages);
                response = result.content;
            }
            finalResponse = response;
            // Add assistant message
            const assistantMessage = { role: "assistant", content: response };
            this.conversation.addMessage(assistantMessage);
            this.history.add(assistantMessage);
            // Check if we need to use any tools (simple heuristic)
            // In a full implementation, the LLM would return tool_calls
            const toolCallMatch = response.match(/\[TOOL:(\w+)\((.+?)\)\]/s);
            if (!toolCallMatch) {
                break; // No tool calls, we're done
            }
            const [, toolName, toolArgsStr] = toolCallMatch;
            if (!toolName)
                break;
            try {
                const toolInput = JSON.parse(toolArgsStr ?? "{}");
                const toolResult = await this.executor.execute(toolName, toolInput);
                toolsUsed.push(toolName);
                const toolResultMessage = {
                    role: "tool",
                    content: JSON.stringify(toolResult),
                    toolCallId: `call_${iterations}`,
                };
                this.conversation.addMessage(toolResultMessage);
                this.history.add(toolResultMessage, toolName);
            }
            catch {
                break;
            }
        }
        // Add to memory
        this.memory.addShortTerm(`User: ${userInput.slice(0, 100)} | Agent: ${finalResponse.slice(0, 100)}`, 2, this.conversation.id);
        return {
            response: finalResponse,
            iterations,
            toolsUsed,
            conversationId: this.conversation.id,
        };
    }
    stop() {
        this.status = "stopped";
        this.logger.info("Agent stopped");
    }
    getStatus() {
        return this.status;
    }
    getHistory() {
        return this.history;
    }
}
//# sourceMappingURL=agent.js.map