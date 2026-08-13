/**
 * Pet settings
 *
 * Lives in the "Character" settings tab: pick the pet that walks around the app
 * window, tune how it behaves, preview its states and import sprite-sheet pets.
 */

import { useState } from "react";
import { Hand, ImagePlus, MousePointer2, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { usePetStore, type LocomotionMode } from "../../lib/petStore";
import { BUILT_IN_PETS } from "../pet/petRegistry";
import { getPetById } from "../pet/petRegistry";
import { usePluginPets } from "../pet/usePluginPets";
import { PetView } from "../pet/PetView";
import { SpriteSheetImporter } from "../pet/SpriteSheetImporter";
import type { PetStateId } from "../pet/petTypes";
import "../pet/pet.css";

const PREVIEW_STATES: PetStateId[] = ["idle", "walk", "run", "fly", "jump", "wave", "work", "fail", "sleep", "drag"];

export function PetSettingsPanel() {
  const { t } = useI18n();

  const enabled = usePetStore((s) => s.enabled);
  const petId = usePetStore((s) => s.petId);
  const size = usePetStore((s) => s.size);
  const speed = usePetStore((s) => s.speed);
  const opacity = usePetStore((s) => s.opacity);
  const followCursor = usePetStore((s) => s.followCursor);
  const reactToEvents = usePetStore((s) => s.reactToEvents);
  const showBubbles = usePetStore((s) => s.showBubbles);
  const notifications = usePetStore((s) => s.notifications);
  const locomotion = usePetStore((s) => s.locomotion);
  const groundOffset = usePetStore((s) => s.groundOffset);
  const customPets = usePetStore((s) => s.customPets);

  const setEnabled = usePetStore((s) => s.setEnabled);
  const setPetId = usePetStore((s) => s.setPetId);
  const patchSettings = usePetStore((s) => s.patchSettings);
  const removeCustomPet = usePetStore((s) => s.removeCustomPet);
  const trigger = usePetStore((s) => s.trigger);
  const resetSettings = usePetStore((s) => s.resetSettings);

  const [previewState, setPreviewState] = useState<PetStateId>("idle");
  const [showImporter, setShowImporter] = useState(false);

  const pluginPets = usePluginPets();
  const activePet = getPetById(petId, [...pluginPets, ...customPets]);
  const allPets = [...BUILT_IN_PETS, ...pluginPets, ...customPets];

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------- header */}
      <div className="rounded-lg border border-border bg-card/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4" />
              {t("pet.title")}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">{t("pet.subtitle")}</p>
          </div>
          <ToggleButton
            active={enabled}
            onChange={setEnabled}
            labelOn={t("pet.enabled")}
            labelOff={t("pet.disabled")}
          />
        </div>

        {/* Live preview of the selected pet in a state the user can scrub through. */}
        <div className="mt-4 grid gap-3 sm:grid-cols-[10rem_1fr]">
          <div className="pet-checker flex h-32 items-center justify-center rounded-lg border border-border">
            <div style={{ opacity }}>
              <PetView pet={activePet} state={previewState} size={Math.min(110, Math.max(48, size))} />
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t("pet.previewHint")}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PREVIEW_STATES.map((state) => (
                <button
                  key={state}
                  type="button"
                  onClick={() => setPreviewState(state)}
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
                    previewState === state
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/40"
                  }`}
                >
                  {t(`pet.state.${state}`)}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => trigger("wave")} className="btn-secondary py-1.5 text-xs">
                <Hand className="mr-1 inline h-3 w-3" />
                {t("pet.action.wave")}
              </button>
              <button type="button" onClick={() => trigger("jump")} className="btn-secondary py-1.5 text-xs">
                {t("pet.action.jump")}
              </button>
              <button type="button" onClick={() => trigger("reset")} className="btn-secondary py-1.5 text-xs">
                <RotateCcw className="mr-1 inline h-3 w-3" />
                {t("pet.action.resetPosition")}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------ gallery */}
      <div className="rounded-lg border border-border bg-card/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t("pet.gallery")}</h3>
          <button
            type="button"
            onClick={() => setShowImporter((v) => !v)}
            className="btn-secondary py-1.5 text-xs"
          >
            <ImagePlus className="mr-1 inline h-3 w-3" />
            {t("pet.import.button")}
          </button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {allPets.map((pet) => {
            const active = pet.id === petId;
            return (
              <div
                key={pet.id}
                className={`relative rounded-lg border p-3 transition ${
                  active ? "border-primary bg-primary/10" : "border-border bg-card/50 hover:border-foreground/30"
                }`}
              >
                <button type="button" onClick={() => setPetId(pet.id)} className="flex w-full items-center gap-3 text-left">
                  <div className="pet-checker flex h-16 w-16 shrink-0 items-center justify-center rounded border border-border">
                    <PetView pet={pet} state={active ? "walk" : "idle"} size={52} />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {pet.emoji} {pet.name}
                    </p>
                    <p className="line-clamp-2 text-[11px] text-muted-foreground">{pet.description}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      {t(`pet.locomotion.${pet.locomotion}`)}
                      {pet.builtIn ? "" : pet.source === "plugin" ? " – Plugin" : ` - ${t("pet.custom")}`}
                    </p>
                  </div>
                </button>

                {!pet.builtIn && pet.source !== "plugin" && (
                  <button
                    type="button"
                    onClick={() => removeCustomPet(pet.id)}
                    title={t("pet.deleteCustom")}
                    className="absolute right-2 top-2 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {showImporter && (
          <div className="mt-3">
            <SpriteSheetImporter onClose={() => setShowImporter(false)} />
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------- behaviour */}
      <div className="rounded-lg border border-border bg-card/40 p-4 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <MousePointer2 className="h-4 w-4" />
          {t("pet.behaviour")}
        </h3>

        <SliderRow
          label={`${t("pet.size")}: ${size}px`}
          min={24}
          max={160}
          step={4}
          value={size}
          onChange={(value) => patchSettings({ size: value })}
        />
        <SliderRow
          label={`${t("pet.speed")}: ${speed.toFixed(1)}x`}
          min={0.3}
          max={2.5}
          step={0.1}
          value={speed}
          onChange={(value) => patchSettings({ speed: value })}
        />
        <SliderRow
          label={`${t("pet.opacity")}: ${Math.round(opacity * 100)}%`}
          min={0.2}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(value) => patchSettings({ opacity: value })}
        />
        <SliderRow
          label={`${t("pet.groundOffset")}: ${groundOffset}px`}
          min={0}
          max={160}
          step={4}
          value={groundOffset}
          onChange={(value) => patchSettings({ groundOffset: value })}
        />

        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">{t("pet.movement")}</p>
          <div className="flex flex-wrap gap-2">
            {(["auto", "ground", "air"] as LocomotionMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => patchSettings({ locomotion: mode })}
                className={`rounded-lg border px-3 py-1.5 text-xs transition ${
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

        <div className="space-y-2">
          <CheckRow
            checked={followCursor}
            onChange={(value) => patchSettings({ followCursor: value })}
            label={t("pet.followCursor")}
            hint={t("pet.followCursorHint")}
          />
          <CheckRow
            checked={reactToEvents}
            onChange={(value) => patchSettings({ reactToEvents: value })}
            label={t("pet.reactToEvents")}
            hint={t("pet.reactToEventsHint")}
          />
          <CheckRow
            checked={showBubbles}
            onChange={(value) => patchSettings({ showBubbles: value })}
            label={t("pet.showBubbles")}
            hint={t("pet.showBubblesHint")}
          />
          <CheckRow
            checked={notifications}
            onChange={(value) => patchSettings({ notifications: value })}
            label={t("pet.notifications")}
            hint={t("pet.notificationsHint")}
          />
        </div>

        <div className="flex justify-between border-t border-border pt-3">
          <p className="text-[11px] text-muted-foreground">{t("pet.interactionHint")}</p>
          <button type="button" onClick={resetSettings} className="btn-secondary py-1.5 text-xs">
            {t("pet.resetSettings")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ToggleButton({
  active,
  onChange,
  labelOn,
  labelOff,
}: {
  active: boolean;
  onChange: (value: boolean) => void;
  labelOn: string;
  labelOff: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!active)}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition ${
        active ? "border-green-500/60 bg-green-500/10 text-green-400" : "border-border text-muted-foreground"
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${active ? "bg-green-400" : "bg-muted-foreground"}`} />
      {active ? labelOn : labelOff}
    </button>
  );
}

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary"
      />
    </div>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card/40 p-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 accent-primary"
      />
      <span>
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
