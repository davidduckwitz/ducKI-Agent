/**
 * Crypto Payment Skill Script
 * Provides agent with cryptocurrency wallet and transaction management
 */

// Use relative URL so it works with any server configuration
const BASE_API = typeof window !== 'undefined' ? '' : '/api';

/**
 * Tool definitions for agent
 */
const tools = [
  {
    name: "crypto_generate_address",
    description: "Generate a new cryptocurrency address",
    parameters: {
      type: "object",
      properties: {
        currency: {
          type: "string",
          enum: ["BTC", "ETH", "XRP"],
          description: "Cryptocurrency type",
        },
        label: {
          type: "string",
          description: "Label for the address (e.g., 'Main Wallet')",
        },
      },
      required: ["currency"],
    },
  },
  {
    name: "crypto_list_addresses",
    description: "List all managed cryptocurrency addresses",
    parameters: {
      type: "object",
      properties: {
        currency: {
          type: "string",
          enum: ["BTC", "ETH", "XRP"],
          description: "Filter by currency (optional)",
        },
      },
    },
  },
  {
    name: "crypto_get_address",
    description: "Get details for a specific address",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "Address ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "crypto_delete_address",
    description: "Delete a managed address",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "Address ID to delete",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "crypto_import_private_key",
    description: "Import an existing address via private key or seed phrase",
    parameters: {
      type: "object",
      properties: {
        currency: {
          type: "string",
          enum: ["BTC", "ETH", "XRP"],
          description: "Cryptocurrency type",
        },
        privateKey: {
          type: "string",
          description: "Private key or seed phrase to import",
        },
        label: {
          type: "string",
          description: "Label for imported address",
        },
      },
      required: ["currency", "privateKey"],
    },
  },
  {
    name: "crypto_export_address",
    description: "Export address with optional private key",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "Address ID to export",
        },
        includePrivateKey: {
          type: "boolean",
          description: "Include private key in export (default: false)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "crypto_get_portfolio",
    description: "Get portfolio summary with total value and holdings",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "crypto_get_transactions",
    description: "Get transaction history for an address",
    parameters: {
      type: "object",
      properties: {
        addressId: {
          type: "number",
          description: "Address ID",
        },
        limit: {
          type: "number",
          description: "Max transactions to return (default: 50)",
        },
      },
      required: ["addressId"],
    },
  },
  {
    name: "crypto_sync_transactions",
    description: "Sync transactions with blockchain API",
    parameters: {
      type: "object",
      properties: {
        addressId: {
          type: "number",
          description: "Address ID to sync",
        },
      },
      required: ["addressId"],
    },
  },
  {
    name: "crypto_set_api_credentials",
    description: "Save API credentials for blockchain data provider",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["bitref", "etherscan", "xrpscan"],
          description: "API provider",
        },
        apiKey: {
          type: "string",
          description: "API key",
        },
        apiSecret: {
          type: "string",
          description: "API secret (optional)",
        },
      },
      required: ["provider", "apiKey"],
    },
  },
  {
    name: "crypto_test_connection",
    description: "Test API connection",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "crypto_get_settings",
    description: "Get crypto portfolio settings",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "crypto_update_settings",
    description: "Update crypto portfolio settings",
    parameters: {
      type: "object",
      properties: {
        currency: {
          type: "string",
          description: "Display currency (USD, EUR, etc.)",
        },
        refreshIntervalSeconds: {
          type: "number",
          description: "Auto-refresh interval in seconds",
        },
        autoSyncEnabled: {
          type: "boolean",
          description: "Enable automatic sync",
        },
        notificationsEnabled: {
          type: "boolean",
          description: "Enable notifications",
        },
      },
    },
  },
];

/**
 * Execute tool action
 */
async function executeTool(toolName, parameters) {
  try {
    switch (toolName) {
      case "crypto_generate_address":
        return await generateAddress(parameters);
      case "crypto_list_addresses":
        return await listAddresses(parameters);
      case "crypto_get_address":
        return await getAddress(parameters);
      case "crypto_delete_address":
        return await deleteAddress(parameters);
      case "crypto_import_private_key":
        return await importPrivateKey(parameters);
      case "crypto_export_address":
        return await exportAddress(parameters);
      case "crypto_get_portfolio":
        return await getPortfolio();
      case "crypto_get_transactions":
        return await getTransactions(parameters);
      case "crypto_sync_transactions":
        return await syncTransactions(parameters);
      case "crypto_set_api_credentials":
        return await setApiCredentials(parameters);
      case "crypto_test_connection":
        return await testConnection();
      case "crypto_get_settings":
        return await getSettings();
      case "crypto_update_settings":
        return await updateSettings(parameters);
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    return {
      error: error.message || "Unknown error occurred",
      details: error.toString(),
    };
  }
}

// API Client Functions

async function generateAddress({ currency, label }) {
  const response = await fetch(`${BASE_API}/api/crypto/addresses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      currency,
      label: label || `${currency} Address`,
    }),
  });
  return await response.json();
}

async function listAddresses({ currency }) {
  let url = `${BASE_API}/api/crypto/addresses`;
  if (currency) url += `?currency=${currency}`;

  const response = await fetch(url);
  return await response.json();
}

async function getAddress({ id }) {
  const response = await fetch(`${BASE_API}/api/crypto/addresses/${id}`);
  return await response.json();
}

async function deleteAddress({ id }) {
  const response = await fetch(`${BASE_API}/api/crypto/addresses/${id}`, {
    method: "DELETE",
  });
  return await response.json();
}

async function importPrivateKey({ currency, privateKey, label }) {
  const response = await fetch(`${BASE_API}/api/crypto/addresses/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      currency,
      privateKey,
      label: label || "Imported Address",
    }),
  });
  return await response.json();
}

async function exportAddress({ id, includePrivateKey }) {
  const response = await fetch(`${BASE_API}/api/crypto/addresses/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      includePrivateKey: includePrivateKey || false,
    }),
  });
  return await response.json();
}

async function getPortfolio() {
  const response = await fetch(`${BASE_API}/api/crypto/portfolio/summary`);
  return await response.json();
}

async function getTransactions({ addressId, limit }) {
  const response = await fetch(
    `${BASE_API}/api/crypto/transactions/${addressId}?limit=${limit || 50}`
  );
  return await response.json();
}

async function syncTransactions({ addressId }) {
  const response = await fetch(`${BASE_API}/api/crypto/transactions/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addressId }),
  });
  return await response.json();
}

async function setApiCredentials({ provider, apiKey, apiSecret }) {
  const response = await fetch(`${BASE_API}/api/crypto/api-credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      apiKey,
      apiSecret: apiSecret || undefined,
    }),
  });
  return await response.json();
}

async function testConnection() {
  const response = await fetch(`${BASE_API}/api/crypto/portfolio/summary`);
  if (response.ok) {
    return { success: true, message: "API connection successful" };
  } else {
    return { success: false, message: "API connection failed" };
  }
}

async function getSettings() {
  const response = await fetch(`${BASE_API}/api/crypto/settings`);
  return await response.json();
}

async function updateSettings(settings) {
  const response = await fetch(`${BASE_API}/api/crypto/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  return await response.json();
}

/**
 * Export for agent integration
 */
module.exports = {
  tools,
  executeTool,
};
