---
name: video-editor-usage
description: How to cut, arrange, subtitle and render video clips - or compose an entire video from scratch with generated scenes, title cards, text/shape overlays and mixed-in audio, no uploaded footage required - with the video_editor tool. Use when the user uploads/shares a video and asks you to cut out a section, wants auto-generated subtitles, wants you to find the best moment in raw footage, wants several clips assembled with transitions, or wants you to create a short video (title card, narrated text over a background, etc.) purely from an idea.
---

# Video editor

The `video_editor` tool is an agentic, code/data-driven video editor (ffmpeg-based, inspired by
what tools like Remotion do - NOT a port of them). Everything lives in **projects** in the
plugin's own SQLite database: **clips** (uploaded footage) and/or **scenes** (generated, no
footage) on one ordered **timeline** per project, timeline-relative **captions** and freeform
**overlays** (text/shapes), extra **audio tracks**, and background **render** jobs.

A timeline item is either:
- `{type:'clip', clip_id, source_start_sec, source_end_sec, order, transition_out?, effects?}` -
  a trimmed segment of uploaded footage.
- `{type:'scene', duration_sec, background:{kind:'color'|'gradient'|'image', value}, order, transition_out?, effects?}` -
  a GENERATED segment, no footage at all. `background.value` is a hex color for `kind:'color'`,
  `{from, to, direction?}` (hex colors, `direction:'horizontal'|'vertical'`) for `kind:'gradient'`,
  or a `background_id` (from `add_scene_background_image`) for `kind:'image'`.

This means you can build an entire video with ZERO uploaded footage - title card, a scene with
narration-timed captions, another scene, outro - purely through tool calls.

## Core workflow (with uploaded footage)

1. Make sure a project exists, then upload each source clip (base64, raw or a
   `data:video/mp4;base64,...` URL) - this only saves the file, probes duration/resolution and
   makes a thumbnail, it does NOT transcribe or analyze:
```
[TOOL:video_editor({"action": "add_project", "name": "Recap"})]
[TOOL:video_editor({"action": "add_clip", "project_id": 1, "video_base64": "...", "original_name": "clip1.mp4"})]
```

2. Understand a clip before cutting it, as needed:
   - `transcribe_clip` (clip_id) - real Whisper transcription with per-segment timestamps
     (`transcript_segments_json` -> `[{startSec, endSec, text}, ...]`) - needed for captions.
   - `analyze_clip` (clip_id, question?) - one AI scene/content description, stored as `ai_summary`.
   - `suggest_highlight` (clip_id) - AI-suggested strongest moment; returns `{start_sec, end_sec, raw}`
     when it could parse two numbers, or `{hint: <raw text>}` otherwise (free-text from an LLM).

## Building the timeline (clips AND/OR scenes)

`set_timeline` REPLACES the whole cut list at once - always pass the full ordered array:
```
[TOOL:video_editor({"action": "set_timeline", "project_id": 1, "items": [
  {"type": "scene", "duration_sec": 2.5, "background": {"kind": "color", "value": "#0b0f19"}, "order": 0},
  {"type": "clip", "clip_id": 3, "source_start_sec": 4.5, "source_end_sec": 9.0, "order": 1,
   "transition_out": {"type": "crossfade", "duration_sec": 0.5}},
  {"type": "clip", "clip_id": 5, "source_start_sec": 0, "source_end_sec": 6.2, "order": 2,
   "effects": [{"type": "brightness", "value": 0.1}, {"type": "speed", "value": 1.5}]}
]})]
```
The same `clip_id` can appear more than once. `get_timeline` reads it back.

- `transition_out` (on an item, applies between IT and the next item): `{type, duration_sec}` with
  `type` one of `'none'` (default, hard cut), `'crossfade'`, `'wipe'`, `'fade_to_black'`.
  Crossfade/wipe OVERLAP the two neighboring segments by `duration_sec` (total render duration
  shrinks accordingly); fade_to_black does not overlap, it just fades the first segment to black
  and fades the next one in from black.
- `effects` (on an item): array of `{type, value?, duration_sec?}` -
  `fade_in`/`fade_out` (duration_sec), `brightness`/`contrast`/`saturation`/`blur` (value),
  `speed` (value, a multiplier - CLAMPED to 0.5-2.0, both video and audio, so the two stay in sync).

### Title cards & generated scenes (no footage)

