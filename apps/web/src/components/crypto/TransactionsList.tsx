import { useState } from "react";
import { useTransactions, useSyncTransactions } from "../../hooks/useCrypto";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Loader2, RefreshCw, ExternalLink, Filter } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

interface TransactionsListProps {
  addressId: number;
}

export function TransactionsList({ addressId }: TransactionsListProps) {
  const { data: transactions, isLoading } = useTransactions(addressId);
  const syncTransactions = useSyncTransactions();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [currencyFilter, setCurrencyFilter] = useState<string>("all");

  const handleSync = async () => {
    await syncTransactions.mutateAsync(addressId);
  };

  const filteredTransactions = transactions?.filter((tx) => {
    const statusMatch =
      statusFilter === "all" || tx.status === statusFilter;
    const currencyMatch =
      currencyFilter === "all" || tx.currency === currencyFilter;
    return statusMatch && currencyMatch;
  }) || [];

  const getStatusColor = (status: string) => {
    switch (status) {
      case "confirmed":
        return "bg-green-500/10 text-green-700 border-green-500/20";
      case "pending":
        return "bg-yellow-500/10 text-yellow-700 border-yellow-500/20";
      case "failed":
        return "bg-red-500/10 text-red-700 border-red-500/20";
      default:
        return "bg-gray-500/10";
    }
  };

  const getBlockExplorerUrl = (hash: string, currency: string) => {
    switch (currency) {
      case "BTC":
        return `https://blockchain.com/btc/tx/${hash}`;
      case "ETH":
        return `https://etherscan.io/tx/${hash}`;
      case "XRP":
        return `https://xrpscan.com/tx/${hash}`;
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
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <CardTitle>Transaktionen</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={syncTransactions.isPending}
            >
              <RefreshCw className={`h-4 w-4 ${syncTransactions.isPending ? "animate-spin" : ""}`} />
              Synchronisieren
            </Button>
          </div>

          {/* Filters */}
          <div className="flex gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-32 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle Status</SelectItem>
                  <SelectItem value="confirmed">Bestätigt</SelectItem>
                  <SelectItem value="pending">Ausstehend</SelectItem>
                  <SelectItem value="failed">Fehlgeschlagen</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Select value={currencyFilter} onValueChange={setCurrencyFilter}>
              <SelectTrigger className="w-32 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle Währungen</SelectItem>
                <SelectItem value="BTC">Bitcoin</SelectItem>
                <SelectItem value="ETH">Ethereum</SelectItem>
                <SelectItem value="XRP">XRP</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!filteredTransactions || filteredTransactions.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            {transactions && transactions.length > 0
              ? "Keine Transaktionen mit diesen Filtern vorhanden"
              : "Keine Transaktionen vorhanden"}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredTransactions.map((tx) => (
              <div
                key={tx.hash}
                className="flex items-center justify-between p-3 border rounded-lg hover:bg-accent/50 transition-colors"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={getStatusColor(tx.status)}
                    >
                      {tx.status === "confirmed"
                        ? "✓ Bestätigt"
                        : tx.status === "pending"
                        ? "⏳ Ausstehend"
                        : "✗ Fehlgeschlagen"}
                    </Badge>
                    <span className="font-mono text-sm">
                      {tx.amount} {tx.currency}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground font-mono mt-1">
                    {tx.hash.substring(0, 16)}...{tx.hash.substring(tx.hash.length - 8)}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {tx.timestamp ? new Date(tx.timestamp).toLocaleString() : "N/A"}
                    {tx.confirmations && tx.confirmations > 0 && (
                      <span className="ml-2">
                        ({tx.confirmations} confirmations)
                      </span>
                    )}
                  </div>
                  {tx.fee && (
                    <div className="text-xs text-muted-foreground">
                      Fee: {tx.fee} {tx.currency}
                    </div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  asChild
                >
                  <a
                    href={getBlockExplorerUrl(tx.hash, tx.currency)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
