#!/usr/bin/env node
// Dialogue-reel engine: the free, repeatable half of a claude-reel-p2 style reel, driven by one file per project,
// projects/<project>/_work/reel.json. Generated from claude-reel-p2's hand-made build-lines/build-edit/render
// scripts (2026-10), which produced the version the user signed off. Used by the `dialogue-reel` skill.
//
//   node scripts/reel.mjs lines  <project>            per-line audio: cut, tighten pauses, transcribe -> _work/lines.json
//   node scripts/reel.mjs edit   <project>            shots + cuts + dialogue track + captions/mouths -> _work/edit.json
//   node scripts/reel.mjs render <project> [name]     1080p master through flow_assemble's code (default <project>-final)
//   node scripts/reel.mjs check  <project> [name]     contact sheets of the render into _work/contact-sheets/
//
// reel.json (all paths relative to the project folder):
// {
//   "lines": [ { "n": 1, "caption": "Claude... are you sure this is good?", "audio": "narration-03.m4a",
//                "from": null, "to": null } ],                        // from/to: cut a line out of a longer take
//   "shots": {
//     "TS":  { "still": "scene-11.jpeg", "zoom": 1, "mouth": { "x": 357, "y": 587, "w": 72 } },  // talking still
//     "TS2": { "still": "scene-11.jpeg", "zoom": 1.15, "mouth": { "x": 357, "y": 587, "w": 72 } },
//     "W1":  { "still": "scene-01.jpeg", "push": 0.0008 },              // slow push-in on a still (no mouth)
//     "CT":  { "clip": "_work/scene-08-clean.mp4", "from": 0, "to": 4 },
//     "END": { "clip": "scene-10.mp4", "from": 0, "to": 1.85 }
//   },
//   "plan": [ [1, "TS", 0.3], [2, "CS>CT", 0.25], [null, "TD", 0, 1.6] ],  // [line|null, shot or "A>B", beat, silence]
//   "end": { "shot": "END", "len": 4 },
//   "tail": 0.2, "split_at": 3.6, "max_pause": 0.45,
//   "term": { "word": "Hallucination", "meaning": "When an AI states something false with total confidence.",
//             "len": 3.5, "label": "AI term" }                    // optional end card, added after "end"
// }
// Mouth x/y/w are pixels on the still scaled to 720x1280 (measure them on a zoomed crop). A shot with a mouth gets the
// drawn thin/thick line while its line is spoken. No bounce: the user rejected whole-frame motion.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, project, name] = process.argv.slice(2);
if (!cmd || !project) {
  console.error("usage: node scripts/reel.mjs lines|edit|render|check <project> [name]");
  process.exit(1);
}
const P = join(REPO, "projects", project);
const W = join(P, "_work");
const at = (f) => (isAbsolute(f) ? f : join(P, f));
const reel = JSON.parse(readFileSync(join(W, "reel.json"), "utf8"));
const ff = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
const dur = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());
const { tightenPauses, assemble } = await import(pathToFileURL(join(REPO, "dist", "assemble.js")).href);

if (cmd === "lines") {
  const { transcribeWithGemini } = await import(pathToFileURL(join(REPO, "dist", "gemini.js")).href);
  const D = join(W, "narration-takes");
  mkdirSync(D, { recursive: true });
  const out = [];
  for (const l of reel.lines) {
    const target = join(D, `line-${String(l.n).padStart(2, "0")}.m4a`);
    const trim = l.from == null ? [] : ["-ss", String(l.from), "-to", String(l.to)];
    ff(["-i", at(l.audio), ...trim, "-c:a", "aac", "-b:a", "192k", target]);
    const d = await tightenPauses(target, reel.max_pause ?? 0.45);
    const heard = process.env.SKIP_LISTEN ? "(skipped)" : await transcribeWithGemini(target).catch((e) => `(not checked: ${e.message.slice(0, 90)})`);
    out.push({ n: l.n, file: target, dur: +d.toFixed(2), caption: l.caption, heard: heard.replace(/\s+/g, " ") });
    console.log(`${l.n}\t${d.toFixed(2)}s\t${l.caption}\n\theard: ${heard.replace(/\s+/g, " ")}`);
  }
  writeFileSync(join(W, "lines.json"), JSON.stringify(out, null, 1));
  console.log("Compare every 'heard' with its caption; re-record or re-caption any mismatch before `edit`.");
}

