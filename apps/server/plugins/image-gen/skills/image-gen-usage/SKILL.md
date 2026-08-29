---
name: image-gen-usage
description: Generate images and thumbnails locally with a small diffusion model (SD-Turbo, SDXL-Turbo, or Flux-1-schnell) via a local Python sidecar - no cloud, no external UI.
---

# Local Image Generation

The `image_gen` tool renders images from a text prompt using a small local diffusion model. Use it
proactively whenever the user's task would benefit from a generated image and they haven't supplied
one themselves - most commonly:

- **Video thumbnails**: after finishing a video edit/render (e.g. with the `video_editor` tool), offer
  or directly generate a matching thumbnail image instead of asking the user to make one.
- **Header/cover graphics**: for notes, articles, presentations, or social posts that need a visual but
  none was provided.
- **Illustrative images**: whenever a concept is easier to convey with a generated image than text alone.
- **Slideshow video scenes**: if the `video_editor` tool is available and the user wants a video with no
  source footage, generate the stills here and hand them to `video_editor`'s `add_scene_background_image`
  via `image_url` (not `image_base64` - see that tool's own skill for the exact pattern).

Generate an image:
```
[TOOL:image_gen({"action": "generate", "prompt": "minimalist flat-design thumbnail, a rocket launching over mountains, bold colors, no text"})]
```

Useful optional parameters: `negative_prompt`, `width`/`height` (default 512x512 - use 1280x720 or
1920x1080 for a 16:9 video thumbnail), `seed` (reproducible results), `model` (override the plugin's
default model for one call: `sd-turbo`, `sdxl-turbo`, or `flux-schnell`), `steps` and `guidance_scale`
(CFG). Defaults for `steps`/`guidance_scale` are model-dependent (very low, e.g. 1-4 steps / CFG 0, for
the turbo/schnell models this plugin ships) - only override them when the user explicitly wants to
experiment with quality/speed tradeoffs, since pushing turbo/schnell models to higher CFG usually makes
results WORSE (they're distilled specifically for CFG 0), not better. If you switch to a non-distilled
model that actually benefits from CFG, ~7-9 is a typical starting point.

The result contains a `url` (serves the full PNG from this plugin's own storage) and, for small images,
a `thumbnail_data_url` you can reference directly. Always write good, specific, English-language prompts
- diffusion models respond far better to English than other languages, translate the user's request if
needed. Mention style, composition, and mood explicitly (e.g. "flat design", "photorealistic",
"watercolor", "no text in the image" if text tends to render garbled).

**Editing an existing image instead of generating a fresh random one:** pass `reference_id` (the `id` from
a previous `generate`/`list` result) to run img2img - the reference image is altered guided by `prompt`
instead of starting from noise. `strength` (0-1, default 0.6) controls how much changes; low (~0.2-0.4)
keeps composition/colors close to the reference, high (~0.7-0.9) allows major changes while still taking
some cues from it. Use this for:
- Iterating ("make it darker", "add a hat") without losing what already worked.
- Keeping a character/style/palette consistent across MULTIPLE images (e.g. a slideshow video's scenes,
  or a set of related illustrations) - generate the first one normally, then chain each next one off the
  previous via `reference_id` rather than generating each independently.
If the reference isn't one of your own prior generations, pass `reference_image` (base64/data-URL) instead
- but prefer `reference_id` whenever possible, it avoids putting image bytes through your own context.

List recent generations (paginated - returns `{items, total, limit, offset, hasMore}`, pass `offset`
to page further back):
```
[TOOL:image_gen({"action": "list", "limit": 10})]
[TOOL:image_gen({"action": "list", "limit": 10, "offset": 10})]
```

Upscale or sharpen an existing generation (plain image processing, NOT an AI model - instant, no
download, works even before the diffusion model has ever loaded):
```
[TOOL:image_gen({"action": "upscale", "id": "<id>", "scale": 2})]
[TOOL:image_gen({"action": "sharpen", "id": "<id>", "sharpen_amount": 150})]
```
Both create a NEW generation (linked via `reference_id`) rather than overwriting the original.
Use `upscale` when the user wants a bigger/higher-resolution version of something already
generated (e.g. before using it as a video thumbnail); use `sharpen` when an image looks slightly
soft/blurry. Don't reach for these by default - only when the user asks, or a generated image is
visibly too small/soft for its intended use.

If the user gives you only a rough/vague idea, you can ask the LLM itself to expand it into a proper prompt
before generating - `action=suggest_prompt` (`idea`) returns `{prompt, negative_prompt, width, height}`
(usually not necessary if you can just write a good prompt yourself, but useful when the user explicitly
wants prompt-drafting help, or as a starting point you then refine).

`action=delete` (`id`) permanently removes a generation (file + record) - only do this when the user
explicitly asks to delete something, never as cleanup on your own initiative.

**Important: a `generate` result gives you a URL, not sight of the image.** Nothing in the chat pipeline
automatically shows you a tool result's image data - to actually SEE what you generated, call `analyze`
with the `id` from the `generate`/`list` result:
```
[TOOL:image_gen({"action": "analyze", "id": "<id-from-generate-result>"})]
```
This runs the image through the app's active vision model and returns a text description you can read.
Use it whenever it matters that the image is actually correct, not just "some PNG got created":
- After generating a thumbnail or illustration you're about to hand to the user or use elsewhere - verify
  it matches the prompt and doesn't contain garbled/unreadable text (diffusion models render text poorly).
- If the user asks "how does it look?" or asks you to describe/critique a generation.
- If a generation looks suspicious (e.g. you asked for something specific and want to confirm before
  presenting it).
You don't need to `analyze` every single generation - for routine thumbnails where "close enough" is fine,
skip it and just return the URL. Pass a specific `question` (e.g. "Is the text in this image readable?" or
"Does this match a dark, moody vibe?") when you need something more targeted than a general description.

- The first call in a session starts a local Python process and can take up to ~90 seconds if the model
  isn't cached yet (first-time download) - tell the user generation is starting, don't assume it failed
  if it takes a while.

**First-time setup (fully automatic, no manual pip commands needed):** if `generate` fails with an error
mentioning the environment is "noch nicht eingerichtet" / not set up, do this yourself instead of asking
the user to run shell commands:
```
[TOOL:image_gen({"action": "install"})]
```
This creates a Python venv and installs PyTorch (CUDA build if an NVIDIA GPU is detected, otherwise CPU)
plus diffusers/transformers - it takes several minutes and downloads multiple GB. Tell the user setup has
started and will take a few minutes, then poll progress:
```
[TOOL:image_gen({"action": "status"})]
```
`status` returns `{ready, phase, log, error}`. Once `ready` is `true` (or `phase` is `"done"`), retry the
original `generate` call. If `phase` is `"error"`, share the `error` message with the user - do not retry
`install` in a loop.

- Don't call `stop_engine` unless the user explicitly asks to free up GPU/RAM immediately - the sidecar
  shuts itself down automatically after being idle.
- If `generate` fails with an error mentioning "not a valid model identifier" (seen with
  `flux-schnell`), that's a Hugging Face auth/rate-limit issue, not a broken model name - tell the
  user to add a Hugging Face access token (huggingface.co/settings/tokens) in this plugin's `HF_TOKEN`
  setting, then retry.
