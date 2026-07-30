import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface CryptoAddress {
  id: number;
  currency: "BTC" | "ETH" | "XRP";
  address: string;
  publicKey?: string;
  label?: string;
  balance?: string;
  balanceUsd?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CryptoTransaction {
  id?: number;
  addressId?: number;
  currency: string;
  hash: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  fee?: string;
  status: "pending" | "confirmed" | "failed";
  confirmations?: number;
  blockNumber?: number;
  timestamp?: number;
}

export interface PortfolioSummary {
  totalUsd: number;
  holdings: Record<
    "BTC" | "ETH" | "XRP",
    { amount: string; usd: number }
  >;
}

export interface ApiCredential {
  id: number;
  provider: "bitref" | "etherscan" | "xrpscan";
  isActive: boolean;
  lastUsedAt?: string;
}

// Addresses
export function useAddresses(currency?: "BTC" | "ETH" | "XRP") {
  return useQuery({
    queryKey: ["crypto", "addresses", currency],
    queryFn: async () => {
      const params = currency ? `?currency=${currency}` : "";
      const response = await fetch(`/api/crypto/addresses${params}`);
      if (!response.ok) throw new Error("Failed to fetch addresses");
      const data = await response.json();
      return data.data as CryptoAddress[];
    },
  });
}

export function useAddressWithBalance(id: number) {
  return useQuery({
    queryKey: ["crypto", "addresses", id, "balance"],
    queryFn: async () => {
      const response = await fetch(`/api/crypto/addresses/${id}`);
      if (!response.ok) throw new Error("Failed to fetch address");
      const data = await response.json();
      return data.data as {
        address: CryptoAddress;
        balance: { address: string; balance: string; unit: string };
        transactions: CryptoTransaction[];
      };
    },
  });
}

export function useCreateAddress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      currency: "BTC" | "ETH" | "XRP";
      label?: string;
      derivationPath?: string;
    }) => {
      const response = await fetch("/api/crypto/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!response.ok) throw new Error("Failed to create address");
      const data = await response.json();
      return data.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crypto", "addresses"] });
    },
  });
}

export function useImportPrivateKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      currency: "BTC" | "ETH" | "XRP";
      privateKey: string;
      label: string;
    }) => {
      const response = await fetch("/api/crypto/addresses/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!response.ok) throw new Error("Failed to import private key");
      const data = await response.json();
      return data.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crypto", "addresses"] });
    },
  });
}

export function useUpdateAddressLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: number; label: string }) => {
      const response = await fetch(`/api/crypto/addresses/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: params.label }),
      });
      if (!response.ok) throw new Error("Failed to update label");
      const data = await response.json();
      return data.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crypto", "addresses"] });
    },
  });
}

export function useDeleteAddress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const response = await fetch(`/api/crypto/addresses/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to delete address");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crypto", "addresses"] });
    },
  });
}

// Transactions
export function useTransactions(addressId: number) {
  return useQuery({
    queryKey: ["crypto", "transactions", addressId],
    queryFn: async () => {
      const response = await fetch(
        `/api/crypto/transactions/${addressId}`
      );
      if (!response.ok) throw new Error("Failed to fetch transactions");
      const data = await response.json();
      return data.data as CryptoTransaction[];
    },
  });
}

export function useSyncTransactions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (addressId: number) => {
      const response = await fetch("/api/crypto/transactions/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addressId }),
      });
      if (!response.ok) throw new Error("Failed to sync transactions");
      const data = await response.json();
      return data.data;
    },
    onSuccess: (_, addressId) => {
      queryClient.invalidateQueries({
        queryKey: ["crypto", "transactions", addressId],
      });
    },
  });
}

// Portfolio
export function usePortfolioSummary() {
  return useQuery({
    queryKey: ["crypto", "portfolio", "summary"],
    queryFn: async () => {
      const response = await fetch("/api/crypto/portfolio/summary");
      if (!response.ok) throw new Error("Failed to fetch portfolio");
      const data = await response.json();
      return data.data as PortfolioSummary;
    },
    refetchInterval: 5 * 60 * 1000, // 5 minutes
  });
}

export function useExportPortfolio() {
  return useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/crypto/portfolio/export", {
        method: "POST",
      });
      if (!response.ok) throw new Error("Failed to export portfolio");
      const data = await response.json();
      return data.data;
    },
  });
}

export function useImportPortfolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      portfolio: { addresses: CryptoAddress[] };
      merge?: boolean;
    }) => {
      const response = await fetch("/api/crypto/portfolio/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!response.ok) throw new Error("Failed to import portfolio");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crypto"] });
    },
  });
}

// API Credentials
export function useSetApiCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      provider: "bitref" | "etherscan" | "xrpscan";
      apiKey: string;
      apiSecret?: string;
    }) => {
      const response = await fetch("/api/crypto/api-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!response.ok) throw new Error("Failed to set credentials");
      const data = await response.json();
      return data.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crypto"] });
    },
  });
}

// Price Tracking
export interface PriceData {
  symbol: string;
  price: number;
  change24h: number;
  marketCap?: number;
  volume24h?: number;
}

export function useCryptoPrices() {
  return useQuery({
    queryKey: ["crypto", "prices"],
    queryFn: async () => {
      const response = await fetch("/api/crypto/prices");
      if (!response.ok) throw new Error("Failed to fetch prices");
      const data = await response.json();
      return data.data as Record<string, PriceData>;
    },
    refetchInterval: 60 * 1000, // Every minute
  });
}

// Portfolio History
export interface PortfolioHistoryEntry {
  timestamp: number;
  totalValueUsd: number;
  btc: { amount: string; usd: number };
  eth: { amount: string; usd: number };
  xrp: { amount: string; usd: number };
}

export function usePortfolioHistory(days: number = 30) {
  return useQuery({
    queryKey: ["crypto", "portfolio-history", days],
    queryFn: async () => {
      const response = await fetch(`/api/crypto/portfolio/history?days=${days}`);
      if (!response.ok) throw new Error("Failed to fetch portfolio history");
      const data = await response.json();
      return data.data as PortfolioHistoryEntry[];
    },
  });
}

// Price History
export interface PriceHistoryEntry {
  timestamp: number;
  price: number;
}

export function usePriceHistory(currency: "BTC" | "ETH" | "XRP", days: number = 30) {
  return useQuery({
    queryKey: ["crypto", "price-history", currency, days],
    queryFn: async () => {
      const response = await fetch(`/api/crypto/prices/history/${currency}?days=${days}`);
      if (!response.ok) throw new Error("Failed to fetch price history");
      const data = await response.json();
      return data.data as PriceHistoryEntry[];
    },
  });
}

// Alerts
export interface PriceAlert {
  id: number;
  currency: "BTC" | "ETH" | "XRP";
  alertType: "price_above" | "price_below" | "change_percent";
  triggerValue: number;
  isActive: boolean;
}

export function usePriceAlerts() {
  return useQuery({
    queryKey: ["crypto", "alerts", "price"],
    queryFn: async () => {
      const response = await fetch("/api/crypto/alerts/price");
      if (!response.ok) throw new Error("Failed to fetch alerts");
      const data = await response.json();
      return data.data as PriceAlert[];
    },
  });
}

export function useCreatePriceAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      currency: "BTC" | "ETH" | "XRP";
      alertType: "price_above" | "price_below" | "change_percent";
      triggerValue: number;
    }) => {
      const response = await fetch("/api/crypto/alerts/price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!response.ok) throw new Error("Failed to create alert");
      const data = await response.json();
      return data.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crypto", "alerts", "price"] });
    },
  });
}
