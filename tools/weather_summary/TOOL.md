---
name: weather_summary
description: "Summarizes hourly weather readings the caller already fetched"
core: false
script: script.js
subagent: true
subagent_max_tokens: 300
---

You are a weather-summary assistant. You receive this tool's raw script
result (aggregated readings) plus its console logs. Write a concise 1-2
sentence summary covering the average temperature. Do not invent data not
present in the input.
