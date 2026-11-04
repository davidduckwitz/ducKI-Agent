import { Network } from "lucide-react";
import { useVoiceSettings, type VoiceBackdropLabels } from "../../hooks/useVoiceSettings";

const OPTIONS: Array<{ value: VoiceBackdropLabels; label: string; hint: string }> = [
  { value: "none", label: "Nichts", hint: "Nur Punkte und Verbindungen, ganz ohne Text." },
  { value: "titles", label: "Titel", hint: "Einige vorne liegende Notizen zeigen ihren Titel." },
  { value: "titles-notes", label: "Titel & Notizen", hint: "Zusätzlich ein kurzer Ausschnitt aus dem Inhalt der Notiz." },
];

/** Labels of the 3D LLM-wiki backdrop behind the voice tab. */
export function VoiceBackdropSettings() {
  const voiceBackdropLabels = useVoiceSettings((state) => state.voiceBackdropLabels);
  const setVoiceBackdropLabels = useVoiceSettings((state) => state.setVoiceBackdropLabels);
  const active = OPTIONS.find((option) => option.value === voiceBackdropLabels) ?? OPTIONS[1]!;

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <Network className="h-5 w-5" />
        <h3 className="text-base font-semibold">Wissens-Hintergrund im Sprache-Tab</h3>
      </div>

      <div className="space-y-2 pl-7">
        <label className="block text-sm font-medium" htmlFor="voice-backdrop-labels">Beschriftung</label>
        <select
          id="voice-backdrop-labels"
          value={voiceBackdropLabels}
          onChange={(e) => setVoiceBackdropLabels(e.target.value as VoiceBackdropLabels)}
          className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <p className="text-xs text-muted-foreground">
          {active.hint} Der Hintergrund zeigt das LLM-Wiki als 3D-Netz; spricht der Agent, springen Blitze zwischen den Notizen.
        </p>
      </div>
    </section>
  );
}
