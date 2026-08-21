/**
 * Invoicing module tool (trust: "node"). Customers and invoices in the plugin's own SQLite.
 * The invoice number sequence is per calendar year (prefix from settings, e.g. RE-2026-0001),
 * derived by counting existing invoices for that year - never reused, never decremented, so an
 * invoice is never deleted here (only a "cancelled" status would be added if ever needed) to
 * keep the sequence gap-free for tax purposes.
 */

export const definition = {
  name: "invoicing",
  description:
    "Rechnungen und Kunden. action=add_customer/list_customers für Kunden. " +
    "action=create_invoice (customer_id, items:[{description,qty,unit_price}], due_date) erzeugt automatisch die nächste Rechnungsnummer. " +
    "action=list_invoices (status?)/get_invoice (id)/mark_paid (id). action=export_csv (year) für den Steuerberater-Export.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add_customer", "list_customers", "create_invoice", "list_invoices", "get_invoice", "mark_paid", "export_csv"] },
      id: { type: "number", description: "Ziel-ID (get_invoice/mark_paid)" },
      name: { type: "string", description: "Kundenname (add_customer)" },
      address: { type: "string", description: "Kundenadresse (add_customer)" },
      email: { type: "string", description: "Kunden-E-Mail (add_customer)" },
      customer_id: { type: "number", description: "Kunde für create_invoice" },
      items: {
        type: "array", description: "Rechnungspositionen (create_invoice), je { description, qty, unit_price }",
        items: { type: "object", properties: { description: { type: "string" }, qty: { type: "number" }, unit_price: { type: "number" } } },
      },
      due_date: { type: "string", description: "Fälligkeitsdatum YYYY-MM-DD (create_invoice)" },
      status: { type: "string", enum: ["open", "paid"], description: "Filter für list_invoices" },
      year: { type: "number", description: "Jahr für export_csv" },
    },
    required: ["action"],
  },
};

async function ensureSchema(storage) {
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT, email TEXT, created_at TEXT NOT NULL)"
  );
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL UNIQUE, customer_id INTEGER NOT NULL, items TEXT NOT NULL, total REAL NOT NULL, issue_date TEXT NOT NULL, due_date TEXT, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, paid_at TEXT)"
  );
}

function parseInvoice(row) {
  let items = [];
  try { items = JSON.parse(row.items || "[]"); } catch { items = []; }
  return { ...row, items };
}

function itemsTotal(items) {
  return (items || []).reduce((sum, i) => sum + (Number(i.qty) || 0) * (Number(i.unit_price) || 0), 0);
}

export async function execute(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  await ensureSchema(storage);

  if (input.action === "add_customer") {
    if (!input.name) return { error: "name ist erforderlich" };
    const res = await storage.query(
      "INSERT INTO customers (name, address, email, created_at) VALUES (?, ?, ?, ?) RETURNING *",
      [input.name, input.address ?? null, input.email ?? null, new Date().toISOString()]
    );
    return { added: true, customer: res[0] };
  }

  if (input.action === "list_customers") {
    const rows = await storage.query("SELECT * FROM customers ORDER BY name ASC");
    return { count: rows.length, customers: rows };
  }

  if (input.action === "create_invoice") {
    if (input.customer_id == null) return { error: "customer_id ist erforderlich" };
    if (!input.items || !input.items.length) return { error: "items ist erforderlich" };
    const customers = await storage.query("SELECT * FROM customers WHERE id = ?", [input.customer_id]);
    if (!customers[0]) return { error: "Kunde nicht gefunden" };

    const year = new Date().getFullYear();
    const prefix = ctx.settings.invoice_prefix || "RE";
    const existing = await storage.query("SELECT COUNT(*) as n FROM invoices WHERE number LIKE ?", [`${prefix}-${year}-%`]);
    const seq = (Number(existing[0]?.n) || 0) + 1;
    const number = `${prefix}-${year}-${String(seq).padStart(4, "0")}`;
    const total = itemsTotal(input.items);
    const now = new Date().toISOString();

    const res = await storage.query(
      "INSERT INTO invoices (number, customer_id, items, total, issue_date, due_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?) RETURNING *",
      [number, input.customer_id, JSON.stringify(input.items), total, now.slice(0, 10), input.due_date ?? null, now]
    );
    return { created: true, invoice: parseInvoice(res[0]) };
  }

  if (input.action === "list_invoices") {
    const rows = input.status
      ? await storage.query("SELECT * FROM invoices WHERE status = ? ORDER BY created_at DESC", [input.status])
      : await storage.query("SELECT * FROM invoices ORDER BY created_at DESC");
    return { count: rows.length, invoices: rows.map(parseInvoice) };
  }

  if (input.action === "get_invoice") {
    if (input.id == null) return { error: "id ist erforderlich" };
    const rows = await storage.query("SELECT * FROM invoices WHERE id = ?", [input.id]);
    if (!rows[0]) return { error: "Rechnung nicht gefunden" };
    const customers = await storage.query("SELECT * FROM customers WHERE id = ?", [rows[0].customer_id]);
    return { ...parseInvoice(rows[0]), customer: customers[0] || null };
  }

  if (input.action === "mark_paid") {
    if (input.id == null) return { error: "id ist erforderlich" };
    await storage.exec("UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?", [new Date().toISOString(), input.id]);
    return { ok: true };
  }

  if (input.action === "export_csv") {
    const year = input.year || new Date().getFullYear();
    const rows = await storage.query("SELECT * FROM invoices WHERE issue_date LIKE ? ORDER BY number ASC", [`${year}-%`]);
    const header = "Nummer;Datum;Faellig;Status;Kunde-ID;Netto-Summe";
    const lines = rows.map((r) => [r.number, r.issue_date, r.due_date || "", r.status, r.customer_id, r.total.toFixed(2)].join(";"));
    return { year, count: rows.length, csv: [header, ...lines].join("\n") };
  }

  return { error: `Unbekannte action: ${input.action}` };
}
