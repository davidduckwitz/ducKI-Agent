/**
 * Sprite Sheet Importer
 *
 * Turns a sprite sheet image into a pet: the user says how the sheet is gridded
 * (columns x rows), maps rows onto engine states, and checks the result in the
 * state viewer before saving. The image is stored as a data URL in the pet store,
 * so imported pets survive reloads without a backend round-trip.
 */

import { useMemo, useRef, useState } from "react";
import { Upload, Play, Save, X, AlertTriangle } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { usePetStore, type LocomotionMode } from "../../lib/petStore";
import { SPRITE_IMPORT_DEFAULT_ORDER } from "./petRegistry";
import { SpritePet } from "./PetView";
import { PET_STATES, type PetDefinition, type PetStateId, type SpriteSheetConfig } from "./petTypes";

/** Data URLs live in localStorage - keep sheets small enough to fit the ~5MB budget. */
const SHEET_SIZE_WARN_BYTES = 2_000_000;

interface SheetDraft {
  src: string;
  fileName: string;
  width: number;
  height: number;
  bytes: number;
}

interface StateMapping {
  enabled: boolean;
  row: number;
  frames: number;
  loop: boolean;
}

type MappingTable = Record<PetStateId, StateMapping>;

function buildInitialMapping(rows: number, columns: number): MappingTable {
  const table = {} as MappingTable;
  for (const state of PET_STATES) {
    const suggestedRow = SPRITE_IMPORT_DEFAULT_ORDER.indexOf(state);
    const usable = suggestedRow >= 0 && suggestedRow < rows;
    table[state] = {
      enabled: usable,
      row: usable ? suggestedRow : 0,
      frames: columns,
      loop: state !== "jump" && state !== "wave",
    };
  }
  return table;
}

interface SpriteSheetImporterProps {
  onClose: () => void;
}

