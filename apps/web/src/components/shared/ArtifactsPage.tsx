import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Film, Image as ImageIcon, Trash2, ExternalLink, MessageSquare } from "lucide-react";
import { api, type ArtifactInfo } from "../../lib/api";
import { toastManager as toast } from "../../lib/toast";

const SOURCE_LABELS: Record<string, string> = {
  chat_upload: "Chat-Upload",
  voice_app: "Voice-App",
  agent_screenshot: "Screenshot (Agent)",
  agent_document: "Dokument (Agent)",
  discord: "Discord",
};

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(sec: number | null): string {
  if (sec == null) return "";
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function ArtifactIcon({ mimeType }: { mimeType: string | null }) {
  if (mimeType?.startsWith("video/")) return <Film className="h-6 w-6" />;
  if (mimeType?.startsWith("image/")) return <ImageIcon className="h-6 w-6" />;
  return <FileText className="h-6 w-6" />;
}

export function ArtifactsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [selected, setSelected] = useState<ArtifactInfo | null>(null);

  const { data: artifacts, isFetching } = useQuery({
    queryKey: ["artifacts", sourceFilter],
    queryFn: () => api.artifacts.list(sourceFilter ? { source: sourceFilter } : undefined),
  });

  const handleDelete = async (id: number) => {
    if (!confirm("Dieses Artefakt unwiderruflich löschen?")) return;
    try {
      await api.artifacts.delete(id);
      toast.success("Artefakt gelöscht");
      if (selected?.id === id) setSelected(null);
      await qc.invalidateQueries({ queryKey: ["artifacts"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Löschen fehlgeschlagen");
    }
  };

  const sources = Array.from(new Set((artifacts ?? []).map((a) => a.source)));

  return (
    <div className="page space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate("/shared")}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Shared
        </button>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Artefakte</h1>
          <p className="text-sm text-muted-foreground">
            Hochgeladene Dateien, Video-Analysen, Screenshots und Dokumente, die der Agent produziert oder erhalten hat.
          </p>
        </div>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Alle Quellen</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s] ?? s}
            </option>
          ))}
        </select>
      </div>

      {isFetching && !artifacts && <div className="text-sm text-muted-foreground">Lade…</div>}
      {artifacts && artifacts.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Noch keine Artefakte vorhanden.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {(artifacts ?? []).map((artifact) => (
          <button
            key={artifact.id}
            onClick={() => setSelected(artifact)}
            className="flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition hover:border-foreground/25"
          >
            <div className="flex aspect-video items-center justify-center overflow-hidden bg-muted">
              {artifact.thumbnailDataUrl ? (
                <img src={artifact.thumbnailDataUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="text-muted-foreground">
                  <ArtifactIcon mimeType={artifact.mimeType} />
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1 p-2">
              <span className="truncate text-xs font-medium">{artifact.filename}</span>
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5">{SOURCE_LABELS[artifact.source] ?? artifact.source}</span>
                {artifact.durationSec != null && <span>{formatDuration(artifact.durationSec)}</span>}
                {artifact.durationSec == null && <span>{formatBytes(artifact.sizeBytes)}</span>}
              </div>
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setSelected(null)}>
          <div
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <h2 className="text-sm font-semibold">{selected.filename}</h2>
              <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground">
                ✕
              </button>
            </div>

            {selected.thumbnailDataUrl && (
              <img src={selected.thumbnailDataUrl} alt="" className="mb-3 max-h-64 w-full rounded-lg object-contain bg-muted" />
            )}

            <div className="space-y-1.5 text-xs text-muted-foreground">
              <div>Quelle: {SOURCE_LABELS[selected.source] ?? selected.source}</div>
              {selected.platform && <div>Plattform: {selected.platform}</div>}
              {selected.mimeType && <div>Typ: {selected.mimeType}</div>}
              {selected.sizeBytes != null && <div>Größe: {formatBytes(selected.sizeBytes)}</div>}
              {selected.durationSec != null && <div>Dauer: {formatDuration(selected.durationSec)}</div>}
              <div>Erstellt: {new Date(selected.createdAt).toLocaleString("de-DE")}</div>
              {selected.path && <div>Datei: vorhanden ({selected.path})</div>}
              {!selected.path && selected.sourceUrl && <div>Datei: gelöscht (kann vom Agenten neu geladen werden)</div>}
            </div>

            {selected.transcript && (
              <div className="mt-3">
                <div className="mb-1 text-[11px] font-medium text-muted-foreground">Transkript</div>
                <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-muted/50 p-2 text-xs">
                  {selected.transcript}
                </div>
              </div>
            )}

            <div className="mt-4 flex items-center gap-2">
              {selected.sourceUrl && (
                <a
                  href={selected.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 rounded border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
                >
                  <ExternalLink className="h-3 w-3" /> Quelle öffnen
                </a>
              )}
              {selected.conversationId && (
                <button
                  onClick={() => navigate(`/chat?conversationId=${selected.conversationId}`)}
                  className="flex items-center gap-1 rounded border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
                >
                  <MessageSquare className="h-3 w-3" /> Zum Chat
                </button>
              )}
              <button
                onClick={() => handleDelete(selected.id)}
                className="ml-auto flex items-center gap-1 rounded border border-destructive/40 px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3 w-3" /> Löschen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

