import type { DatabaseService, TaskSelect } from "@ducki/database";
import { TaskSplitter, type SplitSubtask } from "./task-splitter.js";

export interface PreviewSplitResult {
  parentTask: TaskSelect;
  complexity: number;
  subtasks: SplitSubtask[];
}

const splitter = new TaskSplitter();

/**
 * Pure preview - no persistence. Used both by the REST route (first call,
 * dryRun default) and by the `task` tool's `split` action.
 */
export async function previewSplit(db: DatabaseService, taskId: number): Promise<PreviewSplitResult> {
  const parentTask = await db.getTask(taskId);
  if (!parentTask) throw new Error(`Task ${taskId} not found`);

  const { subtasks, complexity } = splitter.split(parentTask.title, parentTask.description ?? "");
  return { parentTask, complexity, subtasks };
}

/**
 * Persists subtasks as real rows in the `tasks` table, linked to the parent via
 * `parentTaskId` and tagged with `createdBy` so they can later be found/cleaned
 * up by whatever created them (see tool_factory's list_owned/cleanup actions).
 */
export async function commitSplit(
  db: DatabaseService,
  parentTask: TaskSelect,
  subtasks: SplitSubtask[],
  ownerTag: string
): Promise<TaskSelect[]> {
  const created: TaskSelect[] = [];
  for (const subtask of subtasks) {
    const row = await db.createTask({
      title: subtask.title,
      description: subtask.description,
      projectId: parentTask.projectId ?? undefined,
      priority: parentTask.priority,
      status: "pending",
      parentTaskId: parentTask.id,
      createdBy: ownerTag,
    });
    created.push(row);
  }
  return created;
}
