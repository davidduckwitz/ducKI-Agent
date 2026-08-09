---
name: notes-usage
description: How to store and recall persistent notes with the notes tool. Use when the user asks to remember a note, save a reminder, jot something down, or list previously saved notes.
---

# Notes (persistent)

The `notes` tool stores notes in this plugin's OWN SQLite database (separate from the main app database, so it never bloats it).

Save a note:
```
[TOOL:notes({"action": "add", "text": "Zahnarzttermin am Freitag 10 Uhr"})]
```

List the most recent notes:
```
[TOOL:notes({"action": "list"})]
```

- `add` requires `text`; `list` returns up to the 20 most recent notes in `result.notes`.
- Report saved/listed notes back plainly; the data persists across restarts.
