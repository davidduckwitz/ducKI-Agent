---
name: social-media-usage
description: How to analyze a video or image from a URL (YouTube, TikTok, Instagram, X/Twitter, or a direct image/video link) with the social_media tool - transcript + scene frames for video, vision analysis for images, and follow-up questions. Use when the user shares a social-media/video link and asks what it shows, wants it summarized, transcribed, or asks a specific question about it.
---

# Social media video/image analysis

The `social_media` tool downloads a video or image from a URL and analyzes it: for video, it
extracts the spoken transcript (whisper) plus a handful of sampled frames; for an image, it runs
a vision pass directly. Everything is organized into **projects** and stored in the plugin's OWN
SQLite database - nothing is written to the main conversation database.

YouTube, TikTok, Instagram, X/Twitter and hundreds of other sites are supported via yt-dlp
(automatic - no site-specific handling needed); a plain `.mp4`/`.jpg`/... URL also works via a
direct download. Only single videos/images are fetched, never a playlist or channel.

## Workflow

1. Make sure a project exists (ask the user for a name if none does yet, or reuse an existing one):
```
[TOOL:social_media({"action": "list_projects"})]
[TOOL:social_media({"action": "add_project", "name": "Recherche"})]
```

2. Add the item - `question` is optional but usually worth passing right away so the first
   analysis already answers what the user asked, instead of a generic description:
```
[TOOL:social_media({"action": "add_item", "project_id": 1, "url": "https://www.tiktok.com/@.../video/...", "question": "Was macht die Person in dem Video?"})]
```
This can take up to ~1 minute (download, whisper transcription, vision analysis) - say so before
calling it so the user isn't left wondering. The result's `item.status` is `ready` or `error`;
on `error` check `item.error` for why (e.g. unsupported URL, file too large).

3. Follow-up questions reuse the ALREADY-downloaded frames/transcript - no re-download, even
   after the video file itself has been deleted:
```
[TOOL:social_media({"action": "ask_question", "item_id": 7, "question": "Welche Marke ist auf dem Shirt zu sehen?"})]
```

4. Browsing: `list_items` (optionally `project_id`), `get_item` (full detail incl. transcript
   and all Q&A so far).

5. Deleting: `delete_video_file` removes only the downloaded video blob to free disk space -
   the transcript, frames and Q&A history stay intact and `ask_question` still works afterward.
   `delete_item` removes the item entirely. `delete_project` cascades to all its items.

## Notes

- Video length/size is capped (~3 min sampled, ~80MB download) - a longer video is truncated,
  not rejected; `item.truncated`-equivalent shows up as a shorter `duration_sec` than the
  original if so.
- If `add_item` errors with "URL wird nicht unterstützt", the link isn't a yt-dlp-supported page
  and isn't a direct image/video URL either (e.g. a private/login-gated post) - tell the user
  instead of retrying blindly.
