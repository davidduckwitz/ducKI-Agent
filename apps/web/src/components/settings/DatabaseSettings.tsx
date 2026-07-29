import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Save, Database, AlertCircle, CheckCircle, HardDrive } from "lucide-react";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";

interface Setting {
  key: string;
  value: string;
}

type DatabaseEngine = "sqlite" | "mysql";

const DATABASE_CONFIGS = {
  sqlite: {
    name: "SQLite",
    icon: "💾",
    description: "Lokale Datenbankdatei - ideal für Einzelnutzer und Tests",
    pros: ["Keine externe Abhängigkeit", "Einfache Einrichtung", "Fallback-Option"],
    cons: ["Nicht geeignet für hohe Concurrency", "Begrenzte Netzwerk-Unterstützung"],
    example: "file:./storage/ducki.db",
    template: "file:./storage/ducki.db",
  },
  mysql: {
    name: "MySQL/MariaDB",
    icon: "🗄️",
    description: "Netzwerk-basierte Datenbank - ideal für mehrere Benutzer und höhere Last",
    pros: ["Hohe Concurrency", "Netzwerk-fähig", "Backup- und Replication-Optionen"],
    cons: ["Externe Abhängigkeit erforderlich", "Komplexere Einrichtung"],
    example: "mysql://user:password@localhost:3306/ducki",
    template: "mysql://[user]:[password]@[host]:[port]/[database]",
  },
};

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

  const [engine, setEngine] = useState<DatabaseEngine>(
    (settingsMap.get("DATABASE_ENGINE") as DatabaseEngine) || "sqlite"
  );
  const [dbUrl, setDbUrl] = useState(
    settingsMap.get("DATABASE_URL") || DATABASE_CONFIGS.sqlite.template
  );
  const [fallbackUrl, setFallbackUrl] = useState(settingsMap.get("DB_URL") || "");

  const save = useMutation({
    mutationFn: async (data: Record<string, string>) => {
      for (const [key, value] of Object.entries(data)) {
        await api.settings.set(key, value);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.refetchQueries({ queryKey: ["settings"] });
    },
  });

  const handleEngineChange = (newEngine: DatabaseEngine) => {
    setEngine(newEngine);
    // Auto-update URL when switching engines
    setDbUrl(DATABASE_CONFIGS[newEngine].template);
  };

  const handleSaveAll = () => {
    save.mutate({
      DATABASE_ENGINE: engine,
      DATABASE_URL: dbUrl,
      DB_URL: fallbackUrl,
    });
  };

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
                onClick={() => handleEngineChange(dbEngine)}
                className={cn(
                  "text-left p-4 rounded-lg border-2 transition-all",
                  isSelected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50"
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
                        <p className="text-xs font-semibold text-green-600 dark:text-green-400">
                          Vorteile:
                        </p>
                        <ul className="text-xs text-muted-foreground space-y-1">
                          {config.pros.map((pro) => (
                            <li key={pro}>✓ {pro}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-red-600 dark:text-red-400">
                          Nachteile:
                        </p>
                        <ul className="text-xs text-muted-foreground space-y-1">
                          {config.cons.map((con) => (
                            <li key={con}>✗ {con}</li>
                          ))}
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

      {/* Connection URL Configuration */}
      <div className="card space-y-4">
        <h3 className="font-semibold flex items-center gap-2">
          <Database className="w-4 h-4" />
          Verbindungs-URL
        </h3>

        <div className="bg-muted/50 p-3 rounded-lg">
          <p className="text-sm text-muted-foreground mb-2">
            Format für {currentConfig.name}:
          </p>
          <code className="text-xs bg-background p-2 rounded block font-mono text-primary">
            {currentConfig.example}
          </code>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-semibold">Hauptverbindungs-URL</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={dbUrl}
              onChange={(e) => setDbUrl(e.target.value)}
              placeholder={currentConfig.template}
              className="input flex-1"
            />
            <button
              onClick={() =>
                save.mutate({
                  DATABASE_ENGINE: engine,
                  DATABASE_URL: dbUrl,
                  DB_URL: fallbackUrl,
                })
              }
              disabled={save.isPending}
              className="btn-primary flex items-center gap-1"
            >
              <Save className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {engine === "sqlite"
              ? "Pfad zur SQLite-Datenbankdatei (relativ oder absolut)"
              : "mysql://[Benutzer]:[Passwort]@[Host]:[Port]/[Datenbank]"}
          </p>
        </div>
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
          <div className="flex gap-2">
            <input
              type="text"
              value={fallbackUrl}
              onChange={(e) => setFallbackUrl(e.target.value)}
              placeholder="Leer lassen für automatisches SQLite-Fallback"
              className="input flex-1"
            />
            <button
              onClick={handleSaveAll}
              disabled={save.isPending}
              className="btn-primary flex items-center gap-1"
            >
              <Save className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Wenn leer: SQLite wird automatisch als Fallback verwendet (falls verfügbar)
          </p>
        </div>
      </div>

      {/* Info Box */}
      <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 p-4 rounded-lg">
        <p className="text-sm text-blue-900 dark:text-blue-100">
          <strong>Hinweis:</strong> Änderungen erfordern möglicherweise einen Neustart des Servers.
          SQLite ist immer als Fallback verfügbar und wird verwendet, wenn die
          Hauptverbindung fehlschlägt.
        </p>
      </div>

      {/* Save All Button */}
      <button
        onClick={handleSaveAll}
        disabled={save.isPending}
        className="btn-primary w-full flex items-center justify-center gap-2"
      >
        <Save className="w-4 h-4" />
        Alle Datenbankeinstellungen speichern
      </button>
    </div>
  );
}