`add_title_card` is the one-call convenience for the extremely common case - it appends a `scene`
item to the timeline AND creates a centered text overlay spanning it, in one call:
```
[TOOL:video_editor({"action": "add_title_card", "project_id": 1, "text": "Kapitel 1", "duration_sec": 3, "background_color": "#111318"})]
```
For anything more custom than a centered title (positioned text, background image/gradient,
shapes), build it from the primitives instead: append a `scene` item via `set_timeline`, then use
`add_overlay` (below) to place content on it - the overlay's `start_sec`/`end_sec` must fall
within that scene's position on the timeline (sum of the effective durations of everything before
it - `get_timeline` to check, or track it yourself as you append items).

For a `background.kind:'image'` scene, upload the image first:
```
[TOOL:video_editor({"action": "add_scene_background_image", "project_id": 1, "image_base64": "data:image/png;base64,..."})]
```
-> returns `background.id`, use that as `background.value`.

**Slideshow videos from generated images:** if the `image_gen` plugin is available, use it to create the
source stills instead of asking the user for images - generate one image per scene, then pass its `url`
straight through as `image_url` (NOT `image_base64` - keeps the base64 out of your context entirely):
```
[TOOL:image_gen({"action": "generate", "prompt": "..."})]  -> returns {url: "/api/plugins/image-gen/data/generated/<id>.png", ...}
[TOOL:video_editor({"action": "add_scene_background_image", "project_id": 1, "image_url": "/api/plugins/image-gen/data/generated/<id>.png"})]
```
For visual consistency across a multi-scene slideshow (same character/style/palette), pass the previous
scene's `image_gen` result `id` as `reference_id` on the next `generate` call (img2img instead of a fresh
random image) rather than generating each scene fully independently.

## Captions vs. overlays

Both are TIMELINE-relative (0 = start of the assembled cut) and burned in together on `render`
(captions rendered on top). They are separate mechanisms for separate purposes:

- **Captions** - transcript-derived, auto-timed, plain subtitle text (fixed bottom-center style).
  `generate_captions_from_clip` (project_id, clip_id, timeline_offset_sec) turns a transcribed
  clip's segments into caption rows shifted by wherever that clip sits on the timeline. After
  that: `list_captions` / `add_caption` (project_id, start_sec, end_sec, text) / `update_caption`
  (id, any of start_sec/end_sec/text) / `delete_caption` (id).
- **Overlays** - freeform, user/agent-placed text or shapes anywhere on the timeline, any position/
  size/color. `add_overlay` (project_id, type:'text'|'shape', start_sec, end_sec, x, y, width?,
  height?, z_index?, props) - **x/y/width/height are PERCENT (0-100) of the final resolution**, not
  pixels. `props` for `type:'text'`: `{content, font_size?, color?, background_color?, align?}`
  (`align:'center'` ignores x and horizontally centers). `props` for `type:'shape'`:
  `{shape_type:'rect'|'circle', color, opacity?, stroke_width?}`. Then `list_overlays` /
  `update_overlay` (id, ...) / `delete_overlay` (id).

## Extra audio tracks

Mixed into the final render at a given timeline position and volume, independent of each clip's
own embedded audio (sound effects, background music, narration you have as a separate file):
```
[TOOL:video_editor({"action": "add_audio_track", "project_id": 1, "audio_base64": "data:audio/mpeg;base64,...", "start_sec": 2.0, "volume": 0.6})]
```
Then `list_audio_tracks` / `update_audio_track` (id, start_sec?, volume?) / `delete_audio_track` (id).

## Rendering

Runs in the BACKGROUND, returns immediately with `{render_id}` - tell the user it can take a
while before calling it, then poll:
```
[TOOL:video_editor({"action": "render", "project_id": 1, "options": {"burn_captions": true}})]
[TOOL:video_editor({"action": "get_render", "id": 12})]
```
`burn_captions: true` burns in BOTH captions and overlays (the option name predates overlays but
covers both now). Poll `get_render` until `render.status` is `done` or `error`. On `done`,
`render.output_filename` is the file under this plugin's `data/renders/` folder, playable/
downloadable via `/api/plugins/video-editor/data/renders/<output_filename>`. If caption/overlay
burn-in itself failed but the render otherwise succeeded, status is still `done` but `render.error`
explains what happened (the video plays without them in that case) - check `render.error` even on
`done`.

## Notes

- `add_clip` is cheap (just save + probe + thumbnail); `transcribe_clip`/`analyze_clip`/
  `suggest_highlight` are the potentially-slow, explicit, LLM/whisper-backed steps - don't call
  them automatically for every clip unless the user's request actually needs it.
- Deleting: `delete_clip`/`delete_overlay`/`delete_audio_track` remove the row (+ file where
  applicable). `delete_project` cascades to everything in it (clips, captions, overlays, audio
  tracks, scene background images, renders - all with their files - and the timeline).
- If `set_timeline` or `render` reference a clip or scene background image that no longer exists,
  they return a clear error naming the missing id rather than silently skipping it.
