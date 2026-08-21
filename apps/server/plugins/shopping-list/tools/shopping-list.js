/**
 * Shopping list + pantry module tool (trust: "node"). Two tables in the plugin's own SQLite:
 * `items` (the actual shopping list) and `pantry` (stock with a low-stock threshold). Consuming
 * pantry stock below its threshold auto-adds a shopping list entry, so a running-low ingredient
 * doesn't need a separate "put it on the list" step.
 */

export const definition = {
  name: "shopping_list",
  description:
    "Einkaufsliste und Vorratsverwaltung. action=add_item/list_items/check_item/remove_item/clear_checked für die Liste. " +
    "action=set_pantry (upsert per name)/list_pantry/consume_pantry/remove_pantry für den Vorrat. " +
    "consume_pantry legt bei Unterschreitung des Mindestbestands automatisch einen Einkaufslisten-Eintrag an.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add_item", "list_items", "check_item", "remove_item", "clear_checked", "set_pantry", "list_pantry", "consume_pantry", "remove_pantry"],
      },
      id: { type: "number", description: "Ziel-ID für check_item/remove_item/remove_pantry" },
      name: { type: "string", description: "Artikelname (add_item/set_pantry/consume_pantry)" },
      quantity: { type: "number", description: "Menge (add_item/set_pantry/consume_pantry)" },
      unit: { type: "string", description: "Einheit, z. B. Stück, kg, l (add_item/set_pantry)" },
      checked: { type: "boolean", description: "Abgehakt-Status für check_item" },
      low_threshold: { type: "number", description: "Mindestbestand, ab dem consume_pantry automatisch auf die Einkaufsliste setzt (set_pantry)" },
    },
    required: ["action"],
  },
};

async function ensureSchema(storage) {
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, quantity REAL, unit TEXT, checked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"
  );
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS pantry (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, quantity REAL NOT NULL DEFAULT 0, unit TEXT, low_threshold REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)"
  );
}

export async function execute(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  await ensureSchema(storage);

  if (input.action === "add_item") {
    if (!input.name) return { error: "name ist erforderlich" };
    await storage.exec("INSERT INTO items (name, quantity, unit, checked, created_at) VALUES (?, ?, ?, 0, ?)", [
      input.name, input.quantity ?? null, input.unit ?? null, new Date().toISOString(),
    ]);
    return { added: true, name: input.name };
  }

  if (input.action === "list_items") {
    const items = await storage.query("SELECT * FROM items ORDER BY checked ASC, created_at DESC");
    return { count: items.length, items };
  }

  if (input.action === "check_item") {
    if (input.id == null) return { error: "id ist erforderlich" };
    await storage.exec("UPDATE items SET checked = ? WHERE id = ?", [input.checked === false ? 0 : 1, input.id]);
    return { ok: true };
  }

  if (input.action === "remove_item") {
    if (input.id == null) return { error: "id ist erforderlich" };
    await storage.exec("DELETE FROM items WHERE id = ?", [input.id]);
    return { ok: true };
  }

  if (input.action === "clear_checked") {
    await storage.exec("DELETE FROM items WHERE checked = 1");
    return { ok: true };
  }

  if (input.action === "set_pantry") {
    if (!input.name) return { error: "name ist erforderlich" };
    await storage.exec(
      "INSERT INTO pantry (name, quantity, unit, low_threshold, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(name) DO UPDATE SET quantity=excluded.quantity, unit=excluded.unit, low_threshold=excluded.low_threshold, updated_at=excluded.updated_at",
      [input.name, input.quantity ?? 0, input.unit ?? null, input.low_threshold ?? 0, new Date().toISOString()]
    );
    return { ok: true };
  }

  if (input.action === "list_pantry") {
    const pantry = await storage.query("SELECT * FROM pantry ORDER BY name ASC");
    return { count: pantry.length, pantry: pantry.map((p) => ({ ...p, low: Number(p.quantity) <= Number(p.low_threshold) })) };
  }

  if (input.action === "consume_pantry") {
    if (!input.name) return { error: "name ist erforderlich" };
    const rows = await storage.query("SELECT * FROM pantry WHERE name = ?", [input.name]);
    const row = rows[0];
    if (!row) return { error: `Kein Vorratseintrag für '${input.name}'` };
    const newQty = Math.max(0, Number(row.quantity) - Number(input.quantity ?? 1));
    await storage.exec("UPDATE pantry SET quantity = ?, updated_at = ? WHERE id = ?", [newQty, new Date().toISOString(), row.id]);
    let addedToList = false;
    if (newQty <= Number(row.low_threshold)) {
      await storage.exec("INSERT INTO items (name, quantity, unit, checked, created_at) VALUES (?, ?, ?, 0, ?)", [
        row.name, null, row.unit, new Date().toISOString(),
      ]);
      addedToList = true;
    }
    return { ok: true, newQuantity: newQty, addedToShoppingList: addedToList };
  }

  if (input.action === "remove_pantry") {
    if (input.id == null) return { error: "id ist erforderlich" };
    await storage.exec("DELETE FROM pantry WHERE id = ?", [input.id]);
    return { ok: true };
  }

  return { error: `Unbekannte action: ${input.action}` };
}
