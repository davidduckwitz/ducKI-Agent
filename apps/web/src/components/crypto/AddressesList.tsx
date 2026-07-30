import { useState } from "react";
import { useAddresses, useDeleteAddress, useUpdateAddressLabel, useCreateAddress, useImportPrivateKey } from "../../hooks/useCrypto";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Badge } from "../ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Loader2, Plus, Trash2, Copy, QrCode, Edit2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { QRCodeModal } from "./QRCodeModal";
import { CurrencyIcon, getCurrencyColor, getCurrencyBgColor } from "./CurrencyIcon";

export function AddressesList() {
  const { data: addresses, isLoading } = useAddresses();
  const deleteAddress = useDeleteAddress();
  const updateLabel = useUpdateAddressLabel();
  const createAddress = useCreateAddress();
  const importPrivateKey = useImportPrivateKey();

  const [selectedCurrency, setSelectedCurrency] = useState<"BTC" | "ETH" | "XRP">("BTC");
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

  const handleCreateAddress = async () => {
    await createAddress.mutateAsync({
      currency: selectedCurrency,
      label: newLabel || `${selectedCurrency} Address`,
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

  const filteredAddresses = addresses?.filter(a => selectedCurrency ? a.currency === selectedCurrency : true) || [];

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
                  <DialogTitle>Neue {selectedCurrency} Adresse</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label>Währung</Label>
                    <Select value={selectedCurrency} onValueChange={(v) => setSelectedCurrency(v as any)}>
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
      </CardHeader>
      <CardContent>
        {filteredAddresses.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            Keine Adressen vorhanden
          </div>
        ) : (
          <div className="space-y-3">
            {filteredAddresses.map((addr) => (
              <div
                key={addr.id}
                className={`flex items-center justify-between p-3 border rounded-lg hover:bg-accent/50 transition-colors ${getCurrencyBgColor(addr.currency)} border-current/20`}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <div className={`p-1.5 rounded-full ${getCurrencyBgColor(addr.currency)}`}>
                      <CurrencyIcon currency={addr.currency} size={16} className={getCurrencyColor(addr.currency)} />
                    </div>
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
                  >
                    <Edit2 className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(addr.address)}
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
                  >
                    <QrCode className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteAddress(addr.id!)}
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
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
