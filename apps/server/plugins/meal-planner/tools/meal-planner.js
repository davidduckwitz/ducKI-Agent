/**
 * Meal planner module tool (trust: "node"). Recipes (with a JSON ingredient list) and a
 * date-keyed weekly plan in the plugin's own SQLite. `generate_shopping_list` aggregates
 * ingredient quantities across the requested date range but does NOT write to the
 * shopping-list plugin's database directly (plugins are isolated) - it returns the aggregated
 * list for the agent to hand off via the shopping_list tool's add_item action.
 */

export const definition = {
  name: "meal_planner",
  description:
    "Wochenplan und Rezeptdatenbank. action=add_recipe/list_recipes/get_recipe/delete_recipe für Rezepte. " +
    "action=set_plan (date, recipe_id)/get_week_plan (start_date)/clear_plan (date) für den Wochenplan. " +
    "action=generate_shopping_list (start_date) aggregiert die Zutaten von 7 Tagen ab start_date - das Ergebnis dann per shopping_list-Tool (add_item je Zutat) übernehmen.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add_recipe", "list_recipes", "get_recipe", "delete_recipe", "set_plan", "get_week_plan", "clear_plan", "generate_shopping_list"],
      },
      id: { type: "number", description: "Rezept-ID (get_recipe/delete_recipe/set_plan)" },
      name: { type: "string", description: "Rezeptname (add_recipe)" },
      ingredients: {
        type: "array", description: "Zutatenliste (add_recipe), je { name, quantity, unit }",
        items: { type: "object", properties: { name: { type: "string" }, quantity: { type: "number" }, unit: { type: "string" } } },
      },
      instructions: { type: "string", description: "Zubereitung (add_recipe)" },
      servings: { type: "number", description: "Anzahl Portionen (add_recipe)" },
      date: { type: "string", description: "ISO-Datum YYYY-MM-DD (set_plan/clear_plan)" },
      recipe_id: { type: "number", description: "Rezept-ID für set_plan" },
      start_date: { type: "string", description: "ISO-Datum YYYY-MM-DD, Beginn der 7-Tage-Woche (get_week_plan/generate_shopping_list)" },
    },
    required: ["action"],
  },
};

async function ensureSchema(storage) {
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ingredients TEXT NOT NULL, instructions TEXT, servings INTEGER, created_at TEXT NOT NULL)"
  );
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS plan (date TEXT PRIMARY KEY, recipe_id INTEGER NOT NULL)"
  );
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function parseRecipe(row) {
  let ingredients = [];
  try { ingredients = JSON.parse(row.ingredients || "[]"); } catch { ingredients = []; }
  return { ...row, ingredients };
}

export async function execute(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  await ensureSchema(storage);

  if (input.action === "add_recipe") {
    if (!input.name) return { error: "name ist erforderlich" };
    const res = await storage.query(
      "INSERT INTO recipes (name, ingredients, instructions, servings, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
      [input.name, JSON.stringify(input.ingredients || []), input.instructions ?? null, input.servings ?? null, new Date().toISOString()]
    );
    return { added: true, recipe: parseRecipe(res[0]) };
  }

  if (input.action === "list_recipes") {
    const rows = await storage.query("SELECT * FROM recipes ORDER BY name ASC");
    return { count: rows.length, recipes: rows.map(parseRecipe) };
  }

  if (input.action === "get_recipe") {
    if (input.id == null) return { error: "id ist erforderlich" };
    const rows = await storage.query("SELECT * FROM recipes WHERE id = ?", [input.id]);
    if (!rows[0]) return { error: "Rezept nicht gefunden" };
    return parseRecipe(rows[0]);
  }

  if (input.action === "delete_recipe") {
    if (input.id == null) return { error: "id ist erforderlich" };
    await storage.exec("DELETE FROM recipes WHERE id = ?", [input.id]);
    await storage.exec("DELETE FROM plan WHERE recipe_id = ?", [input.id]);
    return { ok: true };
  }

  if (input.action === "set_plan") {
    if (!input.date || input.recipe_id == null) return { error: "date und recipe_id sind erforderlich" };
    await storage.exec(
      "INSERT INTO plan (date, recipe_id) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET recipe_id = excluded.recipe_id",
      [input.date, input.recipe_id]
    );
    return { ok: true };
  }

  if (input.action === "clear_plan") {
    if (!input.date) return { error: "date ist erforderlich" };
    await storage.exec("DELETE FROM plan WHERE date = ?", [input.date]);
    return { ok: true };
  }

  if (input.action === "get_week_plan" || input.action === "generate_shopping_list") {
    const start = input.start_date || new Date().toISOString().slice(0, 10);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const planRows = await storage.query(`SELECT * FROM plan WHERE date IN (${days.map(() => "?").join(",")})`, days);
    const recipeIds = [...new Set(planRows.map((r) => r.recipe_id))];
    const recipes = recipeIds.length
      ? await storage.query(`SELECT * FROM recipes WHERE id IN (${recipeIds.map(() => "?").join(",")})`, recipeIds)
      : [];
    const recipeById = new Map(recipes.map((r) => [r.id, parseRecipe(r)]));

    if (input.action === "get_week_plan") {
      const week = days.map((date) => {
        const planned = planRows.find((r) => r.date === date);
        return { date, recipe: planned ? recipeById.get(planned.recipe_id) ?? null : null };
      });
      return { start_date: start, week };
    }

    // generate_shopping_list: sum quantities per name+unit across every planned recipe.
    const totals = new Map();
    for (const planned of planRows) {
      const recipe = recipeById.get(planned.recipe_id);
      if (!recipe) continue;
      for (const ing of recipe.ingredients) {
        const key = `${ing.name}__${ing.unit || ""}`;
        const prev = totals.get(key) || { name: ing.name, unit: ing.unit || null, quantity: 0 };
        prev.quantity += Number(ing.quantity) || 0;
        totals.set(key, prev);
      }
    }
    return { start_date: start, ingredients: [...totals.values()] };
  }

  return { error: `Unbekannte action: ${input.action}` };
}
