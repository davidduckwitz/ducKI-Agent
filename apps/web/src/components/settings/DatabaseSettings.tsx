import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Save, Database, AlertCircle, CheckCircle, HardDrive,
  Loader2, Eye, EyeOff, XCircle, PlugZap, Table2,
} from "lucide-react";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";

interface Setting {
  key: string;
  value: string;
}

type DatabaseEngine = "sqlite" | "mysql";

interface MysqlFields {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

type TestResult = Awaited<ReturnType<typeof api.settings.testDatabase>>;

const DATABASE_CONFIGS = {
  sqlite: {
    name: "SQLite",
    icon: "💾",
    description: "Lokale Datenbankdatei - ideal für Einzelnutzer und Tests",
    pros: ["Keine externe Abhängigkeit", "Einfache Einrichtung", "Fallback-Option"],
    cons: ["Nicht geeignet für hohe Concurrency", "Begrenzte Netzwerk-Unterstützung"],
  },
  mysql: {
    name: "MySQL/MariaDB",
    icon: "🗄️",
    description: "Netzwerk-basierte Datenbank - ideal für mehrere Benutzer und höhere Last",
    pros: ["Hohe Concurrency", "Netzwerk-fähig", "Backup- und Replication-Optionen"],
    cons: ["Externe Abhängigkeit erforderlich", "Komplexere Einrichtung"],
  },
};

function parseMysqlUrl(url: string): MysqlFields | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "mysql:" && u.protocol !== "mariadb:") return null;
    return {
      host: u.hostname || "localhost",
      port: u.port || "3306",
      user: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
      database: (u.pathname || "").replace(/^\//, ""),
    };
  } catch {
    return null;
  }
}

function buildMysqlUrl(f: MysqlFields): string {
  const user = encodeURIComponent(f.user.trim());
  const password = encodeURIComponent(f.password);
  const auth = f.password ? `${user}:${password}` : user;
  const host = f.host.trim() || "localhost";
  const port = f.port.trim() || "3306";
  return `mysql://${auth}@${host}:${port}/${f.database.trim()}`;
}

