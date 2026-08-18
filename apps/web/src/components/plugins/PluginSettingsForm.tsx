import type { PluginSettingSpec } from "../../lib/api";

/**
 * Generic PluginSettingSpec[] -> form renderer. Shared between any surface that needs to render
 * a plugin's declared settings inline (as opposed to the settingsPage iframe mechanism):
 * currently the Setup Wizard's "Connectors" step (SetupWizardModal.tsx), built for the connector
 * plugins introduced by docs/gateway-connector-plugin-plan.md so a connector plugin's settings
 * form only has to be written once, not once per surface.
 *
 * Values are plain strings keyed by setting key - booleans are the strings "true"/"false",
 * numbers are their string form. The caller owns state; this component is fully controlled.
 */
export interface PluginSettingsFormProps {
  specs: PluginSettingSpec[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Keys that already have a stored secret value server-side (masked "***" in the API response).
   *  Rendered as a placeholder hint instead of the actual value, which is never sent to the client. */
  maskedKeys?: Set<string>;
  disabled?: boolean;
}

export function PluginSettingsForm({ specs, values, onChange, maskedKeys, disabled }: PluginSettingsFormProps) {
  if (specs.length === 0) {
    return <p className="text-xs text-gray-500">Dieses Plugin hat keine konfigurierbaren Einstellungen.</p>;
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {specs.map((spec) => {
        const isMasked = maskedKeys?.has(spec.key);
        const label = spec.description || spec.key;
        if (spec.type === "boolean") {
          return (
            <label key={spec.key} className="flex items-center gap-2 text-xs text-gray-300 md:col-span-2">
              <input
                type="checkbox"
                checked={values[spec.key] === "true"}
                onChange={(e) => onChange(spec.key, String(e.target.checked))}
                disabled={disabled}
              />
              {label}
              {spec.required ? <span className="text-amber-400">*</span> : null}
            </label>
          );
        }
        if (spec.type === "select" && spec.options && spec.options.length > 0) {
          return (
            <label key={spec.key} className="space-y-1 text-xs text-gray-400">
              <span>{label}{spec.required ? <span className="text-amber-400"> *</span> : null}</span>
              <select
                className="input w-full"
                value={values[spec.key] ?? ""}
                onChange={(e) => onChange(spec.key, e.target.value)}
                disabled={disabled}
              >
                <option value="">-</option>
                {spec.options.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
          );
        }
        return (
          <label key={spec.key} className="space-y-1 text-xs text-gray-400">
            <span>{label}{spec.required ? <span className="text-amber-400"> *</span> : null}</span>
            <input
              className="input w-full"
              type={spec.type === "secret" ? "password" : spec.type === "number" ? "number" : "text"}
              value={values[spec.key] ?? ""}
              onChange={(e) => onChange(spec.key, e.target.value)}
              placeholder={isMasked ? "•••• (gesetzt - leer lassen = unveraendert)" : spec.type === "secret" ? "••••" : spec.key}
              disabled={disabled}
            />
          </label>
        );
      })}
    </div>
  );
}
