/**
 * Task management module tool (trust: "node"). Local tasks (with deadlines/priority/project)
 * in the plugin's own SQLite, plus optional two-way sync with Todoist's REST API v2 when
 * ctx.secrets.todoist_api_token is set. A task's `external_id` links it to its Todoist
 * counterpart once synced; local-only tasks simply have external_id = NULL.
 */

const TODOIST_API = "https://api.todoist.com/rest/v2";
const PRIORITY_TO_TODOIST = { low: 1, medium: 2, high: 4 };
const TODOIST_TO_PRIORITY = { 1: "low", 2: "medium", 3: "medium", 4: "high" };

export const definition = {
  name: "task_sync",
  description:
    "Task-Verwaltung mit Deadlines. action=add_task/list_tasks (status?, project?, overdue_only?)/update_task/complete_task/delete_task. " +
    "action=sync_todoist (direction: pull|push|both) synchronisiert mit Todoist, wenn ein API-Token in den Plugin-Einstellungen hinterlegt ist.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add_task", "list_tasks", "update_task", "complete_task", "delete_task", "sync_todoist"] },
      id: { type: "number", description: "Task-ID (update_task/complete_task/delete_task)" },
      title: { type: "string", description: "Titel (add_task/update_task)" },
      description: { type: "string", description: "Beschreibung (add_task/update_task)" },
      due_date: { type: "string", description: "Fälligkeitsdatum YYYY-MM-DD (add_task/update_task)" },
      priority: { type: "string", enum: ["low", "medium", "high"], description: "Priorität (add_task/update_task)" },
      project: { type: "string", description: "Projekt/Liste als Freitext (add_task/update_task/list_tasks-Filter)" },
      status: { type: "string", enum: ["open", "done"], description: "Filter für list_tasks" },
      overdue_only: { type: "boolean", description: "Nur überfällige offene Tasks (list_tasks)" },
      direction: { type: "string", enum: ["pull", "push", "both"], description: "Sync-Richtung für sync_todoist, Standard both" },
    },
    required: ["action"],
  },
};

async function ensureSchema(storage) {
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, due_date TEXT, priority TEXT NOT NULL DEFAULT 'medium', project TEXT, status TEXT NOT NULL DEFAULT 'open', external_id TEXT, created_at TEXT NOT NULL, completed_at TEXT)"
  );
}

async function todoistCall(ctx, token, path, init) {
  const res = await ctx.fetch(`${TODOIST_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init && init.headers) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Todoist API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function execute(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  await ensureSchema(storage);

  if (input.action === "add_task") {
    if (!input.title) return { error: "title ist erforderlich" };
    const res = await storage.query(
      "INSERT INTO tasks (title, description, due_date, priority, project, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?) RETURNING *",
      [input.title, input.description ?? null, input.due_date ?? null, input.priority || "medium", input.project ?? null, new Date().toISOString()]
    );
    return { added: true, task: res[0] };
  }

  if (input.action === "list_tasks") {
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const args = [];
    if (input.status) { sql += " AND status = ?"; args.push(input.status); }
    if (input.project) { sql += " AND project = ?"; args.push(input.project); }
    if (input.overdue_only) { sql += " AND status = 'open' AND due_date IS NOT NULL AND due_date < ?"; args.push(new Date().toISOString().slice(0, 10)); }
    sql += " ORDER BY (due_date IS NULL), due_date ASC, id DESC";
    const rows = await storage.query(sql, args);
    return { count: rows.length, tasks: rows };
  }

  if (input.action === "update_task") {
    if (input.id == null) return { error: "id ist erforderlich" };
    const fields = [];
    const args = [];
    for (const key of ["title", "description", "due_date", "priority", "project"]) {
      if (input[key] !== undefined) { fields.push(`${key} = ?`); args.push(input[key]); }
    }
    if (!fields.length) return { error: "Keine Felder zum Aktualisieren angegeben" };
    args.push(input.id);
    await storage.exec(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`, args);
    return { ok: true };
  }

  if (input.action === "complete_task") {
    if (input.id == null) return { error: "id ist erforderlich" };
    await storage.exec("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?", [new Date().toISOString(), input.id]);
    return { ok: true };
  }

  if (input.action === "delete_task") {
    if (input.id == null) return { error: "id ist erforderlich" };
    await storage.exec("DELETE FROM tasks WHERE id = ?", [input.id]);
    return { ok: true };
  }

  if (input.action === "sync_todoist") {
    const token = ctx.secrets.todoist_api_token;
    if (!token) return { error: "Kein Todoist-API-Token in den Plugin-Einstellungen hinterlegt." };
    const direction = input.direction || "both";
    let pulled = 0;
    let pushed = 0;
    let completedRemote = 0;

    try {
      if (direction === "pull" || direction === "both") {
        const remoteTasks = await todoistCall(ctx, token, "/tasks");
        for (const rt of remoteTasks) {
          const existing = await storage.query("SELECT * FROM tasks WHERE external_id = ?", [String(rt.id)]);
          const priority = TODOIST_TO_PRIORITY[rt.priority] || "medium";
          const dueDate = rt.due?.date || null;
          if (existing[0]) {
            await storage.exec("UPDATE tasks SET title = ?, description = ?, due_date = ?, priority = ? WHERE id = ?", [
              rt.content, rt.description || null, dueDate, priority, existing[0].id,
            ]);
          } else {
            await storage.exec(
              "INSERT INTO tasks (title, description, due_date, priority, project, status, external_id, created_at) VALUES (?, ?, ?, ?, 'Todoist', 'open', ?, ?)",
              [rt.content, rt.description || null, dueDate, priority, String(rt.id), new Date().toISOString()]
            );
          }
          pulled += 1;
        }
        // A local task with an external_id that no longer appears remotely was completed/deleted there.
        const localSynced = await storage.query("SELECT * FROM tasks WHERE external_id IS NOT NULL AND status = 'open'");
        const remoteIds = new Set(remoteTasks.map((t) => String(t.id)));
        for (const local of localSynced) {
          if (!remoteIds.has(local.external_id)) {
            await storage.exec("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?", [new Date().toISOString(), local.id]);
            completedRemote += 1;
          }
        }
      }

      if (direction === "push" || direction === "both") {
        const unsynced = await storage.query("SELECT * FROM tasks WHERE external_id IS NULL AND status = 'open'");
        for (const local of unsynced) {
          const created = await todoistCall(ctx, token, "/tasks", {
            method: "POST",
            body: JSON.stringify({
              content: local.title,
              description: local.description || undefined,
              due_date: local.due_date || undefined,
              priority: PRIORITY_TO_TODOIST[local.priority] || 2,
            }),
          });
          await storage.exec("UPDATE tasks SET external_id = ? WHERE id = ?", [String(created.id), local.id]);
          pushed += 1;
        }
      }
    } catch (error) {
      ctx.logger?.warn?.("todoist sync failed", { error: error instanceof Error ? error.message : String(error) });
      return { error: error instanceof Error ? error.message : String(error), pulled, pushed };
    }

    return { ok: true, pulled, pushed, completedRemote };
  }

  return { error: `Unbekannte action: ${input.action}` };
}
