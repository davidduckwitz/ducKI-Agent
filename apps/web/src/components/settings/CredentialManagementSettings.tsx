import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Trash2, Plus, RotateCcw, AlertCircle, CheckCircle, Key, Lock } from "lucide-react";
import { cn } from "../../lib/utils";

interface Credential {
  id: string;
  provider: string;
  displayName: string;
  isActive: boolean;
  createdAt: number;
  lastUsedAt?: number;
  successCount: number;
  failureCount: number;
  maskedKey: string;
}

interface RotationStatus {
  activeCredentialId: string | null;
  totalCredentials: number;
  lastRotation: number | null;
  canRotate: boolean;
}

interface RotationConfig {
  enabled: boolean;
  maxFailuresBeforeRotation: number;
  minTimeBetweenRotations: number;
  maxCredentialsPerProvider: number;
  rotateOnUnauthorized: boolean;
  rotateOnBillingError: boolean;
  retryAfterRotation: boolean;
}

const VALID_PROVIDERS = ["anthropic", "gemini", "bedrock", "openai", "openrouter", "lmstudio", "ollama"];

export function CredentialManagementSettings() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string>("anthropic");
  const [credentialId, setCredentialId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Fetch all credentials
  const { data: credentials = [], isLoading: isLoadingCredentials, error: credentialsError } = useQuery({
    queryKey: ["credentials"],
    queryFn: async () => {
      const response = await fetch("/api/credentials");
      if (!response.ok) throw new Error("Failed to fetch credentials");
      const json = await response.json();
      return (json.data || []) as Credential[];
    },
    staleTime: 0,
    refetchOnMount: true,
    retry: 1,
  });

  // Fetch rotation config
  const { data: rotationConfig, isLoading: isLoadingConfig } = useQuery({
    queryKey: ["rotation-config"],
    queryFn: async () => {
      const response = await fetch("/api/credentials/rotation-config");
      if (!response.ok) throw new Error("Failed to fetch rotation config");
      const json = await response.json();
      return (json.data || {}) as RotationConfig;
    },
    retry: 1,
  });

  // Register new credential
  const registerCredential = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          credentialId,
          apiKey,
          displayName,
        }),
      });
      if (!response.ok) throw new Error("Failed to register credential");
      return response.json();
    },
    onSuccess: () => {
      setCredentialId("");
      setApiKey("");
      setDisplayName("");
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ["credentials"] });
      setMessage({ type: "success", text: "Credential registered successfully" });
      setTimeout(() => setMessage(null), 3000);
    },
    onError: (error) => {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to register credential",
      });
    },
  });

  // Delete credential
  const deleteCredential = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/credentials/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to delete credential");
      return response.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["credentials"] });
      setMessage({ type: "success", text: "Credential deleted successfully" });
      setTimeout(() => setMessage(null), 3000);
    },
    onError: (error) => {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to delete credential",
      });
    },
  });

  // Rotate credential
  const rotateCredential = useMutation({
    mutationFn: async (provider: string) => {
      const response = await fetch(`/api/credentials/rotate/${provider}`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Failed to rotate credential");
      return response.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["credentials"] });
      setMessage({
        type: "success",
        text: data.data?.message || "Credential rotated successfully",
      });
      setTimeout(() => setMessage(null), 3000);
    },
    onError: (error) => {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to rotate credential",
      });
    },
  });

  // Group credentials by provider
  const credentialsByProvider = credentials.reduce(
    (acc, cred) => {
      if (!acc[cred.provider]) acc[cred.provider] = [];
      acc[cred.provider]!.push(cred);
      return acc;
    },
    {} as Record<string, Credential[]>
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!credentialId.trim() || !apiKey.trim() || !displayName.trim()) {
      setMessage({ type: "error", text: "All fields are required" });
      return;
    }
    if (apiKey.length < 10) {
      setMessage({ type: "error", text: "API key seems too short" });
      return;
    }
    registerCredential.mutate();
  };

  // Show loading state
  if (isLoadingCredentials || isLoadingConfig) {
    return (
      <div className="card p-8 text-center">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        <p className="mt-4 text-muted-foreground">Loading credentials...</p>
      </div>
    );
  }

  // Show error state
  if (credentialsError) {
    return (
      <div className="card p-8">
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded">
          <AlertCircle className="w-5 h-5 text-red-600" />
          <div>
            <p className="font-medium text-red-900">Failed to load credentials</p>
            <p className="text-sm text-red-700 mt-1">
              {credentialsError instanceof Error ? credentialsError.message : "Unknown error"}
            </p>
            <p className="text-xs text-red-600 mt-2">Make sure the server is running and the API is accessible at /api/credentials</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Lock className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold">API Credential Management</h2>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="btn-primary flex items-center gap-2"
          disabled={registerCredential.isPending}
        >
          <Plus className="w-4 h-4" />
          Add Credential
        </button>
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

      {/* Register Form */}
      {showForm && (
        <div className="card space-y-4 p-4 bg-muted/30">
          <h3 className="font-semibold">Register New Credential</h3>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-sm font-medium">Provider</label>
              <select
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded bg-background text-foreground mt-1"
              >
                {VALID_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium">Credential ID</label>
              <input
                type="text"
                value={credentialId}
                onChange={(e) => setCredentialId(e.target.value)}
                placeholder="e.g., anthropic-prod-key-1"
                className="w-full px-3 py-2 border border-border rounded bg-background text-foreground mt-1"
              />
            </div>

            <div>
              <label className="text-sm font-medium">Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g., Production Key - 2026"
                className="w-full px-3 py-2 border border-border rounded bg-background text-foreground mt-1"
              />
            </div>

            <div>
              <label className="text-sm font-medium">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste your API key here"
                className="w-full px-3 py-2 border border-border rounded bg-background text-foreground mt-1 font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground mt-1">Your key is stored securely in the database.</p>
            </div>

            <div className="flex gap-2 pt-2">
              <button type="submit" className="btn-primary flex-1" disabled={registerCredential.isPending}>
                {registerCredential.isPending ? "Registering..." : "Register"}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="btn-secondary flex-1"
                disabled={registerCredential.isPending}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Credentials by Provider */}
      {Object.keys(credentialsByProvider).length === 0 ? (
        <div className="card p-8 text-center">
          <Key className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
          <p className="text-muted-foreground">No credentials registered yet.</p>
          <p className="text-sm text-muted-foreground">Add one to get started with multi-provider support.</p>
        </div>
      ) : (
        Object.entries(credentialsByProvider).map(([provider, creds]) => (
          <div key={provider} className="card space-y-3">
            <div className="flex items-center justify-between p-3 border-b border-border">
              <h3 className="font-semibold capitalize">{provider} Credentials</h3>
              <button
                onClick={() => rotateCredential.mutate(provider)}
                disabled={rotateCredential.isPending}
                className="btn-secondary text-xs px-2 py-1 flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" />
                Rotate
              </button>
            </div>

            <div className="space-y-2 p-3">
              {creds.map((cred) => (
                <div key={cred.id} className="flex items-start justify-between gap-3 p-3 bg-muted/40 rounded border border-border">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm truncate">{cred.displayName}</p>
                      {cred.isActive && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">Active</span>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Key: {cred.maskedKey}</p>
                    <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
                      <span>✓ {cred.successCount} successes</span>
                      <span>✗ {cred.failureCount} failures</span>
                      {cred.lastUsedAt && (
                        <span>Last used: {new Date(cred.lastUsedAt).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteCredential.mutate(cred.id)}
                    disabled={deleteCredential.isPending || cred.isActive}
                    className="btn-secondary text-xs px-2 py-1 flex items-center gap-1"
                    title={cred.isActive ? "Cannot delete active credential" : "Delete credential"}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {/* Rotation Configuration */}
      {rotationConfig && (
        <div className="card space-y-3">
          <h3 className="font-semibold">Rotation Configuration</h3>
          <div className="grid grid-cols-2 gap-4 p-3 bg-muted/30 rounded">
            <div>
              <p className="text-xs text-muted-foreground">Status</p>
              <p className="font-medium">{rotationConfig.enabled ? "Enabled" : "Disabled"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Max Failures Before Rotation</p>
              <p className="font-medium">{rotationConfig.maxFailuresBeforeRotation}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Min Time Between Rotations</p>
              <p className="font-medium">{(rotationConfig.minTimeBetweenRotations / 1000).toFixed(0)}s</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Max Credentials Per Provider</p>
              <p className="font-medium">{rotationConfig.maxCredentialsPerProvider}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Rotate on 401</p>
              <p className="font-medium">{rotationConfig.rotateOnUnauthorized ? "Yes" : "No"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Rotate on Billing Error</p>
              <p className="font-medium">{rotationConfig.rotateOnBillingError ? "Yes" : "No"}</p>
            </div>
          </div>
        </div>
      )}

      {/* Info Box */}
      <div className="card p-4 bg-blue-50 border-blue-200 space-y-2">
        <p className="text-sm font-medium text-blue-900">💡 How Credential Rotation Works</p>
        <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
          <li>Register multiple credentials per provider for redundancy</li>
          <li>The system automatically rotates to next credential on 401 errors</li>
          <li>Failed credentials are tracked and marked unhealthy</li>
          <li>Manual rotation available via the Rotate button</li>
          <li>Rotation is rate-limited to prevent storms</li>
        </ul>
      </div>
    </div>
  );
}
