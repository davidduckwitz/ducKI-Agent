export class MemorySystem {
    db;
    logger;
    shortTermBuffer = [];
    maxShortTerm = 20;
    constructor(db, logger) {
        this.db = db;
        this.logger = logger;
    }
    async addShortTerm(content, importance = 1, conversationId) {
        const entry = { content, importance, type: "short-term", conversationId };
        this.shortTermBuffer.push(entry);
        if (this.shortTermBuffer.length > this.maxShortTerm) {
            this.consolidate();
        }
        await this.db.addMemory({ content, importance, type: "short-term", conversationId });
    }
    async addLongTerm(content, importance = 5, conversationId) {
        await this.addLongTermIfNovel(content, importance, conversationId);
    }
    async addLongTermIfNovel(content, importance = 5, conversationId) {
        const normalized = this.normalize(content);
        if (!normalized)
            return false;
        const existing = await this.db.getMemories(undefined, "long-term");
        const duplicate = existing.some((entry) => this.similarity(this.normalize(entry.content), normalized) >= 0.9);
        if (duplicate) {
            this.logger.debug("Skipped duplicate long-term memory", { preview: normalized.slice(0, 60) });
            return false;
        }
        await this.db.addMemory({ content: normalized, importance, type: "long-term", conversationId });
        this.logger.debug("Long-term memory added", { content: normalized.slice(0, 60), importance });
        return true;
    }
    async rememberFromSuccessfulTask(taskInput, taskResultData, conversationId) {
        const action = String(taskInput["action"] ?? "").toLowerCase();
        const resultObject = this.asObject(taskResultData);
        const status = String(resultObject?.["status"] ?? "").toLowerCase();
        const resultText = String(resultObject?.["result"] ?? "").trim();
        const title = String(resultObject?.["title"] ?? "").trim();
        const taskId = resultObject?.["id"];
        const completed = action === "complete" || status === "completed";
        if (!completed) {
            return {
                shouldRemember: false,
                stored: false,
                reason: "task_not_completed",
            };
        }
        if (!title && !resultText) {
            return {
                shouldRemember: false,
                stored: false,
                reason: "missing_task_signal",
            };
        }
        const content = [
            "Task learning",
            taskId !== undefined ? `#${String(taskId)}` : undefined,
            title ? `Title: ${title}` : undefined,
            resultText ? `Result: ${resultText}` : "Result: Task completed successfully",
        ]
            .filter((part) => Boolean(part && part.trim().length > 0))
            .join(" | ");
        const importance = resultText.length >= 80 ? 8 : 7;
        const stored = await this.addLongTermIfNovel(content, importance, conversationId);
        return {
            shouldRemember: true,
            stored,
            reason: stored ? "stored" : "duplicate",
            content,
            importance,
        };
    }
    async rememberFromSuccessfulTool(toolName, toolInput, toolResultData, conversationId) {
        const normalizedTool = toolName.trim().toLowerCase();
        if (normalizedTool === "task") {
            return this.rememberFromSuccessfulTask(toolInput, toolResultData, conversationId);
        }
        if (normalizedTool === "workflow") {
            const action = String(toolInput["action"] ?? "").toLowerCase();
            const result = this.asObject(toolResultData);
            const workflowId = String(result?.["id"] ?? result?.["workflowId"] ?? toolInput["id"] ?? "").trim();
            const status = String(result?.["status"] ?? "").toLowerCase();
            if (!action) {
                return {
                    shouldRemember: false,
                    stored: false,
                    reason: "missing_workflow_signal",
                };
            }
            if (!["create", "update", "run", "resume"].includes(action)) {
                return {
                    shouldRemember: false,
                    stored: false,
                    reason: "workflow_action_not_eligible",
                };
            }
            const content = [
                "Workflow learning",
                workflowId ? `Id: ${workflowId}` : undefined,
                `Action: ${action}`,
                status ? `Status: ${status}` : undefined,
            ]
                .filter((part) => Boolean(part && part.trim().length > 0))
                .join(" | ");
            if (!this.shouldStoreLearning(content, 25)) {
                return {
                    shouldRemember: false,
                    stored: false,
                    reason: "low_signal_content",
                };
            }
            const importance = action === "run" || action === "resume" ? 7 : 6;
            const stored = await this.addLongTermIfNovel(content, importance, conversationId);
            return {
                shouldRemember: true,
                stored,
                reason: stored ? "stored" : "duplicate",
                content,
                importance,
            };
        }
        if (normalizedTool === "skill_manage") {
            const action = String(toolInput["action"] ?? "").toLowerCase();
            const skillName = String(toolInput["name"] ?? "").trim();
            if (!action || !skillName) {
                return {
                    shouldRemember: false,
                    stored: false,
                    reason: "missing_skill_signal",
                };
            }
            const content = `Skill workflow | Skill: ${skillName} | Action: ${action} | Successful pattern captured`;
            if (!this.shouldStoreLearning(content, 25)) {
                return {
                    shouldRemember: false,
                    stored: false,
                    reason: "low_signal_content",
                };
            }
            const stored = await this.addLongTermIfNovel(content, 6, conversationId);
            return {
                shouldRemember: true,
                stored,
                reason: stored ? "stored" : "duplicate",
                content,
                importance: 6,
            };
        }
        return {
            shouldRemember: false,
            stored: false,
            reason: "tool_not_eligible",
        };
    }
    consolidate() {
        this.shortTermBuffer = this.shortTermBuffer
            .sort((a, b) => b.importance - a.importance)
            .slice(0, Math.floor(this.maxShortTerm / 2));
    }
    async getRelevantContext(query, limit = 5) {
        const longTerm = await this.db.getMemories(undefined, "long-term");
        return longTerm
            .filter((m) => m.content.toLowerCase().includes(query.toLowerCase()))
            .slice(0, limit)
            .map((m) => m.content);
    }
    async buildSystemContext(conversationId) {
        const scoped = await this.getKnowledgePool(conversationId, true);
        const global = await this.getKnowledgePool(undefined, true);
        const combined = [];
        for (const item of [...scoped, ...global]) {
            const normalized = this.normalize(item);
            if (!normalized)
                continue;
            if (combined.some((existing) => this.similarity(existing, normalized) >= 0.9))
                continue;
            combined.push(normalized);
            if (combined.length >= 8)
                break;
        }
        if (combined.length === 0)
            return "";
        return `\n\n## Relevant Memory\n${combined.map((content) => `- ${content}`).join("\n")}`;
    }
    async buildDynamicContext(signals, conversationId, limit = 6) {
        const signalText = this.normalize(signals.join(" "));
        if (!signalText)
            return "";
        const scoped = await this.getKnowledgePool(conversationId, true);
        const global = await this.getKnowledgePool(undefined, true);
        const scored = [...scoped, ...global]
            .map((content) => {
            const normalized = this.normalize(content);
            const score = this.similarity(signalText, normalized) + this.profileBoost(signalText, normalized);
            return { content: normalized, score };
        })
            .filter((item) => item.content.length > 0 && item.score > 0)
            .sort((a, b) => b.score - a.score);
        const picked = [];
        for (const item of scored) {
            if (picked.some((existing) => this.similarity(existing, item.content) >= 0.9))
                continue;
            picked.push(item.content);
            if (picked.length >= limit)
                break;
        }
        if (picked.length === 0)
            return "";
        return `\n\n## Retrieved Memory\n${picked.map((content) => `- ${content}`).join("\n")}`;
    }
    summarizeConversation(messages) {
        const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content);
        const assistantMessages = messages
            .filter((m) => m.role === "assistant")
            .map((m) => m.content.slice(0, 100));
        return `User discussed: ${userMessages.slice(-3).join("; ")}. Agent responded about: ${assistantMessages.slice(-3).join("; ")}`;
    }
    asObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value))
            return undefined;
        return value;
    }
    async getKnowledgePool(conversationId, includeSemantic) {
        const longTerm = await this.db.getMemories(conversationId, "long-term");
        const semantic = includeSemantic ? await this.db.getMemories(conversationId, "semantic") : [];
        return [...longTerm, ...semantic].map((entry) => entry.content);
    }
    profileBoost(signal, content) {
        const userFocus = /user|human|preference|style|tone|behavior/.test(signal.toLowerCase());
        const isProfile = /\[profile:agent_behavior\]|\[profile:human_info\]/i.test(content);
        if (userFocus && isProfile)
            return 0.2;
        return 0;
    }
    shouldStoreLearning(content, minLength) {
        const normalized = this.normalize(content);
        if (normalized.length < minLength)
            return false;
        const tooGeneric = /(successful pattern captured|completed successfully|action: list)$/i.test(normalized);
        return !tooGeneric;
    }
    normalize(value) {
        return value.replace(/\s+/g, " ").trim();
    }
    similarity(a, b) {
        if (!a || !b)
            return 0;
        if (a === b)
            return 1;
        const aTokens = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2));
        const bTokens = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2));
        if (aTokens.size === 0 || bTokens.size === 0)
            return 0;
        let intersection = 0;
        for (const token of aTokens) {
            if (bTokens.has(token))
                intersection++;
        }
        const union = new Set([...aTokens, ...bTokens]).size;
        return union === 0 ? 0 : intersection / union;
    }
}
//# sourceMappingURL=memory.js.map