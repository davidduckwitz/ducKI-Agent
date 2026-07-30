import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

export function createCryptoPaymentMcpTool(db: DatabaseService): ToolExecutor {
  return {
    name: "crypto-payment",
    description: "Manage cryptocurrency wallets and transactions (Bitcoin, Ethereum, XRP)",
    definition: {
      name: "crypto-payment",
      description: "Crypto payment management - generate addresses, manage wallets, track transactions",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list_addresses",
              "create_address",
              "import_private_key",
              "get_portfolio_summary",
              "get_transactions",
              "delete_address",
              "update_address_label",
            ],
            description: "Action to perform",
          },
          currency: {
            type: "string",
            enum: ["BTC", "ETH", "XRP"],
            description: "Cryptocurrency (for create_address, import_private_key)",
          },
          label: {
            type: "string",
            description: "Address label (for create_address, import_private_key)",
          },
          privateKey: {
            type: "string",
            description: "Private key or seed phrase (for import_private_key)",
          },
          addressId: {
            type: "number",
            description: "Address ID (for delete_address, update_address_label, get_transactions)",
          },
          newLabel: {
            type: "string",
            description: "New label (for update_address_label)",
          },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = String(input["action"] ?? "").toLowerCase();

      try {
        switch (action) {
          case "list_addresses": {
            const currency = input["currency"] ? String(input["currency"]) : undefined;
            const url = currency
              ? `/api/crypto/addresses?currency=${currency}`
              : "/api/crypto/addresses";
            const response = await fetch(`http://localhost:29544${url}`);
            const data = await response.json();
            return ok(data.data);
          }

          case "create_address": {
            const currency = String(input["currency"] ?? "BTC");
            const label = input["label"] ? String(input["label"]) : `${currency} Address`;
            const response = await fetch("http://localhost:29544/api/crypto/addresses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ currency, label }),
            });
            const data = await response.json();
            return ok(data.data);
          }

          case "import_private_key": {
            const currency = String(input["currency"] ?? "BTC");
            const privateKey = String(input["privateKey"] ?? "");
            const label = input["label"] ? String(input["label"]) : "Imported Address";

            if (!privateKey) return fail("privateKey is required");

            const response = await fetch("http://localhost:29544/api/crypto/addresses/import", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ currency, privateKey, label }),
            });
            const data = await response.json();
            return ok(data.data);
          }

          case "get_portfolio_summary": {
            const response = await fetch("http://localhost:29544/api/crypto/portfolio/summary");
            const data = await response.json();
            return ok(data.data);
          }

          case "get_transactions": {
            const addressId = input["addressId"] ? Number(input["addressId"]) : undefined;
            if (!addressId) return fail("addressId is required for get_transactions");

            const response = await fetch(`http://localhost:29544/api/crypto/transactions/${addressId}`);
            const data = await response.json();
            return ok(data.data);
          }

          case "delete_address": {
            const addressId = input["addressId"] ? Number(input["addressId"]) : undefined;
            if (!addressId) return fail("addressId is required for delete_address");

            const response = await fetch(`http://localhost:29544/api/crypto/addresses/${addressId}`, {
              method: "DELETE",
            });
            if (!response.ok) {
              return fail(`Failed to delete address: ${response.statusText}`);
            }
            return ok({ deleted: true, id: addressId });
          }

          case "update_address_label": {
            const addressId = input["addressId"] ? Number(input["addressId"]) : undefined;
            const newLabel = input["newLabel"] ? String(input["newLabel"]) : "";

            if (!addressId) return fail("addressId is required");
            if (!newLabel) return fail("newLabel is required");

            const response = await fetch(`http://localhost:29544/api/crypto/addresses/${addressId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ label: newLabel }),
            });
            const data = await response.json();
            return ok(data.data);
          }

          default:
            return fail(`Unknown action: ${action}`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
