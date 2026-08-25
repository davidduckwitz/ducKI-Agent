---
name: datum-uhrzeit
description: "Zeigt aktuelles Datum und Uhrzeit per Script."
version: 1.0.0
---

# Datum Uhrzeit Skill

Dieser Skill kann direkt JavaScript ausfuehren.

<script>
const now = new Date();
const formattedDateTime = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'full',
  timeStyle: 'long'
}).format(now);
console.log('Current Date & Time:', formattedDateTime);
</script>