---
name: filesystem
description: "Read, write, delete, list files and directories. REQUIRED: Always provide 'action' and 'path' parameters."
core: true
category: filesystem
---

## Zweck
Dateisystem-Operationen (read/write/append/delete/list/mkdir/exists/stat/
move/copy), standardmäßig auf `shared-workspace` beschränkt.

## Core-Tool
Dieses Tool ist als Core markiert und kann in den Settings nicht deaktiviert
werden — der Standard-System-Prompt setzt voraus, dass der Agent Dateien im
Arbeitsbereich lesen/schreiben kann.
