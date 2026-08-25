---
name: vision-analyzer
description: Nutze die lokale visuelle Wahrnehmung des integrierten DucKI-Browsers für sichtbare Inhalte, Personen, Objekte, Text, QR-Codes, Bewegung, Umgebung und den Zustand einer Browser-Seite.
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
- `ocr`: Tesseract.js + deutsches Sprachmodell für lokale Texterkennung. Der Sprachpfad wird lokal aufgelöst; OCR soll keinen CDN-Download benötigen.
- `onnx`: ONNX Runtime + Sharp als lokale Vision Runtime.
- `yolo26n-coco`: lokales YOLO26n-ONNX-Modell für Person + COCO-80-Objekte.

Wenn ONNX Runtime und ein Objektmodell installiert sind, läuft die Person-/Objekterkennung während einer aktiven Browser-Session automatisch im Worker Thread. `state` enthält die neuesten Ergebnisse unter `detections`.

Die lokale Pipeline ergänzt die Detektionen außerdem um:
- `trackId`: leichte IoU-basierte Wiedererkennung desselben Objekts über aufeinanderfolgende Frames.
- `scene`: lokale Umgebungs-Hypothese aus erkannten Objekten, z. B. `office`, `kitchen`, `bedroom`, `living room`, `bathroom`, `dining area`, `street / traffic` oder `outdoor / park`.

Die Szene ist eine Heuristik und keine semantische Vision-Modell-Aussage. Bei Unsicherheit oder komplexen Fragen nicht so tun, als wäre sie sicher erkannt.

## Installation und Sicherheit

`dependency_install`, `dependency_remove`, `model_install` und `model_remove` verändern die lokale Installation. Diese Aktionen niemals eigenständig ausführen. Nur ausführen, wenn der Benutzer dies ausdrücklich verlangt oder den entsprechenden Button im Plugin-Frontend betätigt.

Modelle werden erst nach ausdrücklicher Installation heruntergeladen. Der Model Manager prüft den Download mit einem fest hinterlegten SHA-256-Hash und zeigt die Modell-Lizenz an.

Das Plugin benötigt die Manifest-Permission `browser.frames`. Ohne diese Permission wird die Browser-Capability weder an das Plugin-Frontend noch über `context.agent.browser` weitergereicht.

Bevorzuge lokale Ergebnisse. Ein Vision-LLM ist eine optionale Eskalationsstufe für komplexe Fragen, die aus QR/OCR/Objekterkennung/Tracking/Bewegung/Szenen-Heuristik nicht zuverlässig beantwortet werden können.
