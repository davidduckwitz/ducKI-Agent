import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, AlertCircle, Download, Trash2, Loader2, Puzzle } from "lucide-react";
import { api, type ComponentStatus } from "../../lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const SOURCE_LABEL: Record<ComponentStatus["source"], string> = {
  setting: "Eigener Pfad",
  pack: "Installiert (DucKI)",
  bundled: "Im Installer enthalten",
  system: "Im System gefunden (PATH)",
  missing: "Nicht gefunden",
};

const PHASE_LABEL = {
  download: "Lade herunter",
  verify: "Prüfe Prüfsumme",
  extract: "Entpacke",
  done: "Fertig",
} as const;

function ComponentRow({ item, onChanged }: { item: ComponentStatus; onChanged: (list: ComponentStatus[]) => void }) {
  const qc = useQueryClient();
  const [path, setPath] = useState(item.explicitPath ?? "");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["components"] });
  const install = useMutation({
    mutationFn: () => api.components.install(item.id),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });
  const savePath = useMutation({
    mutationFn: () => api.components.setPath(item.id, path.trim()),
    onSuccess: (list) => {
      setError(null);
      onChanged(list);
    },
    onError: (e: Error) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.components.removePack(item.id),
    onSuccess: onChanged,
    onError: (e: Error) => setError(e.message),
  });

  const busy = item.installing || install.isPending;
  const percent = item.installPercent ?? -1;

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium">
            {item.found ? <CheckCircle className="h-4 w-4 text-green-500" /> : <AlertCircle className="h-4 w-4 text-amber-500" />}
            {item.label}
            {item.version && <span className="text-xs font-normal text-muted-foreground">v{item.version}</span>}
          </div>
          <p className="text-sm text-muted-foreground">{item.description}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {item.broken ? "Datei gefunden, lässt sich aber nicht starten" : SOURCE_LABEL[item.source]}
            {item.path ? ` – ${item.path}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {item.installable && (
            <Button size="sm" variant={item.found ? "outline" : "default"} disabled={busy} onClick={() => install.mutate()}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
              {item.found ? "Neu installieren" : `Installieren (~${item.approxSizeMb} MB)`}
            </Button>
          )}
          {item.source === "pack" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove.mutate()} title="Installierte Version entfernen">
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {busy && (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{
                width: percent >= 0 ? `${percent}%` : "100%",
                opacity: percent >= 0 ? 1 : 0.4,
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {item.installPhase ? PHASE_LABEL[item.installPhase] : "Starte…"}
            {percent >= 0 && item.installPhase === "download" ? ` ${percent}%` : ""}
          </p>
        </div>
      )}

      {(error || item.installError) && <p className="text-sm text-destructive">{error ?? item.installError}</p>}

      {item.kind === "binary" && (
        <div className="flex gap-2">
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={`Eigener Pfad zu ${item.label} (optional)`}
            className="h-8 text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={savePath.isPending || path.trim() === (item.explicitPath ?? "")}
            onClick={() => savePath.mutate()}
          >
            Übernehmen
          </Button>
        </div>
      )}
    </div>
  );
}

export function ComponentsSettings() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["components"],
    queryFn: () => api.components.list(),
    // Poll quickly while a download runs so the progress bar moves.
    refetchInterval: (q) => (q.state.data?.some((c) => c.installing) ? 1000 : false),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Puzzle className="h-5 w-5" /> Komponenten
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Optionale Programme und Funktionspakete, die nicht fest im Installer stecken. Bei Programmen nutzt DucKI zuerst einen eigenen
          Pfad, dann die hier installierte Version, dann die mitgelieferte und zuletzt eine systemweite Installation.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading && <p className="text-sm text-muted-foreground">Prüfe Komponenten…</p>}
        {query.error && <p className="text-sm text-destructive">{(query.error as Error).message}</p>}
        {query.data?.map((item) => (
          <ComponentRow key={item.id} item={item} onChanged={(list) => qc.setQueryData(["components"], list)} />
        ))}
      </CardContent>
    </Card>
  );
}
