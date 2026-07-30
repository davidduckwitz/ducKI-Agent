import { useState } from "react";
import { useAddresses, useDeleteAddress, useUpdateAddressLabel, useCreateAddress, useImportPrivateKey } from "../../hooks/useCrypto";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Badge } from "../ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Loader2, Plus, Trash2, Copy, QrCode, Edit2, Eye, EyeOff } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { QRCodeModal } from "./QRCodeModal";
import { CurrencyIcon, getCurrencyColor, getCurrencyBgColor } from "./CurrencyIcon";

export function AddressesList() {
  const { data: addresses, isLoading } = useAddresses();
  const deleteAddress = useDeleteAddress();
  const updateLabel = useUpdateAddressLabel();
  const createAddress = useCreateAddress();
  const importPrivateKey = useImportPrivateKey();

  const [selectedCurrency, setSelectedCurrency] = useState<"BTC" | "ETH" | "XRP" | "ALL">("ALL");
  const [newLabel, setNewLabel] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importKey, setImportKey] = useState("");
  const [importLabel, setImportLabel] = useState("");
  const [importCurrency, setImportCurrency] = useState<"BTC" | "ETH" | "XRP">("BTC");
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [qrModalAddress, setQrModalAddress] = useState<{
    address: string;
    label?: string;
    currency: "BTC" | "ETH" | "XRP";
  } | null>(null);
  const [createDialogCurrency, setCreateDialogCurrency] = useState<"BTC" | "ETH" | "XRP">("BTC");
  const [showPrivateKey, setShowPrivateKey] = useState<number | null>(null);

  const handleCreateAddress = async () => {
    await createAddress.mutateAsync({
      currency: createDialogCurrency,
      label: newLabel || `${createDialogCurrency} Address`,
    });
    setNewLabel("");
  };

  const handleImportPrivateKey = async () => {
    await importPrivateKey.mutateAsync({
      currency: importCurrency,
      privateKey: importKey,
      label: importLabel || "Imported Address",
    });
    setImportKey("");
    setImportLabel("");
    setImportDialogOpen(false);
  };

  const handleDeleteAddress = async (id: number) => {
    if (confirm("Sind Sie sicher, dass Sie diese Adresse löschen möchten?")) {
      await deleteAddress.mutateAsync(id);
    }
  };

  const handleUpdateLabel = async (id: number) => {
    if (editingLabel.trim()) {
      await updateLabel.mutateAsync({ id, label: editingLabel });
      setEditingId(null);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const handleShowQRCode = (address: {
    address: string;
    label?: string;
    currency: "BTC" | "ETH" | "XRP";
  }) => {
    setQrModalAddress(address);
    setQrModalOpen(true);
  };

  const filteredAddresses = addresses?.filter(a =>
    selectedCurrency === "ALL" ? true : a.currency === selectedCurrency
  ) || [];

  // Group addresses by currency
  const groupedAddresses = {
    BTC: filteredAddresses.filter(a => a.currency === "BTC"),
    ETH: filteredAddresses.filter(a => a.currency === "ETH"),
    XRP: filteredAddresses.filter(a => a.currency === "XRP"),
  };

  const currencyGroups = selectedCurrency === "ALL"
    ? (Object.entries(groupedAddresses).filter(([_, addrs]) => addrs.length > 0) as [string, typeof filteredAddresses][])
    : [[selectedCurrency, filteredAddresses] as [string, typeof filteredAddresses]];

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
        <div className="flex items-center justify-between mb-4">
          <CardTitle>Adressen</CardTitle>
          <div className="flex gap-2">
            <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">Import Private Key</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Private Key Importieren</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label>Währung</Label>
                    <Select value={importCurrency} onValueChange={(v) => setImportCurrency(v as any)}>
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
                    <Label>Private Key / Seed</Label>
                    <Input
                      type="password"
                      placeholder="Paste private key here..."
                      value={importKey}
                      onChange={(e) => setImportKey(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Label (optional)</Label>
                    <Input
                      placeholder="z.B. My Cold Wallet"
                      value={importLabel}
                      onChange={(e) => setImportLabel(e.target.value)}
                    />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" onClick={() => setImportDialogOpen(false)}>
                      Abbrechen
                    </Button>
                    <Button onClick={handleImportPrivateKey} disabled={importPrivateKey.isPending || !importKey}>
                      {importPrivateKey.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Importieren"}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
            <Dialog>
              <DialogTrigger asChild>
                <Button size="sm" gap-2>
                  <Plus className="h-4 w-4" />
                  Neue Adresse
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Neue {createDialogCurrency} Adresse</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label>Währung</Label>
                    <Select value={createDialogCurrency} onValueChange={(v) => setCreateDialogCurrency(v as any)}>
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
                    <Label>Label (optional)</Label>
                    <Input
                      placeholder="z.B. Main Wallet"
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                    />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline">Abbrechen</Button>
                    <Button onClick={handleCreateAddress} disabled={createAddress.isPending}>
                      {createAddress.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Generieren"}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Currency Filter Buttons */}
        <div className="flex gap-2 flex-wrap">
          <Button
            variant={selectedCurrency === "ALL" ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedCurrency("ALL")}
          >
            Alle ({addresses?.length || 0})
          </Button>
          <Button
            variant={selectedCurrency === "BTC" ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedCurrency("BTC")}
            className={selectedCurrency === "BTC" ? "bg-orange-600 hover:bg-orange-700" : ""}
          >
            ₿ Bitcoin ({groupedAddresses.BTC.length})
          </Button>
          <Button
            variant={selectedCurrency === "ETH" ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedCurrency("ETH")}
            className={selectedCurrency === "ETH" ? "bg-purple-600 hover:bg-purple-700" : ""}
          >
            Ξ Ethereum ({groupedAddresses.ETH.length})
          </Button>
          <Button
            variant={selectedCurrency === "XRP" ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedCurrency("XRP")}
            className={selectedCurrency === "XRP" ? "bg-blue-600 hover:bg-blue-700" : ""}
          >
            ✕ XRP ({groupedAddresses.XRP.length})
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {filteredAddresses.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            Keine Adressen vorhanden
          </div>
        ) : (
          <div className="space-y-6">
            {currencyGroups.map(([currency, addrs]) => (
              <div key={currency}>
                <h3 className="text-sm font-semibold text-muted-foreground mb-3 flex items-center gap-2">
                  <div className={`p-1.5 rounded-full ${getCurrencyBgColor(currency as any)}`}>
                    <CurrencyIcon currency={currency as any} size={14} className={getCurrencyColor(currency as any)} />
                  </div>
                  {currency === "BTC" ? "Bitcoin" : currency === "ETH" ? "Ethereum" : "XRP"} ({addrs.length})
                </h3>
                <div className="space-y-2 ml-6">
                  {addrs.map((addr) => (
                    <div
                      key={addr.id}
                      className={`flex items-center justify-between p-3 border rounded-lg hover:bg-accent/50 transition-colors ${getCurrencyBgColor(addr.currency)} border-current/20`}
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          {editingId === addr.id ? (
                            <Input
                              autoFocus
                              value={editingLabel}
                              onChange={(e) => setEditingLabel(e.target.value)}
                              onBlur={() => handleUpdateLabel(addr.id!)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleUpdateLabel(addr.id!);
                                if (e.key === "Escape") setEditingId(null);
                              }}
                              className="h-7 text-sm w-40"
                            />
                          ) : (
                            <span className="font-medium">{addr.label || "Unlabeled"}</span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono mt-1">
                          {addr.address.substring(0, 16)}...{addr.address.substring(addr.address.length - 8)}
                        </div>
                        {showPrivateKey === addr.id && (
                          <div className="text-xs text-yellow-600 font-mono mt-2 p-2 bg-yellow-50 dark:bg-yellow-950 rounded border border-yellow-200 dark:border-yellow-800">
                            <div className="text-xs font-semibold mb-1">⚠️ Private Key (GEHEIM):</div>
                            <div className="break-all select-all">{addr.publicKey || "N/A"}</div>
                          </div>
                        )}
                        {addr.balance && addr.balance !== "0" && (
                          <div className="text-sm text-muted-foreground mt-1">
                            Balance: {parseFloat(addr.balance).toFixed(6)} {addr.currency}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingId(addr.id!);
                            setEditingLabel(addr.label || "");
                          }}
                          title="Label bearbeiten"
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyToClipboard(addr.address)}
                          title="Adresse kopieren"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleShowQRCode({
                            address: addr.address,
                            label: addr.label,
                            currency: addr.currency
                          })}
                          title="QR-Code anzeigen"
                        >
                          <QrCode className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowPrivateKey(showPrivateKey === addr.id ? null : addr.id!)}
                          title="Private Key anzeigen"
                        >
                          {showPrivateKey === addr.id ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteAddress(addr.id!)}
                          title="Löschen"
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* QR Code Modal */}
      {qrModalAddress && (
        <QRCodeModal
          open={qrModalOpen}
          onOpenChange={setQrModalOpen}
          address={qrModalAddress.address}
          label={qrModalAddress.label}
          currency={qrModalAddress.currency}
        />
      )}
    </Card>
  );
}
