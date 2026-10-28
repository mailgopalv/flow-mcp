import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FONTS } from "./platform.js";

// On-screen graphics for flow_assemble, in the style of science explainer reels (mapped 2026-10-11 from a reference
// reel): a corner handle, subtitles that appear a few words at a time, small dark label cards with a coloured accent,
// a solid status badge ("REPAIR · ON") and a stack of habit chips. Flow cannot draw readable text, so all of it is
// drawn by ffmpeg onto the finished film. Every text goes through a file (textfile=) - no escaping of apostrophes,
// colons or percent signs - and those files are kept in the project's _work/overlay-text folder.

export type Tone = "neutral" | "alert" | "good";
export interface Overlays {
  logo?: string;
  captions?: { text: string; start: number; end: number }[];
  caption_style?: "words" | "line-top";
  cards?: { title: string; subtitle?: string; start: number; end: number; tone?: Tone }[];
  badges?: { text: string; start: number; end: number; tone?: Tone }[];
  chips?: { items: string[]; start: number; end: number; stagger?: number }[];
  term?: { word: string; meaning: string; start: number; end: number; label?: string; tone?: Tone };
}

const TONE: Record<Tone, string> = { neutral: "0xE8C15A", alert: "0xE5484D", good: "0x3DD68C" };

// Paths inside a filtergraph: forward slashes, and the drive colon escaped (C\:/...), inside single quotes.
const fpath = (p: string) => `'${p.replace(/\\/g, "/").replace(/:/g, "\\:")}'`;
const n = (x: number) => x.toFixed(2);

// Text fades in and out over 0.2 s; the box (if any) simply appears with it.
const fade = (s: number, e: number) =>
  `alpha='if(lt(t,${n(s)}),0,if(lt(t,${n(s + 0.2)}),(t-${n(s)})/0.2,if(gt(t,${n(e - 0.2)}),max(0,(${n(e)}-t)/0.2),1)))'`;
const when = (s: number, e: number) => `enable='between(t,${n(s)},${n(e)})'`;

// A subtitle line is shown a few words at a time, each group timed by its share of the line's characters.
export function captionChunks(text: string, start: number, end: number, perChunk = 3): { text: string; start: number; end: number }[] {
  const words = text.trim().split(/\s+/);
  const groups: string[] = [];
  for (let i = 0; i < words.length; i += perChunk) groups.push(words.slice(i, i + perChunk).join(" "));
  const total = groups.reduce((sum, g) => sum + g.length + 1, 0);
  let t = start;
  return groups.map((g) => {
    const span = ((end - start) * (g.length + 1)) / total;
    const chunk = { text: g, start: t, end: t + span };
    t += span;
    return chunk;
  });
}

// Word wrap into rows of at most `width` characters, balanced so the rows come out about equally long: plain greedy
// wrapping left "isn't." alone on a second row. A single longer word gets a row of its own.
export function wrapLine(text: string, width: number): string[] {
  const words = text.trim().split(/\s+/);
  const greedy = (limit: number) => {
    const rows: string[] = [];
    for (const word of words) {
      const last = rows[rows.length - 1];
      if (last !== undefined && last.length + 1 + word.length <= limit) rows[rows.length - 1] = `${last} ${word}`;
      else rows.push(word);
    }
    return rows;
  };
  const count = greedy(width).length;
  // The narrowest limit that still needs no more rows than plain wrapping gives the most even rows.
  for (let limit = Math.ceil(text.length / count); limit < width; limit++) {
    const rows = greedy(limit);
    if (rows.length <= count) return rows;
  }
  return greedy(width);
}

