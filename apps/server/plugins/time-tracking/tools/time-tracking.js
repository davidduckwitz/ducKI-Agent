/**
 * Time tracking module tool (trust: "node"). Projects and time entries in the plugin's own
 * SQLite. An entry with ended_at = NULL is the currently running timer; only one can run at a
 * time (start_timer stops any other running entry first, same as a physical stopwatch).
 */

export const definition = {
  name: "time_tracking",
  description:
    "Projekte und Arbeitszeiten. action=add_project/list_projects für Projekte. " +
    "action=start_timer (project_id, note?)/stop_timer/list_entries (project_id?, from?, to?)/add_entry (manueller Eintrag)/delete_entry (id). " +
    "action=week_report (start_date) liefert Stunden und Betrag (Stunden*Stundensatz) je Projekt für 7 Tage ab start_date.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add_project", "list_projects", "start_timer", "stop_timer", "add_entry", "list_entries", "delete_entry", "week_report"] },
      id: { type: "number", description: "Eintrag-ID (delete_entry)" },
      name: { type: "string", description: "Projektname (add_project)" },
      hourly_rate: { type: "number", description: "Stundensatz (add_project)" },
      project_id: { type: "number", description: "Projekt (start_timer/add_entry/list_entries)" },
      note: { type: "string", description: "Notiz (start_timer/add_entry)" },
      started_at: { type: "string", description: "ISO-Zeitpunkt Start (add_entry)" },
      ended_at: { type: "string", description: "ISO-Zeitpunkt Ende (add_entry)" },
      from: { type: "string", description: "ISO-Datum Filter-Beginn (list_entries)" },
      to: { type: "string", description: "ISO-Datum Filter-Ende (list_entries)" },
      start_date: { type: "string", description: "ISO-Datum YYYY-MM-DD, Beginn der 7-Tage-Woche (week_report)" },
    },
    required: ["action"],
  },
};

async function ensureSchema(storage) {
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, hourly_rate REAL, created_at TEXT NOT NULL)"
  );
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, note TEXT, created_at TEXT NOT NULL)"
  );
}

function hoursBetween(startIso, endIso) {
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 3600000;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function execute(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  await ensureSchema(storage);

  if (input.action === "add_project") {
    if (!input.name) return { error: "name ist erforderlich" };
    const res = await storage.query("INSERT INTO projects (name, hourly_rate, created_at) VALUES (?, ?, ?) RETURNING *", [
      input.name, input.hourly_rate ?? null, new Date().toISOString(),
    ]);
    return { added: true, project: res[0] };
  }

  if (input.action === "list_projects") {
    const rows = await storage.query("SELECT * FROM projects ORDER BY name ASC");
    return { count: rows.length, projects: rows };
  }

  if (input.action === "start_timer") {
    if (input.project_id == null) return { error: "project_id ist erforderlich" };
    const running = await storage.query("SELECT * FROM entries WHERE ended_at IS NULL");
    for (const r of running) {
      await storage.exec("UPDATE entries SET ended_at = ? WHERE id = ?", [new Date().toISOString(), r.id]);
    }
    const now = new Date().toISOString();
    const res = await storage.query("INSERT INTO entries (project_id, started_at, ended_at, note, created_at) VALUES (?, ?, NULL, ?, ?) RETURNING *", [
      input.project_id, now, input.note ?? null, now,
    ]);
    return { started: true, entry: res[0], stoppedPrevious: running.length > 0 };
  }

  if (input.action === "stop_timer") {
    const running = await storage.query("SELECT * FROM entries WHERE ended_at IS NULL");
    if (!running.length) return { error: "Kein laufender Timer" };
    const now = new Date().toISOString();
    for (const r of running) await storage.exec("UPDATE entries SET ended_at = ? WHERE id = ?", [now, r.id]);
    return { stopped: true, entries: running.map((r) => ({ ...r, ended_at: now, hours: hoursBetween(r.started_at, now) })) };
  }

  if (input.action === "add_entry") {
    if (input.project_id == null || !input.started_at || !input.ended_at) return { error: "project_id, started_at und ended_at sind erforderlich" };
    const res = await storage.query("INSERT INTO entries (project_id, started_at, ended_at, note, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *", [
      input.project_id, input.started_at, input.ended_at, input.note ?? null, new Date().toISOString(),
    ]);
    return { added: true, entry: res[0] };
  }

  if (input.action === "list_entries") {
    let sql = "SELECT * FROM entries WHERE 1=1";
    const args = [];
    if (input.project_id != null) { sql += " AND project_id = ?"; args.push(input.project_id); }
    if (input.from) { sql += " AND started_at >= ?"; args.push(input.from); }
    if (input.to) { sql += " AND started_at <= ?"; args.push(input.to); }
    sql += " ORDER BY started_at DESC";
    const rows = await storage.query(sql, args);
    return {
      count: rows.length,
      entries: rows.map((r) => ({ ...r, hours: r.ended_at ? hoursBetween(r.started_at, r.ended_at) : null, running: !r.ended_at })),
    };
  }

  if (input.action === "delete_entry") {
    if (input.id == null) return { error: "id ist erforderlich" };
    await storage.exec("DELETE FROM entries WHERE id = ?", [input.id]);
    return { ok: true };
  }

  if (input.action === "week_report") {
    const start = input.start_date || new Date().toISOString().slice(0, 10);
    const end = addDays(start, 7);
    const rows = await storage.query(
      "SELECT * FROM entries WHERE ended_at IS NOT NULL AND started_at >= ? AND started_at < ?",
      [start + "T00:00:00.000Z", end + "T00:00:00.000Z"]
    );
    const projects = await storage.query("SELECT * FROM projects");
    const projectById = new Map(projects.map((p) => [p.id, p]));

    const byProject = new Map();
    for (const r of rows) {
      const hours = hoursBetween(r.started_at, r.ended_at);
      const prev = byProject.get(r.project_id) || { project_id: r.project_id, hours: 0 };
      prev.hours += hours;
      byProject.set(r.project_id, prev);
    }
    const report = [...byProject.values()].map((p) => {
      const project = projectById.get(p.project_id);
      const rate = project?.hourly_rate || 0;
      return { project_id: p.project_id, project_name: project?.name || `#${p.project_id}`, hours: Math.round(p.hours * 100) / 100, hourly_rate: rate, amount: Math.round(p.hours * rate * 100) / 100 };
    });
    return { start_date: start, end_date: end, report };
  }

  return { error: `Unbekannte action: ${input.action}` };
}
