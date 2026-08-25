---
name: vision-analyzer
description: Nutze die lokale visuelle Wahrnehmung des integrierten DucKI-Browsers oder einer explizit freigegebenen Kamera für sichtbare Inhalte, Personen, Objekte, Text, QR-Codes, Bewegung und Umgebung.
---

# Vision Analyzer

Verwende das Tool `vision_analyzer` für visuelle Fragen zum integrierten Browser und für den letzten bekannten lokalen Kamera-Zustand.

## Local-first Reihenfolge

Für Browser-Sessions:
1. `sessions`: verfügbare Browser-Sessions auflisten.
2. `start`: Frame-Beobachtung einer Session starten.
3. `state`: zuerst den vorhandenen Zustand lesen. Das ist billig und löst keine neue Analyse aus.
4. `local_scan`: wenn aktuelle lokale Wahrnehmung nötig ist.
5. `scan` oder `query` nur dann verwenden, wenn der Benutzer ausdrücklich Smart/Vision-LLM-Analyse möchte und `VISION_LOCAL_ONLY=false` ist.
6. `stop`: Beobachtung stoppen, wenn sie nicht mehr benötigt wird.

Für Kamera:
- Die Kamera wird ausschließlich vom Benutzer im Plugin-Frontend gestartet.
- `state` mit `sessionId="camera:local"` kann den letzten bekannten lokalen Zustand lesen.
- `local_frame_detect` und `local_frame_scan` sind Transportaktionen des Plugin-Frontends für explizit bereitgestellte Kameraframes; der Agent soll keine Base64-Frames selbst erzeugen oder erfinden.
- `local_source_stop` entfernt den flüchtigen Zustand einer lokalen Quelle.

## Lokale Fähigkeiten

Ohne Zusatzinstallation:
- Browser-Live-Frames
- explizit gestartete Kamera-Live-Vorschau
- QR-Code-Erkennung im Plugin-Frontend
- Bewegungserkennung

Optional installierbar:
- `ocr`: Tesseract.js + deutsches Sprachmodell für lokale Texterkennung. Der Sprachpfad wird lokal aufgelöst; OCR soll keinen CDN-Download benötigen.
- `onnx`: ONNX Runtime + Sharp als lokale Vision Runtime.
- `yolo26n-coco`: lokales YOLO26n-ONNX-Modell für Person + COCO-80-Objekte.

Wenn ONNX Runtime und ein Objektmodell installiert sind, läuft die Person-/Objekterkennung während einer aktiven Browser-Session automatisch im Worker Thread. Bei aktiver Kamera sendet das Plugin gedrosselt einzelne komprimierte Frames an dieselbe lokale ONNX-Pipeline. Die Kamera wird nicht aufgezeichnet.

`state` enthält die neuesten Ergebnisse unter `detections`.

Die lokale Pipeline ergänzt die Detektionen außerdem um:
- `trackId`: leichte IoU-basierte Wiedererkennung desselben Objekts über aufeinanderfolgende Frames.
- `scene`: lokale Umgebungs-Hypothese aus erkannten Objekten, z. B. `office`, `kitchen`, `bedroom`, `living room`, `bathroom`, `dining area`, `street / traffic` oder `outdoor / park`.

Die Szene ist eine Heuristik und keine semantische Vision-Modell-Aussage. Bei Unsicherheit oder komplexen Fragen nicht so tun, als wäre sie sicher erkannt.

## Installation und Sicherheit

`dependency_install`, `dependency_remove`, `model_install` und `model_remove` verändern die lokale Installation. Diese Aktionen niemals eigenständig ausführen. Nur ausführen, wenn der Benutzer dies ausdrücklich verlangt oder den entsprechenden Button im Plugin-Frontend betätigt.

Modelle werden erst nach ausdrücklicher Installation heruntergeladen. Der Model Manager prüft den Download mit einem fest hinterlegten SHA-256-Hash und zeigt die Modell-Lizenz an.

Das Plugin benötigt:
- `browser.frames` für den kontrollierten Zugriff auf Browser-Sessions und Browser-Frames.
- `media.camera` damit der Host dem Plugin-iframe überhaupt die Browser-Kamera-Permission freigeben darf.

Die Kamera wird nie automatisch beim DucKI-Start aktiviert. `getUserMedia()` wird erst ausgelöst, wenn der Benutzer im Vision-Frontend auf die Kamera-Quelle wechselt bzw. sie startet.

Bevorzuge lokale Ergebnisse. Ein Vision-LLM ist eine optionale Eskalationsstufe für komplexe Browser-Fragen, die aus QR/OCR/Objekterkennung/Tracking/Bewegung/Szenen-Heuristik nicht zuverlässig beantwortet werden können. Smart/LLM-Kameraanalyse ist derzeit bewusst nicht automatisch aktiviert.
