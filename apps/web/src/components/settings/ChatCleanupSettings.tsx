import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Trash2, Zap, BarChart3, Settings } from "lucide-react";
import { api } from "../../lib/api";

interface CleanupConfig {
  maxMessagesPerConversation: number;
  archiveAfterDaysInactive: number;
  autoCleanupEnabled: boolean;
}

interface CleanupResult {
  conversationsProcessed: number;
  messagesDeleted: number;
  conversationsArchived: number;
}

export function ChatCleanupSettings() {
  const qc = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState<CleanupConfig>({
    maxMessagesPerConversation: 50,
    archiveAfterDaysInactive: 30,
    autoCleanupEnabled: true,
  });

  const configQuery = useQuery({
    queryKey: ["chat", "cleanup", "config"],
    queryFn: async () => {
      const response = await fetch("/api/chat/cleanup/config");
      if (!response.ok) throw new Error("Failed to load cleanup config");
      return response.json().then((data) => data.data as CleanupConfig);
    },
    staleTime: 5 * 60 * 1000,
  });

  const saveConfigMutation = useMutation({
    mutationFn: async (config: Partial<CleanupConfig>) => {
      const response = await fetch("/api/chat/cleanup/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!response.ok) throw new Error("Failed to save config");
      return response.json().then((data) => data.data as CleanupConfig);
    },
    onSuccess: (data) => {
      setFormData(data);
      qc.invalidateQueries({ queryKey: ["chat", "cleanup", "config"] });
    },
  });

  const cleanupMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/chat/cleanup/run", {
        method: "POST",
      });
      if (!response.ok) throw new Error("Cleanup failed");
      return response.json().then((data) => data.data as CleanupResult);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat"] });
    },
  });

  if (configQuery.isLoading) {
    return <div className="p-4 text-center text-muted-foreground">Loading cleanup settings...</div>;
  }

  if (configQuery.data && !isSaving) {
    setFormData(configQuery.data);
    setIsSaving(true);
  }

  const handleSaveConfig = async () => {
    await saveConfigMutation.mutateAsync(formData);
  };

  return (
    <div className="space-y-6">
      {/* Settings Box */}
      <div className="border border-border rounded-lg p-6 bg-blue-500/5 dark:bg-blue-500/10">
        <div className="flex items-center gap-3 mb-4">
          <Settings className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          <h3 className="text-lg font-semibold text-foreground">Cleanup-Einstellungen</h3>
        </div>

        <div className="space-y-4">
          {/* Max Messages Setting */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Maximale Nachrichten pro Chat
            </label>
            <input
              type="number"
              min="10"
              max="500"
              value={formData.maxMessagesPerConversation}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  maxMessagesPerConversation: Math.max(10, parseInt(e.target.value) || 50),
                })
              }
              className="input w-full [color-scheme:light] dark:[color-scheme:dark]"
            />
            <p className="text-xs text-muted-foreground">
              Ältere Nachrichten werden automatisch gelöscht (Standard: 50)
            </p>
          </div>

          {/* Archive After Days Setting */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Archivieren nach Tagen (inaktiv)
            </label>
            <input
              type="number"
              min="1"
              max="365"
              value={formData.archiveAfterDaysInactive}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  archiveAfterDaysInactive: Math.max(1, parseInt(e.target.value) || 30),
                })
              }
              className="input w-full [color-scheme:light] dark:[color-scheme:dark]"
            />
            <p className="text-xs text-muted-foreground">
              Chats mit weniger als 10 Nachrichten werden archiviert (Standard: 30 Tage)
            </p>
          </div>

          {/* Auto Cleanup Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-foreground">
                Automatisches Cleanup aktivieren
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                Läuft sonntags um 2 Uhr morgens (wöchentlich)
              </p>
            </div>
            <input
              type="checkbox"
              checked={formData.autoCleanupEnabled}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  autoCleanupEnabled: e.target.checked,
                })
              }
              className="w-4 h-4 accent-primary rounded"
            />
          </div>

          <button
            onClick={handleSaveConfig}
            disabled={saveConfigMutation.isPending}
            className="btn-primary w-full justify-center disabled:opacity-50"
          >
            {saveConfigMutation.isPending ? "Speichert..." : "Einstellungen speichern"}
          </button>
        </div>
      </div>

      {/* Cleanup Action Box */}
      <div className="border border-border rounded-lg p-6 bg-amber-500/5 dark:bg-amber-500/10">
        <div className="flex items-center gap-3 mb-4">
          <Zap className="w-5 h-5 text-amber-600 dark:text-amber-400" />
          <h3 className="text-lg font-semibold text-foreground">Sofortiges Cleanup</h3>
        </div>

        <p className="text-sm text-muted-foreground mb-4">
          Führe die Cleanup-Funktion jetzt aus. Dies wird alte Nachrichten löschen und inaktive Chats archivieren.
        </p>

        {cleanupMutation.data && (
          <div className="mb-4 p-4 bg-card rounded-lg border border-green-500/30">
            <div className="flex items-center gap-3 mb-3">
              <BarChart3 className="w-5 h-5 text-green-600 dark:text-green-400" />
              <span className="font-medium text-green-700 dark:text-green-300">Cleanup erfolgreich!</span>
            </div>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-2xl font-bold text-foreground">
                  {cleanupMutation.data.conversationsProcessed}
                </div>
                <div className="text-xs text-muted-foreground">Chats verarbeitet</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                  {cleanupMutation.data.messagesDeleted}
                </div>
                <div className="text-xs text-muted-foreground">Nachrichten gelöscht</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                  {cleanupMutation.data.conversationsArchived}
                </div>
                <div className="text-xs text-muted-foreground">Chats archiviert</div>
              </div>
            </div>
          </div>
        )}

        <button
          onClick={() => cleanupMutation.mutate()}
          disabled={cleanupMutation.isPending}
          className="w-full px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded-md font-medium transition flex items-center justify-center gap-2"
        >
          <Trash2 className="w-4 h-4" />
          {cleanupMutation.isPending ? "Cleanup läuft..." : "Jetzt aufräumen"}
        </button>
      </div>

      {/* Info Box */}
      <div className="border border-border rounded-lg p-4 bg-muted/50">
        <h4 className="text-sm font-medium text-foreground mb-2">💡 Hinweis</h4>
        <ul className="text-xs text-muted-foreground space-y-1">
          <li>• Das wöchentliche Cleanup läuft automatisch jeden Sonntag um 2 Uhr</li>
          <li>• Alte Nachrichten werden permanent gelöscht, können nicht wiederhergestellt werden</li>
          <li>• Archivierte Chats können später manuell gelöscht werden</li>
          <li>• Größere Änderungen (z.B. auf 20 Nachrichten) führen zu mehr Speicherersparnis</li>
        </ul>
      </div>
    </div>
  );
}
