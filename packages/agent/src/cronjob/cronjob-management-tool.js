import { isCronExpressionValid } from "@ducki/database";
function ok(data) {
    return { success: true, data };
}
function fail(error) {
    return { success: false, data: null, error };
}
function asTargetType(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized === "task" || normalized === "prompt" || normalized === "tool" || normalized === "skill") {
        return normalized;
    }
    return undefined;
}
function toJsonString(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value === "string")
        return value;
    return JSON.stringify(value);
}
export function createCronjobManagementTool(db) {
    return {
        name: "cronjob",
        description: "Create, read, update, and delete scheduled cron jobs for tasks, prompts, tools, and skills",
        definition: {
            name: "cronjob",
            description: "Cronjob management tool",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["list", "get", "create", "update", "delete"] },
                    id: { type: "number", description: "Cronjob id" },
                    name: { type: "string" },
                    schedule: { type: "string", description: "Cron expression: minute hour day month weekday" },
                    targetType: { type: "string", enum: ["task", "prompt", "tool", "skill"] },
                    targetRef: { type: "string", description: "Task ID, tool name, or skill slug" },
                    payload: { type: "object", description: "Target payload, for example prompt text or tool input" },
                    enabled: { type: "boolean" },
                },
                required: ["action"],
            },
        },
        async execute(input) {
            const action = String(input["action"] ?? "").trim().toLowerCase();
            try {
                switch (action) {
                    case "list": {
                        const items = await db.listCronJobs();
                        return ok(items);
                    }
                    case "get": {
                        const id = Number(input["id"]);
                        if (!Number.isFinite(id) || id <= 0)
                            return fail("cronjob:get requires numeric 'id'");
                        const job = await db.getCronJob(id);
                        if (!job)
                            return fail(`Cronjob '${id}' not found`);
                        return ok(job);
                    }
                    case "create": {
                        const name = String(input["name"] ?? "").trim();
                        const schedule = String(input["schedule"] ?? "").trim();
                        const targetType = asTargetType(input["targetType"]);
                        const targetRefRaw = input["targetRef"];
                        const targetRef = targetRefRaw === undefined || targetRefRaw === null ? null : String(targetRefRaw);
                        const enabled = input["enabled"] === false ? 0 : 1;
                        if (!name)
                            return fail("cronjob:create requires 'name'");
                        if (!schedule)
                            return fail("cronjob:create requires 'schedule'");
                        if (!isCronExpressionValid(schedule))
                            return fail("cronjob:create received invalid cron expression");
                        if (!targetType)
                            return fail("cronjob:create requires valid 'targetType' (task|prompt|tool|skill)");
                        if ((targetType === "task" || targetType === "tool" || targetType === "skill") && !targetRef) {
                            return fail("cronjob:create requires 'targetRef' for task, tool, and skill targets");
                        }
                        const created = await db.createCronJob({
                            name,
                            schedule,
                            targetType,
                            targetRef,
                            payload: toJsonString(input["payload"]),
                            enabled,
                        });
                        return ok(created);
                    }
                    case "update": {
                        const id = Number(input["id"]);
                        if (!Number.isFinite(id) || id <= 0)
                            return fail("cronjob:update requires numeric 'id'");
                        const patch = {};
                        if (input["name"] !== undefined)
                            patch["name"] = String(input["name"] ?? "").trim();
                        if (input["schedule"] !== undefined) {
                            const schedule = String(input["schedule"] ?? "").trim();
                            if (!isCronExpressionValid(schedule))
                                return fail("cronjob:update received invalid cron expression");
                            patch["schedule"] = schedule;
                        }
                        if (input["targetType"] !== undefined) {
                            const targetType = asTargetType(input["targetType"]);
                            if (!targetType)
                                return fail("cronjob:update requires valid 'targetType' when provided");
                            patch["targetType"] = targetType;
                        }
                        if (input["targetRef"] !== undefined) {
                            patch["targetRef"] = input["targetRef"] === null ? null : String(input["targetRef"]);
                        }
                        if (input["payload"] !== undefined) {
                            patch["payload"] = toJsonString(input["payload"]);
                        }
                        if (input["enabled"] !== undefined) {
                            patch["enabled"] = input["enabled"] === false ? 0 : 1;
                        }
                        const updated = await db.updateCronJob(id, patch);
                        if (!updated)
                            return fail(`Cronjob '${id}' not found`);
                        return ok(updated);
                    }
                    case "delete": {
                        const id = Number(input["id"]);
                        if (!Number.isFinite(id) || id <= 0)
                            return fail("cronjob:delete requires numeric 'id'");
                        await db.deleteCronJob(id);
                        return ok({ deleted: true, id });
                    }
                    default:
                        return fail(`Unknown cronjob action '${action}'`);
                }
            }
            catch (error) {
                return fail(error instanceof Error ? error.message : String(error));
            }
        },
    };
}
//# sourceMappingURL=cronjob-management-tool.js.map