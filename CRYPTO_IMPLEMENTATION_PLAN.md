# Crypto API Backend - Implementierungsplan

## Ziel
Machen Sie das Crypto Payment System von einer reinen UI-Mock-Implementierung zu einem voll funktionsfähigen Backend mit echten API-Endpoints.

## Phase 1: Foundation Fixes (Compile-Zeit Fehler)

### 1.1 Type Exports korrigieren
**Problem:** wallet-base.ts hat Interfaces die zur Runtime nicht exportiert werden
**Lösung:**
- [x] Alle `interface` zu `type` oder `export type` konvertieren
- [x] Sicherstellen, dass alle Types in wallet-base.ts korrekt exportiert sind
- [x] Alle Wallet-Klassen mit `override` Modifiern versehen (BEREITS GEMACHT)

### 1.2 Datenbank-Query API verwenden
**Problem:** CryptoService nutzt `db.query.insert()` statt korrekter API
**Lösung:**
- Verstehen, wie DatabaseService Query API funktioniert
- CryptoService anpassen, um die richtige API zu nutzen
- Beispiel: `await this.db.insert(schema.cryptoAddresses).values({...})`

### 1.3 Runtime Module Exports
**Problem:** Exports funktionieren nicht zur Runtime
**Lösung:**
- wallet-base.ts nur als type-definitionen
- Wallet-Implementierungen als echte Classes exportieren
- Index-Dateien mit korrekten Exports

---

## Phase 2: Datenbank-Integration

### 2.1 Datenbank-Schema überprüfen
**Schritte:**
- Überprüfen, ob `crypto_*` Tabellen in schema.ts definiert sind
- Prüfen ob CryptoAddressSelect, CryptoTransactionSelect Types vorhanden sind
- Falls nicht: Sie in schema.ts hinzufügen

### 2.2 CryptoService mit DB verbinden
**Schritte:**
1. `getAddresses()` - Adressen aus DB auslesen
2. `createAddress()` - Neue Adresse generieren UND in DB speichern
3. `importPrivateKey()` - Private Key importieren und speichern
4. `getPortfolioSummary()` - Alle Adressen summen und USD berechnen

**Database Service Pattern (korrekt):**
```typescript
// SELECT
const addresses = await this.db
  .select()
  .from(schema.cryptoAddresses)
  .where(eq(schema.cryptoAddresses.currency, "BTC"))
  .all();

// INSERT
await this.db
  .insert(schema.cryptoAddresses)
  .values({ currency: "BTC", address: "...", ... })
  .run();

// UPDATE
await this.db
  .update(schema.cryptoAddresses)
  .set({ label: "New Label" })
  .where(eq(schema.cryptoAddresses.id, id))
  .run();
```

---

## Phase 3: API Endpoints implementieren

### 3.1 POST /api/crypto/addresses (Create)
**Workflow:**
1. Request: `{ currency: "BTC", label?: "Main Wallet", derivationPath?: "..." }`
2. CryptoService.createAddress() aufrufen
3. Adresse generieren mit Wallet
4. In DB speichern
5. Response: `{ data: Address }`

### 3.2 GET /api/crypto/addresses (List)
**Workflow:**
1. CryptoService.getAddresses() aufrufen
2. Aus DB lesen (mit optionalem currency filter)
3. Response: `{ data: Address[] }`

### 3.3 POST /api/crypto/addresses/import (Import)
**Workflow:**
1. Request: `{ currency: "BTC", privateKey: "...", label: "Imported" }`
2. CryptoService.importPrivateKey() aufrufen
3. Wallet importieren und adresse generieren
4. In DB speichern
5. Response: `{ data: Address }`

### 3.4 GET /api/crypto/portfolio/summary (Portfolio)
**Workflow:**
1. CryptoService.getPortfolioSummary() aufrufen
2. Alle Adressen von DB holen
3. Balances summieren
4. Mit aktuellen Prices multiplizieren (für jetzt: alle = 0)
5. Response: `{ data: { totalUsd: 0, holdings: {...} } }`

### 3.5 POST /api/crypto/api-credentials (Credentials)
**Workflow:**
1. Request: `{ provider: "bitref", apiKey: "...", apiSecret?: "..." }`
2. CryptoService.setApiCredentials() aufrufen
3. Encrypted in DB speichern
4. Response: `{ data: { success: true } }`

---

## Phase 4: Testing & Verification

### 4.1 Manuelles Testing
**Schritte:**
1. Dev-Server starten
2. Zur Crypto Payment Page navigieren
3. "Neue Adresse" Button klicken
4. Bitcoin/Ethereum/XRP auswählen
5. Adresse sollte generiert werden
6. Seite aktualisieren - Adresse sollte noch da sein

### 4.2 API Testing (curl/Postman)
```bash
# Address erstellen
curl -X POST http://localhost:3001/api/crypto/addresses \
  -H "Content-Type: application/json" \
  -d '{"currency":"BTC","label":"Test"}'

# Adressen auflisten
curl http://localhost:3001/api/crypto/addresses

# Portfolio Summary
curl http://localhost:3001/api/crypto/portfolio/summary
```

---

## Implementation Reihenfolge (Empfohlen)

1. **Zuerst:** wallet-base.ts & Index-Dateien reparieren (Type Exports)
2. **Dann:** DatabaseService Query API Pattern verstehen
3. **Dann:** CryptoService mit DB-Queries implementieren
4. **Dann:** Routes mit CryptoService verbinden
5. **Dann:** Testen und Debuggen

---

## Critical Path (Was muss funktionieren)

✅ = Fertig
🚧 = In Arbeit
❌ = Nicht fertig

- ✅ Frontend UI kompiliert
- ✅ Routes registriert in index.ts
- 🚧 Wallet-Klassen exportieren korrekt
- ❌ CryptoService nutzt DatabaseService richtig
- ❌ API Endpoints sind mit Services verbunden
- ❌ Adressen werden in DB gespeichert
- ❌ Adressen werden nach Refresh noch angezeigt

---

## Häufige Fehler (vermeiden!)

1. **Type vs Runtime Exports**
   - ❌ `interface Address {}` → Type-only, nicht zur Runtime
   - ✅ `export type Address = { ... }` → Funktioniert auch in JS

2. **Datenbank Queries**
   - ❌ `this.db.query.insert(...)` → Falsch, existiert nicht
   - ✅ `this.db.insert(schema.table).values(...)` → Richtig

3. **Async/Await**
   - Alle DB-Operationen sind async → `.run()`, `.get()`, `.all()` aufrufen

4. **Error Handling**
   - Alle Endpoints sollten try/catch haben
   - Error Messages als Response zurückgeben

---

## Nächste Schritte

1. Plan mit User absprechen
2. Phase 1 durchführen (Type Exports)
3. Phase 2 durchführen (DB-Integration)
4. Phase 3 durchführen (Endpoints)
5. Phase 4 durchführen (Testing)
6. Commit & Push
