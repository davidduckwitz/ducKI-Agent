---
name: datum-uhrzeit-tag
description: "Gibt Datum, Uhrzeit und/oder Wochentag aus. Steuerbar ueber skillInput." 
version: 1.0.0
script: script.js
---

# Datum/Uhrzeit/Tag Skill

## Zweck
Dieser Skill zeigt Datum, Uhrzeit und/oder Wochentag an.

## Trigger
Nutze diesen Skill automatisch bei Fragen wie:

- "Welchen Tag haben wir heute?"
- "Wie spaet ist es?"
- "Welches Datum ist heute?"
- "Welche Uhrzeit haben wir heute"
- "What day is it today?"
- "Current date and time"

## Ausfuehrungsregel
Bei diesen Anfragen zuerst diesen Skill ausfuehren, nicht auf Shell-Datumsbefehle ausweichen.

- Kein `date` Shell-Befehl verwenden.
- Stattdessen `skill_manage` mit `action: "execute"` und `name: "datum-uhrzeit-tag"` nutzen.
- Fuer reine Wochentag-Frage `input: { "showDay": true, "showDate": false, "showTime": false }` setzen.
- Fuer reine Uhrzeit-Frage `input: { "showTime": true, "showDate": false, "showDay": false }` setzen.
- Fuer reine Datumsfrage `input: { "showDate": true, "showTime": false, "showDay": false }` setzen.

## Verwendung
Der Skill liest optionale Werte aus `skillInput`:

- `showDate` (boolean): Datum ausgeben
- `showTime` (boolean): Uhrzeit ausgeben
- `showDay` (boolean): Wochentag ausgeben
- `locale` (string): Locale fuer Formatierung, z. B. `de-DE` oder `en-GB`

Wenn keiner der drei Schalter gesetzt ist, werden standardmaessig alle drei Informationen ausgegeben.

## Beispiele
```json
{ "showDate": true, "showTime": false, "showDay": true, "locale": "de-DE" }
```

```json
{ "showTime": true }
```

## Ausgabe
Das Script schreibt die Ausgabe in `console.log` und liefert ein Ergebnisobjekt zurueck.