// Returns a filter chain (comma-separated, no labels) to append to the film's video, or "" when there is nothing.
export function overlayFilter(o: Overlays, width: number, height: number, workDir: string): string {
  const missing = Object.entries(FONTS).filter(([, f]) => !f).map(([k]) => k);
  if (missing.length) throw new Error(`No ${missing.join("/")} font found on this computer for the on-screen text.`);
  const textDir = join(workDir, "overlay-text");
  mkdirSync(textDir, { recursive: true });
  let count = 0;
  const file = (text: string) => {
    const f = join(textDir, `t${String(++count).padStart(3, "0")}.txt`);
    writeFileSync(f, text, "utf8");
    return fpath(f);
  };
  const H = height;
  const W = width;
  const out: string[] = [];
  const text = (t: string, font: string, size: number, color: string, x: string, y: string, s: number, e: number, extra = "") =>
    out.push(
      `drawtext=fontfile=${fpath(font)}:textfile=${file(t)}:expansion=none:fontsize=${Math.round(size)}:fontcolor=${color}:x=${x}:y=${y}:${when(s, e)}:${fade(s, e)}${extra ? `:${extra}` : ""}`,
    );
  const box = (x: number, y: number, w: number, h: number, color: string, s: number, e: number) =>
    out.push(`drawbox=x=${Math.round(x)}:y=${Math.round(y)}:w=${Math.round(w)}:h=${Math.round(h)}:color=${color}:t=fill:${when(s + 0.05, e - 0.05)}`);

  if (o.logo) {
    text(o.logo.toUpperCase(), FONTS.mono!, H * 0.022, "white@0.9", `${Math.round(W * 0.06)}`, `${Math.round(H * 0.045)}`, 0, 1e5, "shadowcolor=black@0.6:shadowx=2:shadowy=2");
  }

  for (const c of o.cards ?? []) {
    // Dark panel, centred near the top: a small spaced-out mono title over a bold line, with a tone-coloured bar on
    // the left. drawbox cannot measure text, so the panel is sized from character counts (mono is exactly 0.6 em).
    const titleSize = H * 0.017;
    const subSize = H * 0.028;
    const title = c.title.toUpperCase().split("").join(" ");
    const pad = H * 0.016;
    const textW = Math.max(title.length * titleSize * 0.6, (c.subtitle?.length ?? 0) * subSize * 0.55);
    const w = Math.min(W * 0.9, textW + pad * 2 + 10);
    const h = pad * 2 + titleSize + (c.subtitle ? subSize * 1.35 : 0);
    const x = (W - w) / 2;
    const y = H * 0.14;
    box(x, y, w, h, "black@0.62", c.start, c.end);
    box(x, y, 6, h, `${TONE[c.tone ?? "neutral"]}@0.95`, c.start, c.end);
    text(title, FONTS.mono!, titleSize, `${TONE[c.tone ?? "neutral"]}`, `${Math.round(x + pad + 10)}`, `${Math.round(y + pad)}`, c.start, c.end);
    if (c.subtitle) text(c.subtitle, FONTS.bold!, subSize, "white", `${Math.round(x + pad + 10)}`, `${Math.round(y + pad + titleSize * 1.5)}`, c.start, c.end);
  }

  for (const b of o.badges ?? []) {
    const color = TONE[b.tone ?? "good"];
    text(b.text.toUpperCase(), FONTS.mono!, H * 0.03, "black", "(w-text_w)/2", `${Math.round(H * 0.42)}`, b.start, b.end, `box=1:boxcolor=${color}@0.92:boxborderw=${Math.round(H * 0.012)}`);
  }

  for (const c of o.chips ?? []) {
    const stagger = c.stagger ?? 0.6;
    c.items.forEach((item, i) => {
      const s = c.start + i * stagger;
      text(item.toUpperCase(), FONTS.mono!, H * 0.02, "white", `${Math.round(W * 0.08)}`, `${Math.round(H * 0.2 + i * H * 0.05)}`, s, c.end, `box=1:boxcolor=black@0.65:boxborderw=${Math.round(H * 0.01)}`);
    });
  }

  if (o.term) {
    // Term card for "learn while you laugh" reels (user's call, 2026-10-28): the frame dims, then a small spaced label
    // ("AI TERM"), the term in large bold, a short accent rule and the meaning wrapped below, all centred. It sits after
    // the last spoken line, so it never shares the screen with a caption.
    const t = o.term;
    const color = TONE[t.tone ?? "neutral"];
    const labelSize = H * 0.018;
    const wordSize = H * 0.05;
    const meaningSize = H * 0.026;
    const rows = wrapLine(t.meaning, 30);
    const top = H * 0.5 - (labelSize * 2 + wordSize * 1.6 + rows.length * meaningSize * 1.35) / 2;
    box(0, 0, W, H, "black@0.62", t.start, t.end);
    text((t.label ?? "AI term").toUpperCase().split("").join(" "), FONTS.mono!, labelSize, color, "(w-text_w)/2", `${Math.round(top)}`, t.start, t.end);
    text(t.word, FONTS.bold!, wordSize, "white", "(w-text_w)/2", `${Math.round(top + labelSize * 2)}`, t.start, t.end, "shadowcolor=black@0.5:shadowx=2:shadowy=2");
    box(W / 2 - W * 0.06, top + labelSize * 2 + wordSize * 1.3, W * 0.12, Math.max(4, H * 0.004), `${color}@0.95`, t.start, t.end);
    rows.forEach((row, i) =>
      text(row, FONTS.sans!, meaningSize, "white", "(w-text_w)/2", `${Math.round(top + labelSize * 2 + wordSize * 1.6 + i * meaningSize * 1.35)}`, t.start, t.end),
    );
  }

  if (o.caption_style === "line-top") {
    // Dialogue sketches (mapped 2026-10-25 from a two-hander reel): the whole line at once in a dark pill near the
    // top. Long lines wrap onto two rows; each row is its own box, spaced so the boxes touch and read as one pill.
    const size = H * 0.022;
    const border = Math.round(H * 0.009);
    for (const line of o.captions ?? []) {
      const rows = wrapLine(line.text, 26);
      rows.forEach((row, i) => {
        const y = Math.round(H * 0.045 + i * (size + border * 2));
        text(row, FONTS.bold!, size, "white", "(w-text_w)/2", `${y}`, line.start, line.end, `box=1:boxcolor=0x1E1424@0.9:boxborderw=${border}`);
      });
    }
    return out.join(",");
  }
  for (const line of o.captions ?? []) {
    for (const chunk of captionChunks(line.text, line.start, line.end)) {
      text(chunk.text, FONTS.bold!, H * 0.034, "white", "(w-text_w)/2", `${Math.round(H * 0.73)}`, chunk.start, chunk.end, "borderw=3:bordercolor=black@0.55:shadowcolor=black@0.5:shadowx=2:shadowy=2");
    }
  }
  return out.join(",");
}
