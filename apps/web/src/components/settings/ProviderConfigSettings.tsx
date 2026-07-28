import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Save, RotateCcw, Download, Upload, AlertCircle, CheckCircle } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";

interface ProviderConfig {
  errorClassifier?: Record<string, unknown>;
  providerRouter?: Record<string, unknown>;
  adapters?: {
    anthropic?: Record<string, unknown>;
    gemini?: Record<string, unknown>;
    bedrock?: Record<string, unknown>;
  };
  enableProviderFallback?: boolean;
  enableAutoRetry?: boolean;
  enableCompression?: boolean;
  debugMode?: boolean;
}

interface FlatSetting {
  [key: string]: unknown;
}

type SettingType = "string" | "number" | "boolean" | "select";

interface SettingField {
  key: string;
  label: string;
  description: string;
  type: SettingType;
  category: string;
  defaultValue: unknown;
  options?: { label: string; value: string }[];
  min?: number;
  max?: number;
}

// Define structured settings for UI
const PROVIDER_CONFIG_FIELDS: SettingField[] = [
  // Error Classifier Settings
  {
    key: "errorClassifier.maxRetryAttempts",
    label: "Max Retry Attempts",
    description: "Maximum number of retry attempts for failed requests",
    type: "number",
    category: "Error Handling",
    defaultValue: 3,
    min: 1,
    max: 10,
  },
  {
    key: "errorClassifier.retryBackoffMs",
    label: "Retry Backoff (ms)",
    description: "Milliseconds to wait between retry attempts",
    type: "number",
    category: "Error Handling",
    defaultValue: 1000,
    min: 100,
    max: 30000,
  },
  {
    key: "errorClassifier.autoCompressOnError",
    label: "Auto Compress on Error",
    description: "Automatically compress context when errors occur",
    type: "boolean",
    category: "Error Handling",
    defaultValue: true,
  },
  {
    key: "errorClassifier.logRetries",
    label: "Log Retries",
    description: "Log retry attempts to console",
    type: "boolean",
    category: "Error Handling",
    defaultValue: true,
  },

  // Provider Router Settings
  {
    key: "providerRouter.failoverEnabled",
    label: "Failover Enabled",
    description: "Enable automatic failover to alternate providers",
    type: "boolean",
    category: "Provider Failover",
    defaultValue: true,
  },
  {
    key: "providerRouter.failoverStrategy",
    label: "Failover Strategy",
    description: "Strategy for selecting failover providers",
    type: "select",
    category: "Provider Failover",
    defaultValue: "intelligent",
    options: [
      { label: "Intelligent (based on health)", value: "intelligent" },
      { label: "Round Robin", value: "round-robin" },
      { label: "Random", value: "random" },
    ],
  },
  {
    key: "providerRouter.maxErrorsPerProvider",
    label: "Max Errors Per Provider",
    description: "Errors before provider is temporarily disabled",
    type: "number",
    category: "Provider Failover",
    defaultValue: 5,
    min: 1,
    max: 100,
  },
  {
    key: "providerRouter.healthCheckInterval",
    label: "Health Check Interval (ms)",
    description: "Milliseconds between provider health checks",
    type: "number",
    category: "Provider Failover",
    defaultValue: 30000,
    min: 5000,
    max: 300000,
  },
  {
    key: "providerRouter.failoverLogging",
    label: "Failover Logging",
    description: "Log failover events to console",
    type: "boolean",
    category: "Provider Failover",
    defaultValue: true,
  },

  // Anthropic Adapter Settings
  {
    key: "adapters.anthropic.timeoutMs",
    label: "Anthropic Timeout (ms)",
    description: "Request timeout for Anthropic API calls",
    type: "number",
    category: "Anthropic Configuration",
    defaultValue: 30000,
    min: 1000,
    max: 300000,
  },
  {
    key: "adapters.anthropic.maxRetries",
    label: "Anthropic Max Retries",
    description: "Maximum retries for Anthropic requests",
    type: "number",
    category: "Anthropic Configuration",
    defaultValue: 3,
    min: 1,
    max: 10,
  },
  {
    key: "adapters.anthropic.enableExtendedThinking",
    label: "Enable Extended Thinking",
    description: "Enable extended thinking mode for Anthropic models",
    type: "boolean",
    category: "Anthropic Configuration",
    defaultValue: false,
  },

  // Gemini Adapter Settings
  {
    key: "adapters.gemini.timeoutMs",
    label: "Gemini Timeout (ms)",
    description: "Request timeout for Gemini API calls",
    type: "number",
    category: "Gemini Configuration",
    defaultValue: 30000,
    min: 1000,
    max: 300000,
  },
  {
    key: "adapters.gemini.maxRetries",
    label: "Gemini Max Retries",
    description: "Maximum retries for Gemini requests",
    type: "number",
    category: "Gemini Configuration",
    defaultValue: 3,
    min: 1,
    max: 10,
  },
  {
    key: "adapters.gemini.safetyThreshold",
    label: "Safety Threshold",
    description: "Content filtering level for Gemini responses",
    type: "select",
    category: "Gemini Configuration",
    defaultValue: "BLOCK_NONE",
    options: [
      { label: "No Blocking", value: "BLOCK_NONE" },
      { label: "Block Low Risk", value: "BLOCK_LOW" },
      { label: "Block Medium Risk", value: "BLOCK_MED" },
      { label: "Block High Risk", value: "BLOCK_HIGH" },
    ],
  },

  // Bedrock Adapter Settings
  {
    key: "adapters.bedrock.timeoutMs",
    label: "Bedrock Timeout (ms)",
    description: "Request timeout for AWS Bedrock API calls",
    type: "number",
    category: "Bedrock Configuration",
    defaultValue: 30000,
    min: 1000,
    max: 300000,
  },
  {
    key: "adapters.bedrock.maxRetries",
    label: "Bedrock Max Retries",
    description: "Maximum retries for Bedrock requests",
    type: "number",
    category: "Bedrock Configuration",
    defaultValue: 3,
    min: 1,
    max: 10,
  },
  {
    key: "adapters.bedrock.region",
    label: "AWS Region",
    description: "AWS region for Bedrock API calls",
    type: "string",
    category: "Bedrock Configuration",
    defaultValue: "us-east-1",
  },

  // Global Flags
  {
    key: "enableProviderFallback",
    label: "Enable Provider Fallback",
    description: "Allow fallback to other providers on failure",
    type: "boolean",
    category: "Global Settings",
    defaultValue: true,
  },
  {
    key: "enableAutoRetry",
    label: "Enable Auto Retry",
    description: "Automatically retry failed requests",
    type: "boolean",
    category: "Global Settings",
    defaultValue: true,
  },
  {
    key: "enableCompression",
    label: "Enable Compression",
    description: "Compress context when approaching token limits",
    type: "boolean",
    category: "Global Settings",
    defaultValue: true,
  },
  {
    key: "debugMode",
    label: "Debug Mode",
    description: "Log detailed debug information",
    type: "boolean",
    category: "Global Settings",
    defaultValue: false,
  },
];

