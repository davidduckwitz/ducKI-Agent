---
name: docs-generator-usage
description: How to create Markdown document templates with placeholders and generate offers/contracts/reports from them using the docs_generator tool. Use when the user wants to draft an Angebot, Vertrag, or Report from a reusable template.
---

# Document generator

The `docs_generator` tool stores Markdown templates (with `{{placeholder}}` tokens) and generated documents in this plugin's OWN SQLite database. There is no external PDF library — a generated document is rendered as clean HTML that the plugin's frontend page prints via the browser's "Print → Save as PDF", same approach as the invoicing plugin.

Create a template once:
```
[TOOL:docs_generator({"action": "add_template", "name": "Standard-Angebot", "type": "Angebot", "body_markdown": "# Angebot für {{kunde}}\n\nSehr geehrte/r {{ansprechpartner}},\n\nwir bieten Ihnen an:\n\n- {{leistung}}\n\nGesamtpreis: {{preis}} €\n\nGültig bis {{gueltig_bis}}."})]
```

Then generate a filled document from it as often as needed:
```
[TOOL:docs_generator({"action": "generate_document", "template_id": 1, "name": "Angebot Musterfirma", "data": {"kunde": "Musterfirma GmbH", "ansprechpartner": "Frau Beispiel", "leistung": "Website-Relaunch", "preis": "4500", "gueltig_bis": "30.09.2026"}})]
```

- Supported Markdown in templates: `#`/`##`/`###` headings, `**bold**`, `*italic*`, `[text](url)` links, `-` bullet lists, `1.` numbered lists, and plain paragraphs. Nothing more elaborate (no tables/images) — keep templates simple.
- `{{key}}` in the template is replaced with `data.key`; a placeholder with no matching data key is left as-is in the output, so double-check the result before sending it to anyone.
- `list_templates`/`list_documents`/`get_template`/`get_document`/`delete_template`/`delete_document` manage what's stored. Point the user to the plugin's own page to view/print a generated document — this tool only stores and renders the HTML, it doesn't produce a PDF file by itself.
