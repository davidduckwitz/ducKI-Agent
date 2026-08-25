---
name: vision-analyzer
description: Nutze die visuelle Wahrnehmung des integrierten DucKI-Browsers, wenn der Benutzer nach sichtbaren Inhalten, Personen, Objekten, Text, QR-Codes oder dem Zustand einer Browser-Seite fragt.
---

# Vision Analyzer

Verwende das Tool `vision_analyzer` für visuelle Fragen zum integrierten Browser.

- `sessions`: verfügbare Browser-Sessions auflisten.
- `start`: kontinuierliche Frame-Beobachtung einer Session starten.
- `state`: letzten bekannten Vision-Zustand lesen, ohne neue Analyse anzustoßen.
- `scan`: aktuelles Frame strukturiert analysieren.
- `query`: eine konkrete visuelle Frage zum aktuellen Frame stellen.
- `stop`: Beobachtung stoppen.

Bevorzuge `state`, wenn ein frischer Zustand vorhanden ist. Nutze `scan` oder `query` nur wenn neue visuelle Information benötigt wird, da diese Aktionen ein Vision-Modell aufrufen können. QR-Codes können zusätzlich im Plugin-Frontend lokal über die Browser BarcodeDetector API erkannt werden.
