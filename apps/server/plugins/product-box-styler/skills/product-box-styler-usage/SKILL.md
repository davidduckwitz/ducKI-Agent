---
name: product-box-styler-usage
description: Nutzung des product_box_styler Tools - Shop-Produktboxen erkennen und CSS fuer eine eigene HTML-Vorlage generieren
---

# Product Box Styler

Erkennt die Produktbox (Produktkarte) einer Shop-Seite und erzeugt CSS, das eine vom Nutzer
bereitgestellte HTML-Vorlage optisch angleicht. Alles laeuft ueber ein Tool: `product_box_styler`,
gesteuert per `action`.

## Ablauf

1. `create_project` — Projekt anlegen: `name`, optional `shopUrl`, `analyzeType`
   (`heuristic` | `vision` | `combo`). Legt `data/projects/<id>/{template.html,style.css}` an.
2. `upload_template` — `id`, `templateHtml`. Speichert die Vorlage und meldet erkannte Klassen
   sowie das Rollen-Mapping. **Vorlagen-Konvention:** Elemente mit
   `data-pb="root|image|title|price|button|rating|badge|description"` markieren — das ist der
   verlaessliche Weg. Ohne diese Attribute wird per Tag-/Klassen-Namen geraten (z.B. `img`→image,
   `h1-h6`→title, Klasse enthaelt "price"→price), das kann fehlschlagen oder Rollen doppelt/gar
   nicht zuordnen.
3. `analyze` — `id`, optional `pageHtml` (bereits gerendertes HTML, z.B. vom Browser-Tool
   kopiert), optional `screenshotBase64` (fuer `analyzeType=vision`/`combo`-Fallback).
   - Ohne `pageHtml` wird `shopUrl` per einfachem `fetch()` geladen — funktioniert nur bei
     serverseitig gerendertem/statischem HTML. Bei JS-lastigen Shops (SPA-Frameworks) das
     gerenderte HTML selbst besorgen (Browser-Tool) und als `pageHtml` mitgeben.
   - `analyzeType=heuristic`: liest `<style>`-Bloecke und Inline-`style=""` des geladenen HTML
     aus. Das ist **authored CSS**, keine vollstaendig kaskadierte/computed Style (kein
     Headless-Browser im Plugin, externe Stylesheets werden nicht nachgeladen). Fuer die meisten
     Shop-Themes reicht das, bei stark aus externen CSS-Dateien gespeisten Themes kann die
     Konfidenz niedrig ausfallen.
   - `analyzeType=vision`: braucht zwingend `screenshotBase64`, sonst Fehler. Liefert nur
     beschreibende Hinweise (keine exakten CSS-Werte), die als Kommentar in die generierte CSS
     geschrieben werden.
   - `analyzeType=combo`: erst heuristic, bei Konfidenz < 0.5 zusaetzlich vision (falls
     Screenshot mitgegeben).
   - Schreibt `data/projects/<id>/style.css` und liefert einen `mappingReport` (welche Rollen
     gemappt/ungemappt sind).
4. `get_project` / `list_projects` / `update_project` / `delete_project` fuer Verwaltung.

## Wann dieses Tool nutzen

Wenn der Nutzer eine Shop-Seite als Vorbild fuer das Design einer eigenen Produktkarten-Vorlage
nennt ("mach meine Produktbox wie auf X", "style meine Karte nach diesem Shop"). Erst
`create_project`, dann Vorlage per `upload_template` sichern, dann `analyze` — danach das
generierte CSS aus `get_project` (`styleCss`) an den Nutzer zurueckgeben oder direkt in dessen
Projekt einbauen.
