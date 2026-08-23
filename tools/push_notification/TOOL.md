---
name: push_notification
description: "Send the user a browser push notification via the Cloud Voice-App, delivered even if that page isn't open/focused"
core: false
category: integration
---

## Zweck
Schickt eine Browser-Push-Benachrichtigung an die Voice-App des Nutzers (siehe
PushNotificationController im ducki-cloud-v1-Repo) - z.B. wenn eine lang laufende
Aufgabe fertig ist, waehrend die Seite nicht offen ist.

## Optionales Tool
Standardmäßig deaktiviert. In den Settings unter "Tools" aktivieren. Setzt zusätzlich
voraus, dass der Nutzer einen Cloud-API-Key verbunden UND Benachrichtigungen in der
Voice-App aktiviert hat (Glocken-Symbol) - sonst schlägt der Aufruf fehlerhaft, aber
folgenlos fehl.
