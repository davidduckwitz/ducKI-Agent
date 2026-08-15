import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudUpload, CloudDownload, Unlink, Link2, AlertCircle, CheckCircle, Info, Clock } from "lucide-react";
import { api } from "../../lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Alert, AlertDescription } from "../ui/alert";
import { Switch } from "../ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

const INTERVAL_OPTIONS = [
  { value: 6, label: "Alle 6 Stunden" },
  { value: 12, label: "Alle 12 Stunden" },
  { value: 24, label: "Täglich" },
  { value: 168, label: "Wöchentlich" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CloudBackupSettings() {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  const status = useQuery({
    queryKey: ["sync", "status"],
    queryFn: () => api.sync.status(),
  });

  const backups = useQuery({
    queryKey: ["sync", "backups"],
    queryFn: () => api.sync.listBackups(),
    enabled: !!status.data?.connected,
  });

  const schedule = useQuery({
    queryKey: ["sync", "schedule"],
    queryFn: () => api.sync.getSchedule(),
    enabled: !!status.data?.connected,
  });

  const setSchedule = useMutation({
    mutationFn: (payload: { enabled?: boolean; intervalHours?: number }) => api.sync.setSchedule(payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sync", "schedule"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const connect = useMutation({
    mutationFn: () => api.sync.connect(apiKey, baseUrl.trim() || undefined),
    onSuccess: () => {
      setApiKey("");
      setError(null);
      setNotice("Verbunden.");
      void qc.invalidateQueries({ queryKey: ["sync"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const disconnect = useMutation({
    mutationFn: () => api.sync.disconnect(),
    onSuccess: () => {
      setNotice(null);
      void qc.invalidateQueries({ queryKey: ["sync"] });
    },
  });

  const createBackup = useMutation({
    mutationFn: () => api.sync.createBackup(),
    onSuccess: () => {
      setError(null);
      setNotice("Backup erstellt und hochgeladen.");
      void qc.invalidateQueries({ queryKey: ["sync", "backups"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const restore = useMutation({
    mutationFn: (backupId?: number) => api.sync.restore(backupId),
    onSuccess: (result) => {
      setError(null);
      setRestartRequired(result.restartRequired);
      setNotice("Wiederherstellung abgeschlossen. Bitte den Agenten jetzt neu starten.");
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cloud-Backup</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Sichert Haupt-DB, Plugin-Daten und Shared-Workspace verschlüsselt via HTTPS auf ducki.cloud (ab Basic-Plan).
          Auth nutzt einen bestehenden API-Key aus /settings/api. Kein Live-Sync — jedes Backup ist ein Snapshot.
        </p>

        {!status.data?.connected ? (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="cloud-api-key">Cloud-API-Key</Label>
              <Input
                id="cloud-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Aus ducki.cloud → Settings → API"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cloud-base-url">Cloud-URL (optional)</Label>
              <Input
                id="cloud-base-url"
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://ducki.cloud"
              />
            </div>
            <Button onClick={() => connect.mutate()} disabled={!apiKey.trim() || connect.isPending}>
              <Link2 className="w-4 h-4 mr-2" />
              {connect.isPending ? "Verbinde..." : "Verbinden"}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 bg-muted rounded-lg text-sm">
              <div>
                <div className="font-medium flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-500" />
                  Verbunden mit {status.data.baseUrl}
                </div>
              </div>
              <Button variant="outline" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                <Unlink className="w-4 h-4 mr-2" />
                Trennen
              </Button>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => createBackup.mutate()} disabled={createBackup.isPending}>
                <CloudUpload className="w-4 h-4 mr-2" />
                {createBackup.isPending ? "Sichere..." : "Jetzt sichern"}
              </Button>
              <Button
                variant="outline"
                onClick={() => restore.mutate(undefined)}
                disabled={restore.isPending || !backups.data?.length}
              >
                <CloudDownload className="w-4 h-4 mr-2" />
                {restore.isPending && restore.variables === undefined ? "Stelle wieder her..." : "Neuestes Backup wiederherstellen"}
              </Button>
            </div>

            <div className="space-y-3 p-3 bg-muted rounded-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <div className="text-sm font-medium">Automatische Backups</div>
                    <div className="text-xs text-muted-foreground">Standardmäßig aus — nichts wird ohne diese Freigabe automatisch hochgeladen.</div>
                  </div>
                </div>
                <Switch
                  checked={!!schedule.data?.enabled}
                  disabled={schedule.isLoading || setSchedule.isPending}
                  onCheckedChange={(checked) => setSchedule.mutate({ enabled: checked })}
                />
              </div>
              {schedule.data?.enabled && (
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Intervall</Label>
                  <Select
                    value={String(schedule.data.intervalHours)}
                    onValueChange={(value) => setSchedule.mutate({ intervalHours: Number(value) })}
                  >
                    <SelectTrigger className="w-48 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INTERVAL_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={String(opt.value)}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {schedule.data?.enabled && schedule.data.lastRunAt && (
                <p className="text-xs text-muted-foreground">
                  Letztes automatisches Backup: {new Date(schedule.data.lastRunAt).toLocaleString()}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Vorhandene Backups</Label>
              {backups.isLoading && <p className="text-xs text-muted-foreground">Lade...</p>}
              {backups.data?.length === 0 && <p className="text-xs text-muted-foreground">Noch keine Backups vorhanden.</p>}
              {backups.data?.map((b) => (
                <div key={b.id} className="flex items-center justify-between text-xs p-2 border border-border rounded">
                  <span>{new Date(b.created_at).toLocaleString()} — {b.device_name ?? "unbekanntes Gerät"}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground">{formatBytes(b.size_bytes)}</span>
                    <button
                      type="button"
                      onClick={() => restore.mutate(b.id)}
                      disabled={restore.isPending}
                      className="text-primary hover:underline disabled:opacity-50"
                    >
                      {restore.isPending && restore.variables === b.id ? "..." : "Wiederherstellen"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {notice && !error && (
          <Alert variant={restartRequired ? "default" : "success"}>
            {restartRequired ? <Info className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