export function ProviderConfigSettings() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(["Error Handling", "Provider Failover", "Global Settings"])
  );

  // Fetch flat settings
  const { data: settings = {}, isLoading } = useQuery({
    queryKey: ["provider-config"],
    queryFn: async () => {
      const response = await fetch("/api/settings/agent-provider/flat");
      if (!response.ok) throw new Error("Failed to fetch provider config");
      const json = await response.json();
      return json.data || {};
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  // Mutation for updating a single setting
  const updateSetting = useMutation({
    mutationFn: async (payload: { path: string; value: unknown }) => {
      const response = await fetch("/api/settings/agent-provider", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("Failed to update setting");
      return response.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["provider-config"] });
      setMessage({ type: "success", text: "Setting updated successfully" });
      setTimeout(() => setMessage(null), 3000);
    },
    onError: (error) => {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to update setting",
      });
    },
  });

  // Mutation for resetting all settings
  const resetSettings = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/settings/agent-provider", {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to reset settings");
      return response.json();
    },
    onSuccess: () => {
      setEdits({});
      qc.invalidateQueries({ queryKey: ["provider-config"] });
      setMessage({ type: "success", text: "Settings reset to defaults" });
      setTimeout(() => setMessage(null), 3000);
    },
    onError: (error) => {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to reset settings",
      });
    },
  });

  // Mutation for exporting settings
  const exportSettings = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/settings/agent-provider/export", {
        method: "POST",
      });
      if (!response.ok) throw new Error("Failed to export settings");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `provider-settings-${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      setMessage({ type: "success", text: "Settings exported successfully" });
      setTimeout(() => setMessage(null), 3000);
    },
    onError: (error) => {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to export settings",
      });
    },
  });

  const handleChange = (key: string, value: unknown) => {
    setEdits((prev) => ({ ...prev, [key]: value }));
  };

  const handleSaveField = (key: string) => {
    const editValue = edits[key];
    const value = editValue !== undefined ? editValue : settings[key];
    updateSetting.mutate({ path: key, value });
    setEdits((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const getDisplayValue = (field: SettingField): unknown => {
    return edits[field.key] !== undefined ? edits[field.key] : (settings[field.key] ?? field.defaultValue);
  };

  if (isLoading) {
    return <div className="text-center py-8">Loading provider configuration...</div>;
  }

  const categories = Array.from(new Set(PROVIDER_CONFIG_FIELDS.map((f) => f.category)));

  return (
    <div className="space-y-4">
      {/* Header with Actions */}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-bold">LLM Provider Configuration</h2>
        <div className="flex gap-2">
          <button
            onClick={() => exportSettings.mutate(undefined)}
            className="btn-secondary flex items-center gap-2"
            disabled={exportSettings.isPending}
          >
            <Download className="w-4 h-4" />
            Export
          </button>
          <button
            onClick={() => resetSettings.mutate(undefined)}
            className="btn-secondary flex items-center gap-2"
            disabled={resetSettings.isPending}
          >
            <RotateCcw className="w-4 h-4" />
            Reset
          </button>
        </div>
      </div>

      {/* Message Alert */}
      {message && (
        <div
          className={cn(
            "card flex items-center gap-3 p-4",
            message.type === "success" ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
          )}
        >
          {message.type === "success" ? (
            <CheckCircle className="w-5 h-5 text-green-600" />
          ) : (
            <AlertCircle className="w-5 h-5 text-red-600" />
          )}
          <span className={message.type === "success" ? "text-green-700" : "text-red-700"}>{message.text}</span>
        </div>
      )}

      {/* Settings by Category */}
      {categories.map((category) => {
        const fieldsInCategory = PROVIDER_CONFIG_FIELDS.filter((f) => f.category === category);
        const isExpanded = expandedCategories.has(category);

        return (
          <div key={category} className="card">
            <button
              onClick={() => toggleCategory(category)}
              className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
            >
              <h3 className="font-semibold">{category}</h3>
              <svg
                className={cn("w-5 h-5 transition-transform", isExpanded && "rotate-180")}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </button>

            {isExpanded && (
              <div className="border-t border-border space-y-4 p-4">
                {fieldsInCategory.map((field) => {
                  const value = getDisplayValue(field);
                  const isDirty = edits[field.key] !== undefined;

                  return (
                    <div key={field.key} className="space-y-2">
                      <label className="text-sm font-medium">{field.label}</label>
                      <p className="text-xs text-muted-foreground">{field.description}</p>

                      {field.type === "boolean" ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={Boolean(value)}
                            onChange={(e) => handleChange(field.key, e.target.checked)}
                            className="w-4 h-4"
                          />
                          <span className="text-sm">{value ? "Enabled" : "Disabled"}</span>
                        </div>
                      ) : field.type === "select" ? (
                        <select
                          value={String(value)}
                          onChange={(e) => handleChange(field.key, e.target.value)}
                          className="w-full px-3 py-2 border border-border rounded bg-background text-foreground"
                        >
                          {field.options?.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      ) : field.type === "number" ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            value={Number(value)}
                            onChange={(e) => handleChange(field.key, e.target.valueAsNumber)}
                            min={field.min}
                            max={field.max}
                            className="flex-1 px-3 py-2 border border-border rounded bg-background text-foreground"
                          />
                          {isDirty && (
                            <button
                              onClick={() => handleSaveField(field.key)}
                              className="btn-primary px-3 py-2 flex items-center gap-1"
                              disabled={updateSetting.isPending}
                            >
                              <Save className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={String(value)}
                            onChange={(e) => handleChange(field.key, e.target.value)}
                            className="flex-1 px-3 py-2 border border-border rounded bg-background text-foreground"
                          />
                          {isDirty && (
                            <button
                              onClick={() => handleSaveField(field.key)}
                              className="btn-primary px-3 py-2 flex items-center gap-1"
                              disabled={updateSetting.isPending}
                            >
                              <Save className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
