import { useState } from "react";
import { usePriceAlerts, useCreatePriceAlert, useCryptoPrices } from "../../hooks/useCrypto";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Badge } from "../ui/badge";
import { Loader2, Plus, AlertTriangle, Bell } from "lucide-react";
import { CurrencyIcon, getCurrencyColor, getCurrencyBgColor } from "./CurrencyIcon";

export function PriceAlertsPanel() {
  const { data: alerts, isLoading } = usePriceAlerts();
  const { data: prices } = useCryptoPrices();
  const createAlert = useCreatePriceAlert();

  const [newAlert, setNewAlert] = useState({
    currency: "BTC" as "BTC" | "ETH" | "XRP",
    alertType: "price_above" as "price_above" | "price_below" | "change_percent",
    triggerValue: "",
  });
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleCreateAlert = async () => {
    if (!newAlert.triggerValue) return;

    await createAlert.mutateAsync({
      ...newAlert,
      triggerValue: parseFloat(newAlert.triggerValue),
    });

    setNewAlert({ currency: "BTC", alertType: "price_above", triggerValue: "" });
    setDialogOpen(false);
  };

  const getAlertDescription = (type: string, value: number, currency: string) => {
    const price = prices?.[currency.toLowerCase()]?.price || 0;

    switch (type) {
      case "price_above":
        return `Benachrichtige wenn ${currency} > $${value} (aktuell: $${price.toFixed(2)})`;
      case "price_below":
        return `Benachrichtige wenn ${currency} < $${value} (aktuell: $${price.toFixed(2)})`;
      case "change_percent":
        return `Benachrichtige wenn ${currency} sich um > ${value}% in 24h ändert`;
      default:
        return "";
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Preisalarme
          </CardTitle>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" gap-2>
                <Plus className="h-4 w-4" />
                Neuer Alarm
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Preisalarm erstellen</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Währung</Label>
                  <Select
                    value={newAlert.currency}
                    onValueChange={(v) =>
                      setNewAlert({ ...newAlert, currency: v as any })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BTC">Bitcoin</SelectItem>
                      <SelectItem value="ETH">Ethereum</SelectItem>
                      <SelectItem value="XRP">XRP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Alarmtyp</Label>
                  <Select
                    value={newAlert.alertType}
                    onValueChange={(v) =>
                      setNewAlert({ ...newAlert, alertType: v as any })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="price_above">Preis über</SelectItem>
                      <SelectItem value="price_below">Preis unter</SelectItem>
                      <SelectItem value="change_percent">Preisänderung (%)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Auslösewert</Label>
                  <Input
                    type="number"
                    placeholder="z.B. 50000"
                    value={newAlert.triggerValue}
                    onChange={(e) =>
                      setNewAlert({ ...newAlert, triggerValue: e.target.value })
                    }
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                  >
                    Abbrechen
                  </Button>
                  <Button
                    onClick={handleCreateAlert}
                    disabled={createAlert.isPending || !newAlert.triggerValue}
                  >
                    {createAlert.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Erstellen"
                    )}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {!alerts || alerts.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            Keine Alarme konfiguriert
          </div>
        ) : (
          <div className="space-y-3">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className={`flex items-center justify-between p-3 border rounded-lg ${getCurrencyBgColor(alert.currency)} border-current/20`}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <div className={`p-1.5 rounded-full ${getCurrencyBgColor(alert.currency)}`}>
                      <CurrencyIcon currency={alert.currency} size={14} className={getCurrencyColor(alert.currency)} />
                    </div>
                    <span className="font-medium">{alert.currency}</span>
                    <Badge variant="outline" className="text-xs">
                      {alert.alertType === "price_above"
                        ? "Über"
                        : alert.alertType === "price_below"
                        ? "Unter"
                        : "Änderung"}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {getAlertDescription(alert.alertType, alert.triggerValue, alert.currency)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {alert.isActive ? (
                    <Badge variant="default" className="bg-green-600">
                      Aktiv
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Inaktiv</Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
