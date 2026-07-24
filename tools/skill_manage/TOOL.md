---
name: skill_manage
description: "Manage markdown skills (create, patch, edit, delete, view, list, write_file, remove_file)"
core: true
category: meta
---

## Zweck
Verwaltet die SKILL.md-Dateien unter `skills/`, die dem Agenten zusätzliches
Verhalten/Wissen für bestimmte Aufgaben mitgeben. Erlaubt auch das Ausführen
eines an einen Skill angehängten Sandbox-Skripts (`action: execute`).

## Core-Tool
Dieses Tool ist als Core markiert und kann in den Settings nicht deaktiviert
werden — Skills sind der primäre Mechanismus, mit dem sich der Agent selbst
erweitert.