export function DatabaseSettings() {
  const qc = useQueryClient();
  const { data: settings = [] } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.settings.list() as Promise<Setting[]>,
    staleTime: 0,
    refetchOnMount: true,
    gcTime: 0,
  });

  const settingsMap = new Map((settings as Setting[]).map((s) => [s.key, s.value]));
  const storedUrl = settingsMap.get("DATABASE_URL") || "";
  const parsed = parseMysqlUrl(storedUrl);

  const [engine, setEngine] = useState<DatabaseEngine>(
    (settingsMap.get("DATABASE_ENGINE") as DatabaseEngine) || (parsed ? "mysql" : "sqlite")
  );
  const [sqlitePath, setSqlitePath] = useState(
    storedUrl && !parsed ? storedUrl : "file:./storage/ducki.db"
  );
  const [mysql, setMysql] = useState<MysqlFields>(
    parsed ?? { host: "localhost", port: "3306", user: "root", password: "", database: "ducki" }
  );
  const [showPassword, setShowPassword] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState(settingsMap.get("DB_URL") || "");
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saved, setSaved] = useState(false);

  const setMysqlField = (field: keyof MysqlFields, value: string) => {
    setMysql((prev) => ({ ...prev, [field]: value }));
    setTestResult(null);
  };

  const save = useMutation({
    mutationFn: async () => {
      const databaseUrl = engine === "mysql" ? buildMysqlUrl(mysql) : sqlitePath.trim();
      const data: Record<string, string> = {
        DATABASE_ENGINE: engine,
        DATABASE_URL: databaseUrl,
        DB_URL: fallbackUrl,
      };
      for (const [key, value] of Object.entries(data)) {
        await api.settings.set(key, value);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.refetchQueries({ queryKey: ["settings"] });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    },
  });

  const test = useMutation({
    mutationFn: () =>
      api.settings.testDatabase(
        engine === "mysql" ? { engine, ...mysql } : { engine: "sqlite" }
      ),
    onSuccess: (res) => setTestResult(res),
    onError: (error) =>
      setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  });

  const currentConfig = DATABASE_CONFIGS[engine];

  return (
    <div className="space-y-6">
      {/* Database Engine Selection */}
      <div className="card space-y-4">
        <div className="flex items-center gap-2">
          <HardDrive className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">Datenbankmotor wählen</h3>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {(["sqlite", "mysql"] as const).map((dbEngine) => {
            const config = DATABASE_CONFIGS[dbEngine];
            const isSelected = engine === dbEngine;
            return (
              <button
                key={dbEngine}
                onClick={() => {
                  setEngine(dbEngine);
                  setTestResult(null);
                }}
                className={cn(
                  "text-left p-4 rounded-lg border-2 transition-all",
                  isSelected ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                )}
              >
                <div className="flex items-start gap-3">
                  <span className="text-3xl">{config.icon}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold">{config.name}</h4>
                      {isSelected && <CheckCircle className="w-4 h-4 text-primary" />}
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">{config.description}</p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-xs font-semibold text-green-600 dark:text-green-400">Vorteile:</p>
                        <ul className="text-xs text-muted-foreground space-y-1">
                          {config.pros.map((pro) => <li key={pro}>✓ {pro}</li>)}
                        </ul>
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-red-600 dark:text-red-400">Nachteile:</p>
                        <ul className="text-xs text-muted-foreground space-y-1">
                          {config.cons.map((con) => <li key={con}>✗ {con}</li>)}
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Connection configuration */}
      <div className="card space-y-4">
        <h3 className="font-semibold flex items-center gap-2">
          <Database className="w-4 h-4" />
          Verbindung – {currentConfig.name}
        </h3>

        {engine === "sqlite" ? (
          <div className="space-y-2">
            <label className="text-sm font-semibold">SQLite-Dateipfad</label>
            <input
              type="text"
              value={sqlitePath}
              onChange={(e) => { setSqlitePath(e.target.value); setTestResult(null); }}
              placeholder="file:./storage/ducki.db"
              className="input w-full font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Pfad zur SQLite-Datenbankdatei (relativ oder absolut). SQLite ist der eingebaute Standard.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1 md:col-span-2">
                <label className="text-sm font-semibold">Host</label>
                <input
                  type="text"
                  value={mysql.host}
                  onChange={(e) => setMysqlField("host", e.target.value)}
                  placeholder="localhost"
                  className="input w-full"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-semibold">Port</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={mysql.port}
                  onChange={(e) => setMysqlField("port", e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="3306"
                  className="input w-full"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-semibold">Datenbank</label>
                <input
                  type="text"
                  value={mysql.database}
                  onChange={(e) => setMysqlField("database", e.target.value)}
                  placeholder="ducki"
                  className="input w-full"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-semibold">Benutzer</label>
                <input
                  type="text"
                  autoComplete="off"
                  value={mysql.user}
                  onChange={(e) => setMysqlField("user", e.target.value)}
                  placeholder="root"
                  className="input w-full"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-semibold">Passwort</label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={mysql.password}
                    onChange={(e) => setMysqlField("password", e.target.value)}
                    placeholder="••••••••"
                    className="input w-full pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? "Passwort verbergen" : "Passwort anzeigen"}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground font-mono break-all">
              → {buildMysqlUrl({ ...mysql, password: mysql.password ? "••••" : "" })}
            </p>
          </div>
        )}

        {/* Test connection */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => test.mutate()}
            disabled={test.isPending}
            className="btn-secondary flex items-center gap-2"
          >
            {test.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
            Verbindung testen
          </button>
        </div>

        {/* Test result */}
        {testResult && (
          <div
            className={cn(
              "rounded-lg border p-3 text-sm space-y-2",
              testResult.ok
                ? "border-emerald-600/40 bg-emerald-500/5"
                : "border-red-600/40 bg-red-500/5"
            )}
          >
            <div className="flex items-center gap-2 font-medium">
              {testResult.ok
                ? <CheckCircle className="w-4 h-4 text-emerald-500" />
                : <XCircle className="w-4 h-4 text-red-500" />}
              {testResult.ok
                ? (testResult.message ?? "Verbindung erfolgreich")
                : `Verbindung fehlgeschlagen: ${testResult.error ?? "unbekannter Fehler"}`}
            </div>

            {testResult.ok && testResult.serverVersion && (
              <p className="text-xs text-muted-foreground">
                Server: {testResult.serverVersion}
                {typeof testResult.latencyMs === "number" ? ` · ${testResult.latencyMs} ms` : ""}
              </p>
            )}

            {testResult.ok && testResult.tables && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs">
                  <Table2 className="w-3.5 h-3.5" />
                  {testResult.tables.allPresent ? (
                    <span className="text-emerald-500">
                      Alle {testResult.tables.expected} App-Tabellen vorhanden.
                    </span>
                  ) : (
                    <span className="text-amber-500">
                      {testResult.tables.present.length}/{testResult.tables.expected} App-Tabellen vorhanden
                      {" "}({testResult.tables.missing.length} fehlen)
                    </span>
                  )}
                </div>
                {!testResult.tables.allPresent && testResult.tables.missing.length > 0 && (
                  <p className="text-xs text-muted-foreground break-words">
                    Fehlend: {testResult.tables.missing.join(", ")}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Fallback Configuration */}
      <div className="card space-y-4 border-l-2 border-l-amber-500">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-5 h-5 text-amber-500 mt-0.5" />
          <div>
            <h3 className="font-semibold">Fallback-Verbindung</h3>
            <p className="text-sm text-muted-foreground">
              Optional: SQLite wird automatisch als Fallback verwendet, wenn die Hauptverbindung
              fehlschlägt. Hier können Sie eine alternative URL angeben.
            </p>
          </div>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-semibold">Fallback-URL (optional)</label>
          <input
            type="text"
            value={fallbackUrl}
            onChange={(e) => setFallbackUrl(e.target.value)}
            placeholder="Leer lassen für automatisches SQLite-Fallback"
            className="input w-full"
          />
        </div>
      </div>

      {/* Info Box */}
      <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 p-4 rounded-lg">
        <p className="text-sm text-blue-900 dark:text-blue-100">
          <strong>Hinweis:</strong> MariaDB/MySQL wird derzeit als <em>Zusatz</em> konfiguriert und
          getestet. Die App läuft weiterhin auf SQLite; ein Umzug der Laufzeit erfolgt in einem
          separaten Schritt. Änderungen erfordern einen Neustart des Servers.
        </p>
      </div>

      {/* Save */}
      <button
        onClick={() => save.mutate()}
        disabled={save.isPending}
        className="btn-primary w-full flex items-center justify-center gap-2"
      >
        {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
        {saved ? "Gespeichert" : "Alle Datenbankeinstellungen speichern"}
      </button>
    </div>
  );
}
