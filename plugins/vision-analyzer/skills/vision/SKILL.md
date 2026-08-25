---
name: vision-analyzer
description: Nutze die lokale visuelle Wahrnehmung des integrierten DucKI-Browsers für sichtbare Inhalte, Personen, Objekte, Text, QR-Codes, Bewegung und den Zustand einer Browser-Seite.
---

# Vision Analyzer

Verwende das Tool `vision_analyzer` für visuelle Fragen zum integrierten Browser.

## Local-first Reihenfolge

1. `sessions`: verfügbare Browser-Sessions auflisten.
2. `start`: Frame-Beobachtung einer Session starten.
3. `state`: zuerst den vorhandenen Zustand lesen. Das ist billig und löst keine neue Analyse aus.
4. `local_scan`: wenn aktuelle lokale Wahrnehmung nötig ist.
5. `scan` oder `query` nur dann verwenden, wenn der Benutzer ausdrücklich Smart/Vision-LLM-Analyse möchte und `VISION_LOCAL_ONLY=false` ist.
6. `stop`: Beobachtung stoppen, wenn sie nicht mehr benötigt wird.

## Lokale Fähigkeiten

Ohne Zusatzinstallation:
- Browser-Live-Frames
- QR-Code-Erkennung im Plugin-Frontend
- Bewegungserkennung

Optional installierbar:
- `ocr`: Tesseract.js + deutsches Sprachmodell für lokale Texterkennung.
- `onnx`: ONNX Runtime + Sharp als lokale Vision Runtime.
- `yolo26n-coco`: lokales YOLO26n-ONNX-Modell für Person + COCO-80-Objekte.

Wenn ONNX Runtime und ein Objektmodell installiert sind, läuft die Person-/Objekterkennung während einer aktiven Browser-Session automatisch im Worker Thread. `state` enthält die neuesten Ergebnisse unter `detections`.

## Installation und Sicherheit

`dependency_install`, `dependency_remove`, `model_install` und `model_remove` verändern die lokale Installation. Diese Aktionen niemals eigenständig ausführen. Nur ausführen, wenn der Benutzer dies ausdrücklich verlangt oder den entsprechenden Button im Plugin-Frontend betätigt.

Modelle werden erst nach ausdrücklicher Installation heruntergeladen. Der Model Manager prüft den Download mit einem fest hinterlegten SHA-256-Hash und zeigt die Modell-Lizenz an.

Bevorzuge lokale Ergebnisse. Ein Vision-LLM ist eine optionale Eskalationsstufe für komplexe Fragen, die aus QR/OCR/Objekterkennung/Bewegung nicht zuverlässig beantwortet werden können.
