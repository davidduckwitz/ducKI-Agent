import { usePortfolioSummary, useAddresses } from "../../hooks/useCrypto";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Loader2, RefreshCw, TrendingUp, Wallet } from "lucide-react";
import { Button } from "../ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from "recharts";
import { CurrencyIcon, getCurrencyColor, getCurrencyBgColor } from "./CurrencyIcon";

export function PortfolioOverview() {
  const { data: portfolio, isLoading, error } = usePortfolioSummary();
  const { data: addresses } = useAddresses();
  const queryClient = useQueryClient();

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["crypto", "portfolio", "summary"] });
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error || !portfolio) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-64 text-red-500">
          Fehler beim Laden des Portfolios
        </CardContent>
      </Card>
    );
  }

  const holdings = [
    { symbol: "BTC", emoji: "₿", balance: portfolio.holdings.BTC.amount, usd: portfolio.holdings.BTC.usd },
    { symbol: "ETH", emoji: "Ξ", balance: portfolio.holdings.ETH.amount, usd: portfolio.holdings.ETH.usd },
    { symbol: "XRP", emoji: "✕", balance: portfolio.holdings.XRP.amount, usd: portfolio.holdings.XRP.usd },
  ];

  const btcCount = addresses?.filter(a => a.currency === "BTC").length || 0;
  const ethCount = addresses?.filter(a => a.currency === "ETH").length || 0;
  const xrpCount = addresses?.filter(a => a.currency === "XRP").length || 0;
  const totalAddresses = addresses?.length || 0;

  return (
    <div className="space-y-4">
      {/* Total Value + Address Count */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="bg-gradient-to-r from-blue-500/10 to-purple-500/10 border-blue-500/20">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Portfolio Gesamt
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefresh}
                className="h-8 w-8 p-0"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="text-3xl font-bold">
                ${portfolio.totalUsd.toFixed(2)}
              </div>
              <p className="text-sm text-muted-foreground">
                Gesamtwert in USD
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Address Count Card */}
        <Card className="bg-gradient-to-r from-green-500/10 to-emerald-500/10 border-green-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Wallet className="h-4 w-4" />
              Verwaltete Adressen
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="text-3xl font-bold">{totalAddresses}</div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="flex flex-col items-center p-2 bg-orange-500/10 rounded">
                  <span className="font-semibold text-orange-600">₿</span>
                  <span className="text-muted-foreground">{btcCount}</span>
                </div>
                <div className="flex flex-col items-center p-2 bg-purple-500/10 rounded">
                  <span className="font-semibold text-purple-600">Ξ</span>
                  <span className="text-muted-foreground">{ethCount}</span>
                </div>
                <div className="flex flex-col items-center p-2 bg-blue-500/10 rounded">
                  <span className="font-semibold text-blue-600">✕</span>
                  <span className="text-muted-foreground">{xrpCount}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Holdings */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {holdings.map((holding) => (
          <Card key={holding.symbol} className={`border-current/20 ${getCurrencyBgColor(holding.symbol as any)}`}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <div className={`p-1.5 rounded-full ${getCurrencyBgColor(holding.symbol as any)}`}>
                    <CurrencyIcon currency={holding.symbol as any} size={16} className={getCurrencyColor(holding.symbol as any)} />
                  </div>
                  {holding.symbol}
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="text-lg font-semibold">
                  {holding.balance === "0"
                    ? "0"
                    : parseFloat(holding.balance).toFixed(6)}
                </div>
                <div className="text-sm text-muted-foreground">
                  ${holding.usd.toFixed(2)}
                </div>
                <div className="text-xs text-muted-foreground pt-2 border-t">
                  {portfolio.totalUsd > 0 ? ((holding.usd / portfolio.totalUsd) * 100).toFixed(1) : "0"}%
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Portfolio Distribution Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Portfolio Verteilung
          </CardTitle>
        </CardHeader>
        <CardContent>
          {portfolio.totalUsd > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={holdings.filter(h => h.usd > 0).map(h => ({
                    name: h.symbol,
                    value: h.usd,
                  }))}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, value, percent }) => (
                    `${name} ${percent ? (percent * 100).toFixed(0) : 0}%`
                  )}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  <Cell fill="#3b82f6" />
                  <Cell fill="#10b981" />
                  <Cell fill="#f59e0b" />
                </Pie>
                <Tooltip
                  formatter={(value) => `$${(value as number).toFixed(2)}`}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-muted-foreground">
              Keine Daten vorhanden
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
