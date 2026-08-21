---
name: invoicing-usage
description: How to manage customers and create/track invoices with the invoicing tool. Use when the user wants to create an invoice, bill a customer, mark an invoice as paid, or export invoices for their accountant.
---

# Invoicing

The `invoicing` tool stores customers and invoices in this plugin's OWN SQLite database. Invoice numbers are assigned automatically per calendar year (e.g. `RE-2026-0001`, prefix configurable in plugin settings) and are never reused or reassigned — invoices can't be deleted, only marked paid, to keep the sequence audit-safe for tax purposes.

Add a customer, then create an invoice:
```
[TOOL:invoicing({"action": "add_customer", "name": "Musterfirma GmbH", "address": "Beispielstr. 1, 12345 Berlin", "email": "buchhaltung@musterfirma.de"})]
[TOOL:invoicing({"action": "create_invoice", "customer_id": 1, "due_date": "2026-09-15", "items": [{"description": "Beratung August", "qty": 10, "unit_price": 95}]})]
```

List / view / mark paid:
```
[TOOL:invoicing({"action": "list_invoices", "status": "open"})]
[TOOL:invoicing({"action": "get_invoice", "id": 3})]
[TOOL:invoicing({"action": "mark_paid", "id": 3})]
```

Export a year for the accountant (Steuerberater) as CSV:
```
[TOOL:invoicing({"action": "export_csv", "year": 2026})]
```

- There is no separate PDF generator — the plugin's frontend page renders each invoice as a clean printable HTML view; the user (or the browser's print dialog) turns that into a PDF via "Print → Save as PDF". Point the user to the invoice's page in the plugin UI for that, rather than claiming this tool itself produces a PDF file.
- `total` on an invoice is the net sum of `qty * unit_price` across all items — this tool does not apply VAT/Steuersätze; add tax handling manually in the invoice items if needed.
- Company details (name, address, tax ID, IBAN, number prefix) come from the plugin's own settings, not from tool input.
