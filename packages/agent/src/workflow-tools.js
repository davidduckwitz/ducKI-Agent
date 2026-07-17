function parseJsonArray(value) {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function serializeSubtasks(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === "string")
        return value;
    return JSON.stringify(value);
}
function ok(data) {
    return { success: true, data };
}
function fail(error) {
    return { success: false, data: null, error };
}
function mapTask(task) {
    if (!task)
        return task;
    return {
        ...task,
        subtasks: parseJsonArray(task.subtasks),
    };
}
function mapTasks(tasks) {
    return tasks.map((task) => mapTask(task));
}
export function createWorkflowTools(db) {
    const projectTool = {
        name: "project",
        description: "Create, list, inspect, update, and delete projects",
        definition: {
            name: "project",
            description: "Project management operations",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["create", "list", "get", "update", "delete"],
                    },
                    id: { type: "number", description: "Project id" },
                    name: { type: "string", description: "Project name" },
                    description: { type: "string", description: "Project description" },
                    folder: { type: "string", description: "Project folder path" },
                },
                required: ["action"],
            },
        },
        async execute(input) {
            const action = String(input["action"] ?? "");
            try {
                switch (action) {
                    case "create": {
                        const name = String(input["name"] ?? "").trim();
                        if (!name)
                            return fail("Project name is required");
                        const project = await db.createProject({
                            name,
                            description: input["description"] ? String(input["description"]) : undefined,
                            folder: input["folder"] ? String(input["folder"]) : undefined,
                        });
                        return ok(project);
                    }
                    case "list":
                        return ok(await db.listProjects());
                    case "get": {
                        const id = Number(input["id"]);
                        if (!Number.isFinite(id))
                            return fail("Valid project id is required");
                        const project = await db.getProject(id);
                        return project ? ok(project) : fail(`Project ${id} not found`);
                    }
                    case "update": {
                        const id = Number(input["id"]);
                        if (!Number.isFinite(id))
                            return fail("Valid project id is required");
                        const project = await db.updateProject(id, {
                            name: input["name"] ? String(input["name"]) : undefined,
                            description: input["description"] ? String(input["description"]) : undefined,
                            folder: input["folder"] ? String(input["folder"]) : undefined,
                        });
                        return project ? ok(project) : fail(`Project ${id} not found`);
                    }
                    case "delete": {
                        const id = Number(input["id"]);
                        if (!Number.isFinite(id))
                            return fail("Valid project id is required");
                        await db.deleteProject(id);
                        return ok({ deleted: true, id });
                    }
                    default:
                        return fail(`Unknown project action: ${action}`);
                }
            }
            catch (error) {
                return fail(error instanceof Error ? error.message : String(error));
            }
        },
    };
    const taskTool = {
        name: "task",
        description: "Create, list, inspect, update, and complete tasks",
        definition: {
            name: "task",
            description: "Task lifecycle operations",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["create", "list", "get", "update", "start", "complete", "fail", "delete"],
                    },
                    id: { type: "number", description: "Task id" },
                    projectId: { type: "number", description: "Project id" },
                    title: { type: "string", description: "Task title" },
                    description: { type: "string", description: "Task description" },
                    status: { type: "string", enum: ["pending", "running", "completed", "failed", "cancelled"] },
                    priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
                    result: { type: "string", description: "Task result or completion summary" },
                    subtasks: { description: "JSON array or array of subtasks" },
                },
                required: ["action"],
            },
        },
        async execute(input) {
            const action = String(input["action"] ?? "");
            try {
                switch (action) {
                    case "create": {
                        const title = String(input["title"] ?? "").trim();
                        if (!title)
                            return fail("Task title is required");
                        const priority = String(input["priority"] ?? "medium");
                        const task = await db.createTask({
                            title,
                            description: input["description"] ? String(input["description"]) : undefined,
                            projectId: input["projectId"] !== undefined ? Number(input["projectId"]) : undefined,
                            priority,
                            status: "pending",
                            subtasks: serializeSubtasks(input["subtasks"]),
                            result: input["result"] ? String(input["result"]) : undefined,
                        });
                        return ok(mapTask(task));
                    }
                    case "list": {
                        const projectId = input["projectId"] !== undefined ? Number(input["projectId"]) : undefined;
                        const tasks = await db.listTasks(Number.isFinite(projectId) ? projectId : undefined);
                        return ok(mapTasks(tasks));
                    }
                    case "get": {
                        const id = Number(input["id"]);
                        if (!Number.isFinite(id))
                            return fail("Valid task id is required");
                        const task = await db.getTask(id);
                        return task ? ok(mapTask(task)) : fail(`Task ${id} not found`);
                    }
                    case "update": {
                        const id = Number(input["id"]);
                        if (!Number.isFinite(id))
                            return fail("Valid task id is required");
                        const task = await db.updateTask(id, {
                            projectId: input["projectId"] !== undefined ? Number(input["projectId"]) : undefined,
                            title: input["title"] ? String(input["title"]) : undefined,
                            description: input["description"] ? String(input["description"]) : undefined,
                            status: input["status"] ? String(input["status"]) : undefined,
                            priority: input["priority"] ? String(input["priority"]) : undefined,
                            subtasks: input["subtasks"] !== undefined ? serializeSubtasks(input["subtasks"]) : undefined,
                            result: input["result"] ? String(input["result"]) : undefined,
                        });
                        return task ? ok(mapTask(task)) : fail(`Task ${id} not found`);
                    }
                    case "start":
                    case "complete":
                    case "fail": {
                        const id = Number(input["id"]);
                        if (!Number.isFinite(id))
                            return fail("Valid task id is required");
                        const result = input["result"] ? String(input["result"]) : undefined;
                        const task = await db.updateTask(id, {
                            status: action === "start" ? "running" : action === "complete" ? "completed" : "failed",
                            result,
                        });
                        return task ? ok(mapTask(task)) : fail(`Task ${id} not found`);
                    }
                    case "delete": {
                        const id = Number(input["id"]);
                        if (!Number.isFinite(id))
                            return fail("Valid task id is required");
                        await db.deleteTask(id);
                        return ok({ deleted: true, id });
                    }
                    default:
                        return fail(`Unknown task action: ${action}`);
                }
            }
            catch (error) {
                return fail(error instanceof Error ? error.message : String(error));
            }
        },
    };
    return [projectTool, taskTool];
}