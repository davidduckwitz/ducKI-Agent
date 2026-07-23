export class TaskGraph {
    nodes = new Map();
    addNode(node) {
        this.nodes.set(node.id, node);
    }
    getNode(id) {
        return this.nodes.get(id);
    }
    getReadyNodes() {
        return Array.from(this.nodes.values()).filter((node) => {
            if (node.status !== "pending")
                return false;
            return node.dependsOn.every((dep) => {
                const depNode = this.nodes.get(dep);
                return depNode?.status === "completed";
            });
        });
    }
    updateStatus(id, status, result) {
        const node = this.nodes.get(id);
        if (node) {
            node.status = status;
            if (result)
                node.result = result;
        }
    }
    isComplete() {
        return Array.from(this.nodes.values()).every((n) => n.status === "completed" || n.status === "failed");
    }
    toArray() {
        return Array.from(this.nodes.values());
    }
}
export class TaskPlanner {
    db;
    provider;
    logger;
    constructor(db, provider, logger) {
        this.db = db;
        this.provider = provider;
        this.logger = logger;
    }
    async createTasksFromGoal(goal, projectId) {
        this.logger.info("Creating tasks from goal", { goal });
        const response = await this.provider.generate([
            {
                role: "system",
                content: `Break down the goal into specific tasks. Return JSON array:
[
  {
    "title": "task title",
    "description": "detailed description",
    "priority": "low|medium|high|critical",
    "dependsOn": []
  }
]
Return only valid JSON, no markdown.`,
            },
            { role: "user", content: `Break down: ${goal}` },
        ], { temperature: 0.3, maxTokens: 2000 });
        try {
            const taskDefs = JSON.parse(response.content);
            const taskIds = [];
            for (const def of taskDefs) {
                const task = await this.db.createTask({
                    title: def.title,
                    description: def.description,
                    priority: def.priority ?? "medium",
                    status: "pending",
                    projectId,
                });
                taskIds.push(task.id);
            }
            this.logger.info("Tasks created", { count: taskIds.length });
            return taskIds;
        }
        catch {
            this.logger.warn("Failed to parse tasks, creating single task");
            const task = await this.db.createTask({
                title: goal.slice(0, 100),
                description: goal,
                priority: "medium",
                status: "pending",
                projectId,
            });
            return [task.id];
        }
    }
    buildGraph(tasks) {
        const graph = new TaskGraph();
        for (const task of tasks) {
            graph.addNode({
                id: String(task.id),
                taskId: task.id,
                title: task.title,
                description: task.description ?? "",
                status: task.status,
                priority: task.priority,
                dependsOn: [],
                children: [],
            });
        }
        return graph;
    }
}
export { TaskPlanner as Planner };
//# sourceMappingURL=index.js.map