export function SpriteSheetImporter({ onClose }: SpriteSheetImporterProps) {
  const { t } = useI18n();
  const addCustomPet = usePetStore((s) => s.addCustomPet);
  const setPetId = usePetStore((s) => s.setPetId);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<SheetDraft | null>(null);
  const [name, setName] = useState("");
  const [columns, setColumns] = useState(8);
  const [rows, setRows] = useState(9);
  const [fps, setFps] = useState(8);
  const [locomotion, setLocomotion] = useState<Exclude<LocomotionMode, "auto">>("ground");
  const [mapping, setMapping] = useState<MappingTable>(() => buildInitialMapping(9, 8));
  const [previewState, setPreviewState] = useState<PetStateId>("idle");
  const [error, setError] = useState<string | null>(null);

  const frameWidth = draft ? Math.max(1, Math.floor(draft.width / Math.max(1, columns))) : 0;
  const frameHeight = draft ? Math.max(1, Math.floor(draft.height / Math.max(1, rows))) : 0;

  const sheet = useMemo<SpriteSheetConfig | null>(() => {
    if (!draft) return null;
    const states: SpriteSheetConfig["states"] = {};
    for (const state of PET_STATES) {
      const entry = mapping[state];
      if (!entry.enabled) continue;
      states[state] = {
        row: entry.row,
        frames: Math.max(1, entry.frames),
        loop: entry.loop,
      };
    }
    return {
      src: draft.src,
      frameWidth,
      frameHeight,
      fps,
      sheetWidth: draft.width,
      sheetHeight: draft.height,
      states,
    };
  }, [draft, mapping, frameWidth, frameHeight, fps]);

  const mappedStates = PET_STATES.filter((state) => mapping[state].enabled);

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    setError(null);

    const reader = new FileReader();
    reader.onerror = () => setError(t("pet.import.readError"));
    reader.onload = () => {
      const src = String(reader.result ?? "");
      const image = new Image();
      image.onerror = () => setError(t("pet.import.readError"));
      image.onload = () => {
        setDraft({
          src,
          fileName: file.name,
          width: image.naturalWidth,
          height: image.naturalHeight,
          bytes: src.length,
        });
        if (!name) setName(file.name.replace(/\.[^.]+$/, ""));
      };
      image.src = src;
    };
    reader.readAsDataURL(file);
  };

  const updateMapping = (state: PetStateId, patch: Partial<StateMapping>) => {
    setMapping((current) => ({ ...current, [state]: { ...current[state], ...patch } }));
  };

  const handleSave = () => {
    if (!sheet || !draft) return;
    if (mappedStates.length === 0) {
      setError(t("pet.import.noStates"));
      return;
    }

    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "sprite";
    const pet: PetDefinition = {
      id: `custom-${slug}-${Date.now().toString(36)}`,
      name: name.trim() || draft.fileName,
      description: t("pet.import.customDescription"),
      emoji: "🖼️",
      locomotion,
      kind: "sprite",
      sheet,
      builtIn: false,
    };

    addCustomPet(pet);
    setPetId(pet.id);
    onClose();
  };

  return (
    <div className="rounded-lg border border-border bg-card/60 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">{t("pet.import.title")}</h4>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="w-4 h-4" />
        </button>
      </div>

      <p className="text-xs text-muted-foreground">{t("pet.import.hint")}</p>

      {/* ---------------------------------------------------------------- file */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/gif,image/webp,image/jpeg"
          className="hidden"
          onChange={(event) => handleFile(event.target.files?.[0])}
        />
        <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-secondary text-xs py-1.5">
          <Upload className="w-3 h-3 inline mr-1" />
          {t("pet.import.chooseFile")}
        </button>
        {draft && (
          <span className="text-xs text-muted-foreground">
            {draft.fileName} - {draft.width}x{draft.height}px
          </span>
        )}
      </div>

      {draft && draft.bytes > SHEET_SIZE_WARN_BYTES && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{t("pet.import.sizeWarning")}</span>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {draft && sheet && (
        <>
          {/* ------------------------------------------------------------ grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="text-xs">
              <span className="block text-muted-foreground mb-1">{t("pet.import.name")}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className="input w-full text-xs" />
            </label>
            <label className="text-xs">
              <span className="block text-muted-foreground mb-1">{t("pet.import.columns")}</span>
              <input
                type="number"
                min={1}
                max={64}
                value={columns}
                onChange={(e) => {
                  const next = Math.max(1, Number(e.target.value) || 1);
                  setColumns(next);
                  setMapping(buildInitialMapping(rows, next));
                }}
                className="input w-full text-xs"
              />
            </label>
            <label className="text-xs">
              <span className="block text-muted-foreground mb-1">{t("pet.import.rows")}</span>
              <input
                type="number"
                min={1}
                max={64}
                value={rows}
                onChange={(e) => {
                  const next = Math.max(1, Number(e.target.value) || 1);
                  setRows(next);
                  setMapping(buildInitialMapping(next, columns));
                }}
                className="input w-full text-xs"
              />
            </label>
            <label className="text-xs">
              <span className="block text-muted-foreground mb-1">{t("pet.import.fps")}</span>
              <input
                type="number"
                min={1}
                max={60}
                value={fps}
                onChange={(e) => setFps(Math.max(1, Number(e.target.value) || 1))}
                className="input w-full text-xs"
              />
            </label>
          </div>

          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">
              {t("pet.import.frameSize")}: {frameWidth}x{frameHeight}px
            </span>
            <div className="flex items-center gap-2">
              {(["ground", "air"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setLocomotion(mode)}
                  className={`px-2 py-1 rounded border text-xs transition ${
                    locomotion === mode
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/40"
                  }`}
                >
                  {t(`pet.locomotion.${mode}`)}
                </button>
              ))}
            </div>
          </div>

          {/* --------------------------------------------------- state viewer */}
          <div className="grid gap-3 lg:grid-cols-[minmax(0,22rem)_1fr]">
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                    {t("pet.import.stateViewer")}
                  </p>
                  <h5 className="text-lg font-semibold">{t(`pet.state.${previewState}`)}</h5>
                </div>
                <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                  <Play className="w-3 h-3" />
                  {mapping[previewState].frames} {t("pet.import.frames")}
                </span>
              </div>

              <div className="pet-checker mt-3 flex h-40 items-center justify-center rounded-lg border border-border">
                <SpritePet sheet={sheet} state={previewState} size={128} />
              </div>

              <p className="mt-2 text-xs text-muted-foreground">{t(`pet.stateHint.${previewState}`)}</p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 content-start">
              {PET_STATES.map((state) => {
                const entry = mapping[state];
                const active = previewState === state;
                return (
                  <button
                    key={state}
                    type="button"
                    onClick={() => setPreviewState(state)}
                    className={`flex items-center justify-between gap-2 rounded-lg border p-2 text-left transition ${
                      active ? "border-primary bg-primary/10" : "border-border bg-card/50 hover:border-foreground/30"
                    } ${entry.enabled ? "" : "opacity-50"}`}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold">{t(`pet.state.${state}`)}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {entry.enabled
                          ? `${t("pet.import.row")} ${entry.row} - ${entry.frames} ${t("pet.import.frames")}`
                          : t("pet.import.unmapped")}
                      </p>
                    </div>
                    <div className="pet-checker flex h-12 w-12 shrink-0 items-center justify-center rounded border border-border">
                      {entry.enabled && <SpritePet sheet={sheet} state={state} size={44} animate={active} />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ------------------------------------------------- mapping editor */}
          <div className="rounded-lg border border-border">
            <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 border-b border-border px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground">
              <span>{t("pet.import.state")}</span>
              <span>{t("pet.import.use")}</span>
              <span>{t("pet.import.row")}</span>
              <span>{t("pet.import.frames")}</span>
              <span>{t("pet.import.loop")}</span>
            </div>
            <div className="max-h-56 overflow-y-auto">
              {PET_STATES.map((state) => {
                const entry = mapping[state];
                return (
                  <div
                    key={state}
                    className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs last:border-0"
                  >
                    <button
                      type="button"
                      onClick={() => setPreviewState(state)}
                      className="truncate text-left hover:text-primary"
                    >
                      {t(`pet.state.${state}`)}
                    </button>
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      onChange={(e) => updateMapping(state, { enabled: e.target.checked })}
                      className="accent-primary"
                    />
                    <input
                      type="number"
                      min={0}
                      max={rows - 1}
                      value={entry.row}
                      onChange={(e) =>
                        updateMapping(state, { row: Math.min(rows - 1, Math.max(0, Number(e.target.value) || 0)) })
                      }
                      className="input w-14 px-1 py-0.5 text-xs"
                    />
                    <input
                      type="number"
                      min={1}
                      max={columns}
                      value={entry.frames}
                      onChange={(e) =>
                        updateMapping(state, { frames: Math.min(columns, Math.max(1, Number(e.target.value) || 1)) })
                      }
                      className="input w-14 px-1 py-0.5 text-xs"
                    />
                    <input
                      type="checkbox"
                      checked={entry.loop}
                      onChange={(e) => updateMapping(state, { loop: e.target.checked })}
                      className="accent-primary"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-secondary text-xs py-1.5">
              {t("common.cancel")}
            </button>
            <button type="button" onClick={handleSave} className="btn-primary text-xs py-1.5">
              <Save className="w-3 h-3 inline mr-1" />
              {t("pet.import.save")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
