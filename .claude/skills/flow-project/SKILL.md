---
name: flow-project
description: Run a film, still or narration project through flow-mcp and keep every file it makes in flow-mcp/projects/<project>/. Use whenever the user asks for new stills, shots, characters, narration or a final render with Google Flow, or continues an existing project.
---

# Flow project workflow

Every piece of work is one **project** with one short kebab-case name (for example `pip-lamplighter`).
Everything that project produces lives in `flow-mcp/projects/<project>/` and nowhere else.
`projects/` is git-ignored; never commit media.

## Start of a project

1. `flow_status`. Relay any hint and stop if Flow is not ready. `output_root` must be `<repo>/projects`.
2. Choose the project name once and say it to the user. Reuse an existing folder in `projects/` when the user is
   continuing earlier work.
3. `flow_project` opens the Flow project the work belongs to (`create: true` for a new one). Characters are per Flow
   project, so reuse the Flow project that already holds the cast.

## Every call uses the same `project`

`flow_generate`, `flow_download`, `flow_narrate`, `flow_assemble`, `flow_edit`, `flow_continue`, and also
`flow_character` / `flow_character_edit` (their portrait goes to `projects/<project>/_cast/`).

## Folder layout

```
projects/<project>/
  scene-NN.jpeg|mp4        stills and shots, numbered in story order (tools continue numbering, never overwrite)
  scene-NN-lastframe.jpg   frames used to chain the next shot
  clip-NN.mp4              anything fetched later with flow_download - rename it to its scene-NN slot
  narration-NN.m4a         recorded lines; narration-full.m4a for a track fitted to the film
  <project>-final.mp4      the final render (flow_assemble names it so by default)
  _cast/<Name>.jpeg        character portraits
  _work/                   anything made by hand along the way:
    prompts/               the exact JSON sent to flow_generate (keep paths pointing into this folder)
    narration-takes/       trimmed or re-timed audio
    contact-sheets/        frame grids used to check a shot
```

## Dialogue reel recipe (two characters talking, 9:16, captions on top)

Learned on claude-reel-p1/p2 (2026-10) - the user's look, settled after three versions. Follow it from the start.
For a full reel from a script, use the **`dialogue-reel` skill** and its engine `scripts/reel.mjs`; the summary below
is kept for reference.

1. **Check the account**: `flow_status` shows `plan` and `credits_remaining`. With two Google accounts signed in Flow
   opens the default one; the user signs into only the account they want to use.
2. **Script first**, short and funny, approved by the user before anything is generated. Every line must answer the
   line before it (a callback that does not answer the question gets flagged).
3. **Cast**: crop ONE clean front view from each character sheet into `_work/cast-crops/`, then `flow_character`
   with `image`. Robots without arms: say so in every prompt ("NO arms, NO neck"), Flow adds limbs otherwise.
4. **Free stills first** (Nano Banana, 0 credits): a wide of both, a close-up of each. The human's close-up must have a
   closed LINE mouth. Check every still against the sheet before any paid step; redraw off-model ones.
5. **Voices**: one `flow_narrate` call per line, run one at a time (never in parallel). Human: a male/female voice as
   asked; read `heard` on every take and re-record or re-caption mismatches; `max_pause: 0.45` for deadpan lines.
   Free tier: 10 TTS takes a day.
6. **Paid clips (ask first, 7 credits per 4 s 720p)** only for: silent human reactions (looks down, blank stare), the
   bot talking (its own eye/antenna motion), the bot sighing, and the ending wide. NEVER a clip of the human talking:
   Omni opens the mouth with teeth whatever the prompt says.
7. **Check every clip's faces** with crops sampled every 0.25 s (`fps=4,crop=...,tile=16x1`). Remove any mouth dash
   on the bot with ffmpeg `delogo` (time-windowed) - never an opaque box: delogo leaves a soft glow in the mouth
   area while the bot talks, which the user likes. Trim the ending before anyone laughs with an open mouth.
8. **Edit** with `_work/build-edit.mjs` (copy claude-reel-p2's as the template): the human talks on the line-mouth
   still held perfectly still with `mouths` drawing the thin/thick line (default `thick: 4` - the change must be
   clearly visible); the bot talks on its moving clip; long bot
   lines start on the sigh clip and cut to the talking clip; neighbouring cuts of the same shot are merged; cuts are
   frame-exact. NO `bounce` - it shakes the whole frame and the user rejected it.
9. **Render** with `flow_assemble`: `clips` from the edit, `voiceover` = the mixed dialogue, `clip_volume: 0`,
   `mouths`, `overlays: { captions, caption_style: "line-top" }`. Review a 1 fps contact sheet before handing over.
10. **Publish** the `resolution: "1080p"` master (a 720p upload shows only SD on YouTube) with `flow_publish`: show the
   user video, channels, title, caption and time first; test new channels as `privacy: "private"`; then `flow_posts`
   to confirm state PUBLISHED and get the link.

## Rules

- Never leave a project file only in a temp or scratch folder. If a step needs scratch space, move the result into
  `_work/` (or the project root, if it is a deliverable) before finishing.
- Never delete or overwrite files in a project folder unless the user asks.
- Credits: tell the user the cost before anything that spends credits, set `max_credits` on every paid scene, and if a
  paid job fails, check the Flow grid (`flow_assets`) before re-running anything. An empty queue is not proof nothing ran.
- At the end, list the folder for the user and name the final render.