if (cmd === "edit") {
  const LINE = Object.fromEntries(JSON.parse(readFileSync(join(W, "lines.json"), "utf8")).map((l) => [l.n, l]));
  const TAIL = reel.tail ?? 0.2;
  const SPLIT_AT = reel.split_at ?? 3.6;
  mkdirSync(join(W, "cuts"), { recursive: true });
  mkdirSync(join(W, "shots"), { recursive: true });

  // Every shot becomes a 720x1280 30 fps source with a window [lo, hi] to cut from.
  const SHOT = {};
  for (const [key, s] of Object.entries(reel.shots)) {
    if (s.clip) {
      SHOT[key] = { file: at(s.clip), lo: s.from ?? 0, hi: s.to ?? dur(at(s.clip)) };
      continue;
    }
    const out = join(W, "shots", `${key}.mp4`);
    if (s.push) {
      // slow push-in; never used for a talking still, the drawn mouth would slide off the face
      ff(["-loop", "1", "-i", at(s.still), "-t", "8", "-vf",
        `scale=1440:2560,zoompan=z='1+${s.push}*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=240:s=720x1280:fps=30`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
    } else {
      // locked still, optionally cropped tighter (zoom about the centre) - the mouth position follows below
      const z = s.zoom ?? 1;
      const w = Math.round((720 * z) / 2) * 2;
      const h = Math.round((1280 * z) / 2) * 2;
      ff(["-loop", "1", "-i", at(s.still), "-t", "8", "-r", "30", "-vf", `scale=${w}:${h},crop=720:1280`, "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
    }
    SHOT[key] = { file: out, lo: 0, hi: 8, mouth: s.mouth, zoom: s.zoom ?? 1 };
  }
  const mouthOf = (key) => {
    const s = SHOT[key];
    if (!s?.mouth) return null;
    const z = s.zoom;
    return { x: (360 + (s.mouth.x - 360) * z) / 720, y: (640 + (s.mouth.y - 640) * z) / 1280, width: (s.mouth.w * z) / 720 };
  };

  let t = 0;
  const segments = [];
  const captions = [];
  const mouths = [];
  const audio = [];
  for (const [n, shot, beat, silent] of reel.plan) {
    if (n === null) {
      segments.push({ shot, len: silent });
      t += silent;
      continue;
    }
    const l = LINE[n];
    if (!l) throw new Error(`plan uses line ${n}, which lines.json does not have - run \`lines\` first`);
    const start = t + beat;
    const [first, then] = shot.split(">");
    captions.push({ text: l.caption, start: +start.toFixed(2), end: +(start + l.dur + 0.1).toFixed(2) });
    audio.push({ file: l.file, at: start });
    const m = mouthOf(first);
    if (m) mouths.push({ start: +(start + 0.05).toFixed(2), end: +(start + l.dur - 0.1).toFixed(2), ...m });
    const len = beat + l.dur + TAIL;
    if (then && len > SPLIT_AT + 0.8) segments.push({ shot: first, len: SPLIT_AT }, { shot: then, len: len - SPLIT_AT });
    else segments.push({ shot: first, len });
    t += len;
  }
  if (reel.end) segments.push({ shot: reel.end.shot, len: reel.end.len });
  // The term card gets seconds of its own after the ending, on the same shot (it merges below, so the take runs on).
  if (reel.term) segments.push({ shot: reel.end?.shot ?? segments[segments.length - 1].shot, len: reel.term.len ?? 3.5 });

  // Neighbours on the same shot merge, so a take keeps rolling instead of jumping back (v1 showed one take twice).
  const merged = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (last && last.shot === s.shot) last.len += s.len;
    else merged.push({ ...s });
  }
  const cursor = Object.fromEntries(Object.entries(SHOT).map(([k, s]) => [k, s.lo]));
  const cuts = merged.map((c, i) => {
    const s = SHOT[c.shot];
    if (!s) throw new Error(`plan uses shot ${c.shot}, which reel.json does not define`);
    let from = cursor[c.shot];
    if (from + c.len > s.hi) from = s.lo + Math.max(0, s.hi - s.lo - c.len) * ((i * 0.37) % 1);
    cursor[c.shot] = Math.min(from + c.len, s.hi);
    const out = join(W, "cuts", `cut-${String(i + 1).padStart(2, "0")}.mp4`);
    const frames = Math.round(c.len * 30); // frame-exact, so the picture cannot drift against the voices
    ff(["-ss", from.toFixed(3), "-t", Math.max(0.1, s.hi - from).toFixed(3), "-i", s.file, "-an",
      "-vf", `scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=30,tpad=stop_mode=clone:stop_duration=${c.len.toFixed(2)}`,
      "-frames:v", String(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", out]);
    return { shot: c.shot, from: +from.toFixed(2), len: +(frames / 30).toFixed(3), file: out };
  });

  const total = cuts.reduce((sum, c) => sum + c.len, 0);
  const args = [];
  const parts = [];
  audio.forEach((x, i) => {
    args.push("-i", x.file);
    parts.push(`[${i}:a]asetpts=PTS-STARTPTS,adelay=${Math.round(x.at * 1000)}:all=1[a${i}]`);
  });
  ff([...args, "-filter_complex",
    `${parts.join(";")};${audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${audio.length}:normalize=0,apad=whole_dur=${total.toFixed(2)},atrim=0:${total.toFixed(2)}[out]`,
    "-map", "[out]", "-ar", "48000", join(W, "narration-takes", "dialogue.wav")]);
  const term = reel.term && {
    word: reel.term.word,
    meaning: reel.term.meaning,
    label: reel.term.label,
    start: +(total - (reel.term.len ?? 3.5)).toFixed(2),
    end: +total.toFixed(2),
  };
  writeFileSync(join(W, "edit.json"), JSON.stringify({ duration: +total.toFixed(2), cuts, captions, mouths, term }, null, 1));
  console.log(`film ${total.toFixed(2)} s, ${cuts.length} cuts: ${cuts.map((c) => c.shot).join(" ")}`);
}

if (cmd === "render") {
  const edit = JSON.parse(readFileSync(join(W, "edit.json"), "utf8"));
  const out = await assemble({
    dir: P,
    clips: edit.cuts.map((c) => c.file),
    voiceover: join(W, "narration-takes", "dialogue.wav"),
    clip_volume: 0,
    music_volume: 0.25,
    hold_last_frame: true,
    output_name: name ?? `${project}-final`,
    mouths: edit.mouths,
    resolution: "1080p",
    overlays: { captions: edit.captions, caption_style: "line-top", term: edit.term },
  });
  console.log(JSON.stringify({ output: out.output, duration: out.duration }));
}

if (cmd === "check") {
  const film = join(P, `${name ?? `${project}-final`}.mp4`);
  if (!existsSync(film)) throw new Error(`${film} does not exist - render first`);
  const C = join(W, "contact-sheets");
  mkdirSync(C, { recursive: true });
  ff(["-i", film, "-vf", "fps=1/2,scale=200:-1,tile=9x3", "-frames:v", "1", join(C, "final.jpg")]);
  console.log(`contact sheet: ${join(C, "final.jpg")} (1 frame every 2 s) - check every face for a stray open mouth`);
}
