---
name: video-gen-usage
description: Generate short video clips locally with a text-to-video diffusion model (Wan2.1, LTX-Video, HunyuanVideo, or CogVideoX) via a local Python sidecar - no cloud, no external UI.
---

# Local Video Generation

The `video_gen` tool renders short video clips from a text prompt using a locally-run
text-to-video diffusion model. It is the sibling of `image_gen` (same setup/sidecar pattern) but
noticeably heavier: expect **minutes**, not seconds, per clip, and a real GPU with several GB of
free VRAM - CPU-only generation works in principle but is impractical in practice.

Use it when the user explicitly wants a generated video clip (not a slideshow of stills - for
that, generate images with `image_gen` and hand them to `video_editor`'s
`add_scene_background_image` instead, which is far faster and cheaper).

Generate a clip:
```
[TOOL:video_gen({"action": "generate", "prompt": "a wave crashing on a beach at sunset, slow motion, cinematic lighting"})]
```

Useful optional parameters: `negative_prompt`, `model` (override the plugin's default model for
one call: `wan2.1-1.3b`, `ltx-video`, `hunyuanvideo`, `cogvideox-2b`), `width`/`height`,
`num_frames`/`fps` (clip length in seconds = `num_frames / fps`), `steps`, `guidance_scale`,
`seed`. All of these default to model-specific published values when omitted - only override them
when the user explicitly wants to experiment, since each model's defaults are tuned for it
specifically (e.g. CogVideoX-2B defaults to a short ~6s/49-frame clip at 8fps; pushing frame count
way up multiplies generation time roughly linearly).

**Write prompts that describe motion, not just a scene.** Unlike image prompts, a good video
prompt should describe how the scene *changes* over time (camera movement, subject action,
transitions) - "a cat sitting on a windowsill" is a weak video prompt, "a cat turns its head to
look at the camera, then jumps down from the windowsill" is a good one. Always write in English.

The result contains a `url` (serves the full MP4 from this plugin's own storage). There is no
inline data-URL preview like `image_gen` returns for small images - video files are too large for
that, always reference the `url`.

List recent generations (paginated - returns `{items, total, limit, offset, hasMore}`, pass
`offset` to page further back):
```
[TOOL:video_gen({"action": "list", "limit": 10})]
```

If the user gives you only a rough/vague idea, `action=suggest_prompt` (`idea`) asks the LLM to
expand it into a proper motion-focused prompt, returning `{prompt, negative_prompt}`.

`action=delete` (`id`) permanently removes a generation (file + record) - only do this when the
user explicitly asks to delete something, never as cleanup on your own initiative.

**Important: a `generate` result gives you a URL, not sight of the clip.** To actually see what
was generated, call `analyze` with the `id` - this extracts one representative frame and runs it
through the app's active vision model:
```
[TOOL:video_gen({"action": "analyze", "id": "<id-from-generate-result>"})]
```
Use it whenever it matters that the clip is actually correct (about to hand it to the user, or the
result looks suspicious) - not needed for every routine generation. Pass a specific `question` for
something more targeted than a general description (note: it only sees ONE static frame, so it
cannot judge whether the motion itself looks good - only composition/subject/style).

- The first call in a session starts a local Python process and can take a while if the model
  isn't cached yet (first-time multi-GB download on top of the venv setup) - tell the user
  generation is starting, don't assume it failed if it takes several minutes.

**First-time setup (fully automatic, no manual pip commands needed):** if `generate` fails with an
error mentioning the environment is "noch nicht eingerichtet" / not set up, do this yourself
instead of asking the user to run shell commands:
```
[TOOL:video_gen({"action": "install"})]
```
This creates a Python venv and installs PyTorch (CUDA build if an NVIDIA GPU is detected,
otherwise CPU) plus diffusers/transformers/opencv - several minutes, multiple GB. Poll progress:
```
[TOOL:video_gen({"action": "status"})]
```
`status` returns `{ready, phase, log, error}`. Once `ready` is `true`, retry the original
`generate` call.

**Model weights are downloaded separately from the venv**, and are large (several GB to 25+ GB
per model) - the FIRST `generate` call for a given model downloads it automatically as part of
that call (which is why a first generation with a new model can take a very long time), or you can
pre-download deliberately with `action=install_model` (`model`) and poll `action=list_models` for
`downloading`/`download_error` per model. Prefer letting a `generate` call trigger the download
implicitly unless the user specifically wants to pre-download without generating yet.

- Don't call `stop_engine`/`unload_model` unless the user explicitly asks to free up GPU/RAM
  immediately - the sidecar shuts itself down automatically after being idle.
- If a model download fails with an error mentioning a gated repo or "not a valid model
  identifier", that's a Hugging Face access/authentication issue (several video models, e.g.
  HunyuanVideo, gate their repo) - tell the user to request/accept access on the model's page on
  huggingface.co and add a Hugging Face access token (huggingface.co/settings/tokens) in this
  plugin's `HF_TOKEN` setting, then retry.
- If the user asks to permanently remove a model's weights to free disk space, use
  `action=uninstall_model` (`model`) - it will re-download automatically next time it's used.
