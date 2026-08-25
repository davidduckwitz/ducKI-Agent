# Vision Analyzer models

This directory intentionally contains no model binaries in Git.

Models are downloaded only after an explicit click in the Vision Analyzer frontend (or an explicit `model_install` tool request). The plugin verifies each download against the SHA-256 value hard-coded in `tools/vision.js` before atomically placing the file here.

Current catalog:
- `yolo26n-coco` — YOLO26n ONNX, COCO-80 object detection, third-party export of Ultralytics YOLO26.
- Model license: AGPL-3.0 (shown in the frontend before/after installation).
- The plugin code remains separately licensed under the repository/plugin license; model license terms apply to the downloaded model itself.

Do not commit downloaded `.onnx` files.
