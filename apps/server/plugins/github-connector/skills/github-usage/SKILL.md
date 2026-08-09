---
name: github-usage
description: Wann und wie das `github`-Tool des GitHub-Connectors genutzt wird (Profil, eigene Repos, Repo-Suche).
---

# GitHub-Connector nutzen

Das `github`-Tool fragt die GitHub-API im Namen des verbundenen Kontos ab. Der Zugriffstoken
liegt verschlüsselt in den Plugin-Einstellungen; du musst ihn nie sehen oder abfragen.

## Aktionen

- `action: "whoami"` — gibt das eigene Profil zurück (login, name, public_repos, followers).
- `action: "list_repos"` — listet die eigenen Repositories (neueste zuerst). Optional `limit` (1-50).
- `action: "search_repos"` — durchsucht öffentliche Repos. Erfordert `q` (Suchbegriff), optional `limit`.

## Hinweise

- Ist kein Token konfiguriert, liefert das Tool einen `error`. Weise die Nutzer:in dann darauf hin,
  in den Plugin-Einstellungen einen Personal Access Token zu hinterlegen oder „Connect with GitHub“
  zu verwenden.
- Antworten kompakt zusammenfassen (z. B. Repo-Namen + Sterne), nicht das rohe JSON ausgeben.
