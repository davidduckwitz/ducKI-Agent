import { usePortfolioHistory } from "../../hooks/useCrypto";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Loader2, TrendingUp } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { useState } from "react";
import { Button } from "../ui/button";

export function PortfolioHistoryChart() {
  const [days, setDays] = useState(30);
  const { data: history, isLoading } = usePortfolioHistory(days);

  const chartData = history?.map((entry) => ({
    time: new Date(entry.timestamp).toLocaleDateString(),
    timestamp: entry.timestamp,
    total: entry.totalValueUsd,
    btc: entry.btc.usd,
    eth: entry.eth.usd,
    xrp: entry.xrp.usd,
  })) || [];

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
            <TrendingUp className="h-4 w-4" />
            Portfolio Wert (30 Tage)
          </CardTitle>
          <div className="flex gap-2">
            {[7, 30, 90].map((d) => (
              <Button
                key={d}
                variant={days === d ? "default" : "outline"}
                size="sm"
                onClick={() => setDays(d)}
              >
                {d}T
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground">
            Keine Daten vorhanden
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                style={{ fontSize: "12px" }}
              />
              <YAxis
                style={{ fontSize: "12px" }}
                label={{ value: "USD", angle: -90, position: "insideLeft" }}
              />
              <Tooltip
                formatter={(value) => `$${(value as number).toFixed(2)}`}
                labelStyle={{ color: "#000" }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="total"
                stroke="#3b82f6"
                name="Total"
                dot={false}
                strokeWidth={2}
              />
              <Line
                type="monotone"
                dataKey="btc"
                stroke="#f59e0b"
                name="BTC"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="eth"
                stroke="#a855f7"
                name="ETH"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="xrp"
                stroke="#06b6d4"
                name="XRP"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
