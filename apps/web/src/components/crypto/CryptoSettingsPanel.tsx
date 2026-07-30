import { useState } from "react";
import { useSetApiCredentials, useAddresses, usePortfolioSummary, useExportPortfolio } from "../../hooks/useCrypto";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Loader2, AlertCircle, Download, FileJson, FileText } from "lucide-react";
import { Alert, AlertDescription } from "../ui/alert";
import { exportAddressesToCSV, exportPortfolioToCSV } from "../../lib/csv-export";

export function CryptoSettingsPanel() {
  const [provider, setProvider] = useState<"bitref" | "etherscan" | "xrpscan">("bitref");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);

  const setApiCredentials = useSetApiCredentials();
  const { data: addresses } = useAddresses();
  const { data: portfolio } = usePortfolioSummary();
  const exportPortfolio = useExportPortfolio();

  const handleSaveCredentials = async () => {
    await setApiCredentials.mutateAsync({
      provider,
      apiKey,
      apiSecret: apiSecret || undefined,
    });
    setApiKey("");
    setApiSecret("");
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    try {
      // Simple test by fetching portfolio summary
      const response = await fetch("/api/crypto/portfolio/summary");
      if (response.ok) {
        setTestResult("success");
      } else {
        setTestResult("error");
      }
    } catch {
      setTestResult("error");
    } finally {
      setTestingConnection(false);
    }
  };

  const providerInfo: Record<string, { name: string; description: string }> = {
    bitref: {
      name: "Bitref",
      description: "Bitcoin API via bitref.com",
    },
    etherscan: {
      name: "Etherscan",
      description: "Ethereum API via etherscan.io",
    },
    xrpscan: {
      name: "XRP Ledger",
      description: "XRP Ledger API",
    },
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>API Konfiguration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {testResult === "success" && (
          <Alert className="bg-green-500/10 border-green-500/20">
            <AlertCircle className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-600">
              API-Verbindung erfolgreich!
            </AlertDescription>
          </Alert>
        )}

        {testResult === "error" && (
          <Alert className="bg-red-500/10 border-red-500/20">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-red-600">
              Fehler beim Testen der Verbindung. Überprüfen Sie Ihre Anmeldedaten.
            </AlertDescription>
          </Alert>
        )}

        {/* Provider Selection */}
        <div className="space-y-2">
          <Label htmlFor="provider">Provider</Label>
          <Select value={provider} onValueChange={(v) => setProvider(v as any)}>
            <SelectTrigger id="provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bitref">
                <div>
                  <div className="font-medium">Bitref (Bitcoin)</div>
                  <div className="text-xs text-muted-foreground">
                    {providerInfo.bitref?.description}
                  </div>
                </div>
              </SelectItem>
              <SelectItem value="etherscan">
                <div>
                  <div className="font-medium">Etherscan (Ethereum)</div>
                  <div className="text-xs text-muted-foreground">
                    {providerInfo.etherscan?.description}
                  </div>
                </div>
              </SelectItem>
              <SelectItem value="xrpscan">
                <div>
                  <div className="font-medium">XRP Ledger</div>
                  <div className="text-xs text-muted-foreground">
                    {providerInfo.xrpscan?.description}
                  </div>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {providerInfo[provider]?.description}
          </p>
        </div>

        {/* API Key */}
        <div className="space-y-2">
          <Label htmlFor="apiKey">API Key</Label>
          <Input
            id="apiKey"
            type="password"
            placeholder="Enter your API key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Ihr API-Schlüssel wird verschlüsselt gespeichert.
          </p>
        </div>

        {/* API Secret (optional) */}
        <div className="space-y-2">
          <Label htmlFor="apiSecret">API Secret (optional)</Label>
          <Input
            id="apiSecret"
            type="password"
            placeholder="Enter your API secret (if required)"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Nur erforderlich für manche Provider.
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            onClick={handleTestConnection}
            variant="outline"
            disabled={!apiKey || testingConnection || setApiCredentials.isPending}
          >
            {testingConnection && (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            )}
            Verbindung testen
          </Button>
          <Button
            onClick={handleSaveCredentials}
            disabled={!apiKey || setApiCredentials.isPending}
          >
            {setApiCredentials.isPending && (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            )}
            Speichern
          </Button>
        </div>

        {/* Rate Limit Info */}
        <div className="p-3 bg-muted rounded-lg text-sm">
          <div className="font-medium mb-1">API Limits</div>
          <div className="text-muted-foreground text-xs space-y-1">
            <div>
              {provider === "bitref" && "Bitref: 600 requests/minute"}
              {provider === "etherscan" &&
                "Etherscan: 5 calls/second (free tier)"}
              {provider === "xrpscan" && "XRP Ledger: Public API (no limits)"}
            </div>
          </div>
        </div>

        {/* Export Section */}
        <div className="border-t pt-6">
          <h3 className="font-semibold mb-3">Datenexport</h3>
          <div className="space-y-2">
            <Button
              variant="outline"
              className="w-full justify-start gap-2"
              disabled={!addresses || addresses.length === 0}
              onClick={() => {
                if (addresses) exportAddressesToCSV(addresses);
              }}
            >
              <FileText className="h-4 w-4" />
              Adressen als CSV exportieren
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start gap-2"
              disabled={!addresses || !portfolio}
              onClick={async () => {
                if (addresses && portfolio) {
                  exportPortfolioToCSV(addresses, portfolio);
                }
              }}
            >
              <FileJson className="h-4 w-4" />
              Portfolio als CSV exportieren
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start gap-2"
              disabled={exportPortfolio.isPending}
              onClick={() => exportPortfolio.mutateAsync()}
            >
              <Download className="h-4 w-4" />
              {exportPortfolio.isPending ? "Wird exportiert..." : "Portfolio als JSON exportieren"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Exportieren Sie Ihr Portfolio zur Sicherung oder Analyse in Excel/Google Sheets
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
