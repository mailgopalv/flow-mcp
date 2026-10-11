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

## Rules

- Never leave a project file only in a temp or scratch folder. If a step needs scratch space, move the result into
  `_work/` (or the project root, if it is a deliverable) before finishing.
- Never delete or overwrite files in a project folder unless the user asks.
- Credits: tell the user the cost before anything that spends credits, set `max_credits` on every paid scene, and if a
  paid job fails, check the Flow grid (`flow_assets`) before re-running anything. An empty queue is not proof nothing ran.
- At the end, list the folder for the user and name the final render.
