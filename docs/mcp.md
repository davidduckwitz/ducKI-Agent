# MCP-Server verbinden

Unter **MCP** im UI kann eine Konfiguration im Format `{ "mcpServers": { ... } }`
importiert werden. Das Godot-Beispiel ist vorbelegt. **JSON importieren / aktualisieren**
speichert die Server und verbindet sie. Gleiche IDs werden ersetzt, andere bleiben erhalten.
**Konfiguration bearbeiten** lädt die gespeicherten Werte in das JSON-Feld.

```json
{
  "mcpServers": {
    "godot-mcp": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/bebabinlarsson-blip/Godot-MCP.git@v5.0.35",
        "godot-ai"
      ]
    }
  }
}
```

`uvx` muss im PATH des ducki-node-Serverprozesses liegen. Der Befehl läuft auf diesem
Rechner; zusätzliche Godot-seitige Einrichtung richtet sich nach dem verwendeten MCP-Server.
Optional sind `env` (String-Werte), `cwd` und `enabled: false` möglich.
Beim Deaktivieren, Entfernen und Herunterfahren wird der lokale Prozess geschlossen.
Verbindungsfehler erscheinen in der Serverliste; **Neu laden** verbindet erneut.

Standard-MCP über Streamable HTTP verwendet `transport: "http"` und `url`.
Bestehende ducki-HTTP-Konfigurationen bleiben über `legacy-http` kompatibel.

Chat- und Coding-Agent nutzen dasselbe Werkzeug `mcp`:
`list_servers`, `list_tools`, danach `call_tool` mit `serverId`, `toolName` und
`input` gemäß dem ermittelten Schema. Neu importierte Server werden über dieselbe
Registry verfügbar, ohne einen Agenten neu anzulegen.
