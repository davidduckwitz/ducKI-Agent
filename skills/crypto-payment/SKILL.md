---
name: crypto-payment
description: Manages cryptocurrency wallets, addresses, and transactions for Bitcoin, Ethereum, and XRP.
related_skills: [memory, settings, workflow-orchestrator]
primary_skills: [memory]
fallback_skills: [history-search, memory]
---

# Crypto Payment Skill

This skill enables the agent to manage cryptocurrency wallets and transactions across multiple blockchains (Bitcoin, Ethereum, XRP).

## Capabilities

### Address Management
- **Generate Address** – Create new addresses for BTC, ETH, XRP
- **Import Private Key** – Import existing addresses via private key/seed phrase
- **List Addresses** – Fetch all managed addresses with balances
- **Export Address** – Export address data with optional encryption
- **Validate Address** – Validate address format for supported currencies

### Portfolio Management
- **Get Portfolio Summary** – Total holdings in BTC, ETH, XRP + USD equivalent
- **Get Address Balance** – Current balance for specific address
- **Fetch Transactions** – Transaction history for address
- **Sync Transactions** – Manually sync transactions from blockchain APIs

### API Credentials
- **Set API Credentials** – Save API keys for blockchain data providers
- **Test Connection** – Verify API credentials work correctly
- **Update Provider** – Switch between Bitref, Etherscan, XRP Ledger

### Settings
- **Get Crypto Settings** – Fetch portfolio preferences
- **Update Crypto Settings** – Modify currency, refresh rate, notifications

## API Endpoints

```
POST   /api/crypto/addresses                   # Generate new address
GET    /api/crypto/addresses                   # List all addresses
GET    /api/crypto/addresses/:id               # Get address details
DELETE /api/crypto/addresses/:id               # Delete address
PATCH  /api/crypto/addresses/:id               # Update address label

POST   /api/crypto/addresses/import            # Import private key
POST   /api/crypto/addresses/export            # Export address

GET    /api/crypto/transactions/:addressId     # Get transactions
POST   /api/crypto/transactions/sync           # Sync with blockchain

POST   /api/crypto/api-credentials             # Save API credentials
PUT    /api/crypto/api-credentials/:id         # Update credentials
GET    /api/crypto/api-credentials/test        # Test connection

GET    /api/crypto/portfolio/summary           # Portfolio overview
GET    /api/crypto/settings                    # Get settings
PATCH  /api/crypto/settings                    # Update settings
```

## Supported Currencies
- **BTC (Bitcoin)** – P2PKH addresses (1...), derivation path: m/44'/0'/0'/0/0
- **ETH (Ethereum)** – Checksummed addresses (0x...), derivation path: m/44'/60'/0'/0/0
- **XRP** – Classic addresses (r...), derivation path: m/44'/144'/0'/0/0

## API Providers
- **Bitref** – Bitcoin (bitref.com)
- **Etherscan** – Ethereum (etherscan.io)
- **XRP Ledger** – XRP (xrpl.org)

## Example Usage

### Generate a Bitcoin Address
```javascript
const response = await fetch('/api/crypto/addresses', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    currency: 'BTC',
    label: 'My Main Wallet'
  })
});
const address = await response.json();
// Returns: { id, address, publicKey, label, balance, derivationPath }
```

### Get Portfolio Summary
```javascript
const response = await fetch('/api/crypto/portfolio/summary');
const portfolio = await response.json();
// Returns: { totalUsd, holdings: { BTC, ETH, XRP }, lastSyncedAt }
```

### Set API Credentials
```javascript
const response = await fetch('/api/crypto/api-credentials', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    provider: 'etherscan',
    apiKey: 'YOUR_ETHERSCAN_KEY'
  })
});
```

## Security Considerations
- **Private Keys:** Encrypted with AES-256-GCM using MASTER_ENCRYPTION_KEY
- **API Credentials:** Stored encrypted in database
- **Validation:** All addresses validated against blockchain format specs
- **Rate Limiting:** API providers rate-limited per configured limits

## Environment Variables
- `MASTER_ENCRYPTION_KEY` – Master key for private key encryption (must be set in production)

## Related Documentation
- Bitcoin Address Formats: https://en.bitcoin.it/wiki/Address
- Ethereum Addresses: https://ethereum.org/en/developers/docs/accounts/
- XRP Addresses: https://xrpl.org/addresses.html
- BIP32/44 Derivation: https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki
