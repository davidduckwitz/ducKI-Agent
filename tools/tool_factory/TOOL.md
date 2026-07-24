---
name: tool_factory
description: "Register new tools at runtime, list what an owner has created, and clean up tools/tasks that owner no longer needs"
core: true
category: meta
---

## Zweck
Lässt den Agenten selbst neue, sandboxed Tools registrieren
(`action: register`) und wieder aufräumen (`unregister`/`cleanup`,
Ownership-Tag-basiert). Grundlage für dynamisch erzeugte Tools, die in der
`dynamic_tools`-Tabelle persistiert werden.

## Core-Tool
Dieses Tool ist als Core markiert und kann in den Settings nicht deaktiviert
werden — es ist der Mechanismus, über den der Agent seine eigenen
Fähigkeiten erweitert.
