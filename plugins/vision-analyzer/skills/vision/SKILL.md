---
name: vision-analyzer
description: Nutze die visuelle Wahrnehmung des integrierten DucKI-Browsers, wenn der Benutzer nach sichtbaren Inhalten, Personen, Objekten, Text, QR-Codes oder dem Zustand einer Browser-Seite fragt.
---

# Vision Analyzer

Verwende das Tool `vision_analyzer` für visuelle Fragen zum integrierten Browser. Arbeite standardmäßig local-first und vermeide unnötige Vision-LLM-Aufrufe.

- `sessions`: verfügbare Browser-Sessions auflisten.
- `start`: kontinuierliche Frame-Beobachtung einer Session starten.
- `state`: letzten bekannten Vision-Zustand lesen, ohne neue Analyse anzustoßen.
- `local_scan`: aktuelles Frame ausschließlich mit lokalen Fähigkeiten analysieren. Funktioniert ohne Zusatzpakete; mit installiertem OCR-Pack kommt lokale Texterkennung hinzu.
- `scan`: aktuelles Frame mit dem konfigurierten Vision-Modell analysieren. Im Local-only-Modus absichtlich gesperrt.
- `query`: konkrete visuelle Frage an das Vision-Modell stellen. Im Local-only-Modus absichtlich gesperrt.
- `dependency_status`: Status der optionalen lokalen Pakete lesen.
- `dependency_install`: nur die fest definierten Packs `ocr` oder `onnx` installieren. Nicht selbstständig installieren, außer der Benutzer fordert das ausdrücklich an.
- `dependency_remove`: optionales lokales Pack wieder entfernen.
- `stop`: Beobachtung stoppen.

## Local-first Reihenfolge

1. Nutze `state`, wenn die Information bereits frisch genug ist.
2. Nutze `local_scan` für QR, Bewegung und lokal verfügbare Texterkennung.
3. Nur wenn lokale Daten die Frage nicht beantworten und Local-only deaktiviert ist, nutze `scan` oder `query`.
4. Installiere optionale Abhängigkeiten nur nach expliziter Benutzerentscheidung; das Plugin muss ohne sie funktionsfähig bleiben.

Das Zero-Dependency-Profil benötigt keine zusätzlichen Node-Pakete und kein LLM. QR-Codes werden im Plugin-Frontend über die Browser-`BarcodeDetector`-API erkannt, Bewegung über Frame-Differenzen im Canvas. Das optionale OCR-Pack nutzt Tesseract.js mit lokal installiertem deutschen Sprachmodell. Das optionale ONNX-Pack stellt `onnxruntime-node` und `sharp` als Basis für spätere lokale Object Detection bereit.
