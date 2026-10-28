---
name: dialogue-reel
description: Make a short two-character dialogue reel (9:16, captions on top, figurine mouths) in the style of claude-reel-p2, from a script the user gives, then optionally publish it through Postiz. Use when the user hands over a script or says "make a reel like claude-reel-p2 / Version 12" with two characters talking.
---

# Dialogue reel

Turns a script into a finished vertical reel like `projects/claude-reel-p2/claude-reel-p2-final-v5-1080p.mp4`:
a human and a bot (or two characters) trade short lines in a night office, deadpan, with quick cuts, the whole line
as a caption pill at the top, the human's mouth a drawn line that goes thin/thick, the bot mouthless. Everything
about the look was settled with the user over three versions - follow it, do not reinvent it.

Read first: the `flow-project` skill (folders, credits), and memories `reel-character-animation-style`,
`dialogue-reel-captions-must-match`, `postiz-self-hosted-setup`. The engine is `scripts/reel.mjs`; the worked example
is `projects/claude-reel-p2/_work/reel.json`.

## What the user gives

- **The script**: who says what, in order. Stage directions in brackets ("(sighs)", "(thinks)") are welcome.
- **The cast**: character-sheet images (default: `projects/<previous reel>/references/cast/`), and which is male/female.
- Optional: a project name (default `claude-reel-pN`, next free N), a reference video, the publishing time.

Ask only for what is missing. Never ask for keys.

## Steps - stop at each CHECKPOINT for the user's OK

1. **Account**: `flow_status` - signed in, the right account (`plan`, `credits_remaining`), no hint. `flow_project`
   with `create: true` for the new project.
2. **Script pass** - CHECKPOINT. Tighten it to ~12-15 short lines, ~40-50 s. Keep the user's jokes and wording; every
   line must answer the one before (flag a callback that does not). Number the lines. Show the table:
   line, speaker, text, planned shot. Save the approved script as `_work/script.md`.
3. **Cast** (free): copy the sheets into `references/cast/`, crop ONE clean front view of each into
   `_work/cast-crops/` (check the crop by eye - no sheet text, no second figure), `flow_character` with `image` and a
   one-line personality. Robots: write "NO arms, NO neck" into prompts unless the sheet has them.
4. **Key stills** (free, Nano Banana, 9:16, one scene per call so a failure blocks nothing): a wide of both at the
   desk, a human close-up with a CLOSED LINE MOUTH ("his mouth is just ONE short thin flat dark line ... no lips, no
   teeth"), a bot close-up. Redraw any still that is off the sheet. CHECKPOINT: show the stills side by side.
5. **Voices** (free): one `flow_narrate` per line, ONE AT A TIME, `max_pause: 0.45`, short style notes ("dry, deadpan,
   very tired"; "[sigh]" in the text for a sigh). Human and bot voices as the user said (male: Puck/Achird/Charon;
   female: Kore/Aoede/Sulafat). Read every `heard`: re-record a misread or truncated line, or set the caption to what
   was really said. Daily free caps: 10 TTS takes, 20 transcripts - say which lines could not be checked.
6. **Paid clips** - CHECKPOINT with the total (Omni 1.1 Flash, 4 s, 720p, 9:16 = 7 credits each, `max_credits: 7`,
   first frame = a key still). Typical set, 4-6 clips: human silent reaction (looks down / blank stare), human bright
   reaction (silent), bot talking (eye bars shift, antennae blink), bot sighing, ending wide. NEVER a clip of the
   human talking - Omni opens the mouth with teeth whatever the prompt says.
7. **Check every clip's faces** with crops every 0.25 s (`ffmpeg -i clip -vf "fps=4,crop=W:H:X:Y,scale=120:-1,tile=16x1"`).
   Bot mouth dash -> `delogo` over its spot, time-windowed, into `_work/<scene>-clean.mp4` (delogo leaves the soft
   glow the user likes; never an opaque box). Human laughing with an open mouth -> end the shot's window before it.
8. **Measure the human's mouth** on the line-mouth still: crop and zoom it at 720x1280, read the line's centre and
   width in pixels (claude-reel-p2: x 357, y 587, w 72).
9. **Write `_work/reel.json`** (format at the top of `scripts/reel.mjs`, example in claude-reel-p2): lines with their
   audio file (narration-NN.m4a), shots (talking stills with `mouth`, a tighter `zoom: 1.15` variant, the wide as
   `push`, clips with windows), the plan (line -> shot, beat before; `null` rows for silent reactions; `"CS>CT"` for a
   long bot line that starts on the sigh and cuts to talking), and the end shot. Geek and AI reels also explain the
   AI term the skit acts out: add `"term": { "word": "Hallucination", "meaning": "<one plain sentence, max ~100
   chars>" }` - the end shot runs 3.5 s longer under a dimmed term card. Put the term in the post title too.
10. **Build**: `node scripts/reel.mjs lines <project>` (compare every heard/caption pair), then `edit`, `render`
    (1080p master, `<project>-final.mp4`), `check`. Look at the contact sheet: no shot twice in a row, no open mouth,
    captions on the right faces. CHECKPOINT: hand the reel over with what to listen for (unchecked lines).
11. **Publish** (only if asked) - CHECKPOINT with video, channel, title (2-100 chars, end with #Shorts for YouTube),
    description, privacy, exact time. `flow_publish` (or, while an old flow-mcp owns port 8787 and answers "Not
    found.", drive `dist/postiz.js` the way `projects/claude-reel-p2/_work/publish-public.mjs` does). Then
    `flow_posts` until PUBLISHED and give the link. New channel: post `private` first.

## Never

- Shake or bob the whole frame (`bounce`) - rejected.
- Let a talking human show an open mouth, or the bot a mouth shape.
- Split one long voice take at its pauses for captions - one take per line.
- Run narration calls in parallel, or spend credits / publish without the CHECKPOINT answer.
- Leave anything outside `projects/<project>/`.
