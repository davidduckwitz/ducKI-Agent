import type { CryptoAddress, CryptoTransaction } from "../hooks/useCrypto";

export function exportAddressesToCSV(addresses: CryptoAddress[]): void {
  const headers = ["Currency", "Address", "Label", "Balance", "Balance (USD)", "Created"];
  const rows = addresses.map((addr) => [
    addr.currency,
    addr.address,
    addr.label || "",
    addr.balance || "0",
    addr.balanceUsd || "0",
    addr.createdAt || "",
  ]);

  const csv = [
    headers.join(","),
    ...rows.map((row) =>
      row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")
    ),
  ].join("\n");

  downloadCSV(csv, "crypto-addresses.csv");
}

export function exportTransactionsToCSV(transactions: CryptoTransaction[]): void {
  const headers = [
    "Date",
    "Currency",
    "Hash",
    "From",
    "To",
    "Amount",
    "Fee",
    "Status",
    "Confirmations",
  ];
  const rows = transactions.map((tx) => [
    tx.timestamp ? new Date(tx.timestamp).toISOString() : "",
    tx.currency,
    tx.hash,
    tx.fromAddress,
    tx.toAddress,
    tx.amount,
    tx.fee || "",
    tx.status,
    tx.confirmations || "",
  ]);

  const csv = [
    headers.join(","),
    ...rows.map((row) =>
      row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")
    ),
  ].join("\n");

  downloadCSV(csv, "crypto-transactions.csv");
}

export function exportPortfolioToCSV(
  addresses: CryptoAddress[],
  summary: { totalUsd: number; holdings: Record<string, { amount: string; usd: number }> }
): void {
  // Summary section
  const summaryLines = [
    "PORTFOLIO SUMMARY",
    `Total Value (USD),${summary.totalUsd.toFixed(2)}`,
    "",
    "Holdings",
    "Currency,Amount,USD Value",
    ...Object.entries(summary.holdings).map(([currency, holding]) => [
      currency,
      holding.amount,
      holding.usd.toFixed(2),
    ]),
  ];

  // Addresses section
  const addressLines = [
    "",
    "ADDRESSES",
    "Currency,Address,Label,Balance,Balance (USD)",
    ...addresses.map((addr) => [
      addr.currency,
      addr.address,
      addr.label || "",
      addr.balance || "0",
      addr.balanceUsd || "0",
    ]),
  ];

  const csv = [...summaryLines, ...addressLines]
    .map((row) =>
      typeof row === "string"
        ? row
        : row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")
    )
    .join("\n");

  downloadCSV(csv, "crypto-portfolio.csv");
}

function downloadCSV(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
