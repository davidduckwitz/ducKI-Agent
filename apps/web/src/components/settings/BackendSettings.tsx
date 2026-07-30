import { useState } from "react";
import { useBackendConfig } from "../../hooks/useBackendConfig";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { AlertCircle, CheckCircle } from "lucide-react";
import { Alert, AlertDescription } from "../ui/alert";

export function BackendSettings() {
  const { config, saveConfig, getBackendUrl } = useBackendConfig();
  const [type, setType] = useState<"local" | "remote">(config.type);
  const [url, setUrl] = useState(config.url || "");
  const [port, setPort] = useState(String(config.port || 3001));
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const handleSave = () => {
    const newConfig = {
      type,
      ...(type === "remote" ? { url } : { port: parseInt(port) }),
    };
    saveConfig(newConfig);
    testBackendConnection();
  };

  const testBackendConnection = async () => {
    setIsTesting(true);
    try {
      const baseUrl = getBackendUrl();
      const response = await fetch(`${baseUrl}/settings`);
      setTestResult(response.ok ? "success" : "error");
    } catch {
      setTestResult("error");
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Backend-Verbindung</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Type Selection */}
        <div className="space-y-2">
          <Label htmlFor="backend-type">Verbindungstyp</Label>
          <Select value={type} onValueChange={(value) => setType(value as "local" | "remote")}>
            <SelectTrigger id="backend-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">
                <div>
                  <div className="font-medium">Lokal</div>
                  <div className="text-xs text-muted-foreground">Frontend und Backend auf diesem Gerät</div>
                </div>
              </SelectItem>
              <SelectItem value="remote">
                <div>
                  <div className="font-medium">Remote</div>
                  <div className="text-xs text-muted-foreground">Backend auf anderen Gerät/Server</div>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Local Config */}
        {type === "local" && (
          <div className="space-y-2">
            <Label htmlFor="backend-port">Port</Label>
            <Input
              id="backend-port"
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="3001"
              min="1"
              max="65535"
            />
            <p className="text-xs text-muted-foreground">
              Backend läuft auf http://localhost:{port}
            </p>
          </div>
        )}

        {/* Remote Config */}
        {type === "remote" && (
          <div className="space-y-2">
            <Label htmlFor="backend-url">Backend-URL</Label>
            <Input
              id="backend-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://192.168.1.100:3001 oder https://api.example.com"
            />
            <p className="text-xs text-muted-foreground">
              Vollständige URL zum Remote-Backend (mit http/https)
            </p>
          </div>
        )}

        {/* Test Result */}
        {testResult === "success" && (
          <Alert variant="success">
            <CheckCircle className="h-4 w-4" />
            <AlertDescription>Backend-Verbindung erfolgreich!</AlertDescription>
          </Alert>
        )}

        {testResult === "error" && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Backend-Verbindung fehlgeschlagen. Stelle sicher, dass der Server läuft.
            </AlertDescription>
          </Alert>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-4">
          <Button onClick={handleSave}>
            Speichern & Testen
          </Button>
          <Button
            variant="outline"
            onClick={testBackendConnection}
            disabled={isTesting}
          >
            {isTesting ? "Teste..." : "Verbindung testen"}
          </Button>
        </div>

        {/* Current Config Info */}
        <div className="p-3 bg-muted rounded-lg text-sm">
          <div className="font-medium mb-1">Aktuell konfiguriert</div>
          <div className="text-muted-foreground text-xs space-y-1">
            {type === "local" ? (
              <div>Lokal: http://localhost:{port}</div>
            ) : (
              <div>Remote: {url || "nicht konfiguriert"}</div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
