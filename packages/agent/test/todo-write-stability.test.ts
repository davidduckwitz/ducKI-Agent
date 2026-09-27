import { describe, expect, it } from "vitest";
import { createTodoTool, TodoList } from "../src/coding/todo-tool.ts";

describe("TodoList.replace id stability", () => {
  it("keeps the same id for a title across repeated write calls", () => {
    const list = new TodoList();
    list.replace([{ title: "Read the router" }, { title: "Add the route" }]);
    const [firstId, secondId] = list.snapshot().map((item) => item.id);

    list.update(firstId!, "done");

    // Model calls write again mid-run (e.g. to add a step) - previously this reassigned
    // fresh ids to every item, invalidating firstId/secondId even though the titles didn't change.
    list.replace([
      { title: "Read the router" },
      { title: "Add the route" },
      { title: "Write a test" },
    ]);

    const after = list.snapshot();
    expect(after.find((item) => item.title === "Read the router")?.id).toBe(firstId);
    expect(after.find((item) => item.title === "Read the router")?.status).toBe("done");
    expect(after.find((item) => item.title === "Add the route")?.id).toBe(secondId);
    // update using the id remembered from before the second write must still work
    expect(list.update(secondId!, "done")).toBeDefined();
  });
});

describe("todo replace compatibility", () => {
  it("treats replace with progress updates as update, not as a new plan", async () => {
    const list = new TodoList();
    list.replace([{ title: "Read the router" }, { title: "Add the route" }]);
    const tool = createTodoTool(list);

    const result = await tool.execute({
      action: "replace",
      updates: [
        { id: 1, status: "done" },
        { id: 2, status: "in_progress" },
      ],
    });

    expect(result.success).toBe(true);
    expect(list.snapshot().map(({ id, title, status }) => ({ id, title, status }))).toEqual([
      { id: 1, title: "Read the router", status: "done" },
      { id: 2, title: "Add the route", status: "in_progress" },
    ]);
  });
});
