---
name: tts-studio-usage
description: How to turn text into a downloadable audio file (WAV or MP3) with the tts_studio tool. Use when the user wants text read aloud and saved/exported as an audio file, a voice-over, an audiobook chapter or a podcast snippet - not for normal spoken chat replies.
---

# Text to an audio file

The `tts_studio` tool uses DucKI's internal TTS system (the same engines and settings as the Voice tab) and writes the result as a file into the plugin's export folder. Long texts are split at sentence boundaries and joined automatically.

```
[TOOL:tts_studio({"action": "synthesize", "text": "Willkommen bei DucKI ...", "format": "mp3", "title": "Begruessung"})]
[TOOL:tts_studio({"action": "synthesize", "text": "...", "format": "wav", "provider": "chatterbox", "voice": "my-voice", "language": "de"})]
[TOOL:tts_studio({"action": "list", "limit": 10})]
[TOOL:tts_studio({"action": "get", "id": 3})]
[TOOL:tts_studio({"action": "delete", "id": 3})]
[TOOL:tts_studio({"action": "synthesize", "text": "...", "speed": 0.9, "emotion_style": "calm"})]
[TOOL:tts_studio({"action": "voices", "provider": "chatterbox"})]
[TOOL:tts_studio({"action": "status"})]
```

- `format` is `mp3` or `wav`; omit it, `provider`, `voice` and `language` to use the plugin settings.
- The result's `export.path` is the absolute file path, `export.duration_sec` the length. Tell the user the file name and that it can be played and downloaded on the **TTS-Studio** page in the sidebar.
- Pick `voice` from `action=voices` (engine voices plus the shared reference-voice library). New reference voices are added by the user on the TTS-Studio page (upload) - you cannot upload audio yourself.
- `speed`, `pitch` (0.5-2) and `volume` (0-2) are applied via ffmpeg; `emotion_style` is neutral/calm/empathetic/cheerful/excited.
- The plugin has its own copies of all engine settings (server URLs, API keys, Piper parameters ...); they apply only to this plugin, the agent's Voice tab stays untouched.
- Never pass `include_audio` or `audio_base64` - that returns megabytes of base64 and is only for the plugin's own page.
- MP3 export (and converting between formats) needs ffmpeg. If the tool reports ffmpeg missing, tell the user to install the ffmpeg component in the settings or export as WAV instead.
- If a TTS error mentions an unreachable server (Chatterbox, Qwen3, Pocket), the local TTS server isn't running - the user starts it in the Voice tab.
