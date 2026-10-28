import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { overlayFilter, type Overlays } from "./overlays.js";
import { FFMPEG_HINT, IS_WIN, powershell, psQuote } from "./platform.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MCP_FFPROBE ?? "ffprobe";

export interface AssembleOptions {
  dir: string;
  clips?: string[];
  music?: string;
  music_volume: number;
  clip_volume?: number;
  voiceover?: string;
  output_name: string;
  hold_last_frame?: boolean;
  overlays?: Overlays;
  bounce?: { start: number; end: number }[];
  mouths?: Mouth[];
  resolution?: "source" | "1080p";
}

interface ClipInfo {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
}

async function probe(file: string): Promise<ClipInfo> {
  // A raw ffprobe dump ("moov atom not found") told the user nothing. Say which file and what to do about it.
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file]).catch(() => {
    throw new Error(`"${basename(file)}" isn't a playable video - it may be an unfinished download or a ZIP of several clips. Remove it, or pick other clips.`);
  });
  const data = JSON.parse(stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
  const video = data.streams.find((s) => s.codec_type === "video");
  if (!video?.width || !video.height) throw new Error(`${file} has no video stream.`);
  return {
    width: video.width,
    height: video.height,
    duration: Number(data.format.duration),
    hasAudio: data.streams.some((s) => s.codec_type === "audio"),
  };
}

// Clips are normally scene-NN.mp4, but a film can also be cut from clips pulled out of Flow (clip-NN) or restyled
// ones (edit-NN). Narration takes and previously assembled films are never treated as footage.
function defaultClips(dir: string): string[] {
  if (!existsSync(dir)) {
    throw new Error(`There's no "${basename(dir)}" folder in your films yet. Add clips with "Upload a video" or "From my films", or type the name of a folder that already has clips in it.`);
  }
  const files = readdirSync(dir).filter((f) => /\.mp4$/i.test(f) && !/^narration-/i.test(f));
  const numbered = new Map<string, string>();
  for (const f of files.sort()) {
    const key = f.match(/^((?:scene|clip|edit)-\d+)(-v\d+)?\.mp4$/i)?.[1];
    if (key && !numbered.has(key)) numbered.set(key, join(dir, f));
  }
  if (numbered.size) return [...numbered.values()];
  // Nothing follows the naming scheme: fall back to every other mp4, oldest first, so a hand-named clip still works.
  return files
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t)
    .map((x) => join(dir, x.f));
}

// Pulls the spoken track out of a generated clip so Flow's voices can be used as narration.
export async function extractAudio(video: string, target: string): Promise<{ output: string; duration: number }> {
  await run(FFMPEG, ["-y", "-i", video, "-vn", "-af", "highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "2", target]);
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
  return { output: target, duration: Number(stdout.trim()) };
}

const SAY = process.env.FLOW_MCP_SAY ?? "say";

// The voices this computer has installed. On a Mac that is `say` (Premium voices appear as soon as the user downloads
// them in System Settings); on Windows it is the built-in speech engine, the voices under Settings > Time & language >
// Speech. The Windows branch is written to the documented System.Speech API but has not been run on a real PC yet.
export async function localVoices(): Promise<{ name: string; description: string }[]> {
  if (IS_WIN) {
    try {
      const out = powershell(
        "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }",
      );
      return out
        .split(/\r?\n/)
        .map((l) => l.trim().split("|"))
        .filter(([name, culture]) => name && /^en-/i.test(culture ?? ""))
        .map(([name, culture]) => ({ name, description: `${culture} · Windows, free` }));
    } catch {
      return [];
    }
  }
  const { stdout } = await run(SAY, ["-v", "?"], { maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
  return stdout
    .split("\n")
    .map((line) => line.match(/^(.+?)\s{2,}(\w{2}_\w{2})\s+#\s*(.*)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m) && /^en_/.test(m![2]))
    .map((m) => ({ name: m[1].trim(), description: `${m[2].replace("_", "-")} · macOS, free` }))
    .filter((v) => !/^(Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Albert|Fred|Grandma|Grandpa|Junior|Kathy|Princess|Ralph|Rocko|Shelley|Sandy|Eddy|Flo|Reed|Rishi)/.test(v.name));
}

// Caps every pause in a recorded line at `maxPause` seconds (2026-10-26: a 'dry, deadpan, very tired' Gemini take of
// three short sentences came back 11.7 s long, 2-2.4 s of silence between each). Lead-in and tail silence stay as
// they are; only gaps inside the line shrink.
export async function tightenPauses(file: string, maxPause: number): Promise<number> {
  const tmp = file.replace(/(\.\w+)$/, ".tight$1");
  await run(FFMPEG, ["-y", "-i", file, "-af", `silenceremove=stop_periods=-1:stop_duration=${maxPause}:stop_threshold=-38dB:stop_silence=${maxPause}`, "-c:a", "aac", "-b:a", "192k", tmp]);
  renameSync(tmp, file);
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

// Speaks a line with this computer's own voice. Free and instant, but only as good as the installed voice.
export async function speakLocally(text: string, voice: string, target: string): Promise<{ output: string; duration: number }> {
  const stem = target.replace(/\.\w+$/, "");
  const raw = stem + (IS_WIN ? ".wav" : ".aiff");
  if (IS_WIN) {
    // The line goes through a file, never the command line, so quotes or symbols in it cannot break the script.
    const lineFile = stem + ".line.txt";
    writeFileSync(lineFile, text, "utf8");
    try {
      powershell(
        `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice(${psQuote(voice)}); $s.SetOutputToWaveFile(${psQuote(raw)}); $s.Speak([System.IO.File]::ReadAllText(${psQuote(lineFile)}, [System.Text.Encoding]::UTF8)); $s.Dispose()`,
        300_000,
      );
    } finally {
      rmSync(lineFile, { force: true });
    }
  } else {
    await run(SAY, ["-v", voice, "-r", "168", "-o", raw, text]);
  }
  await run(FFMPEG, ["-y", "-i", raw, "-af", "highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "2", target]);
  rmSync(raw, { force: true });
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
  return { output: target, duration: Number(stdout.trim()) };
}

// A character with no mouth "talks" by bobbing, like the low-poly figure in the user's reference reel (mapped
// 2026-10-26): during each span the whole frame hops up a few pixels about four times a second with a little sway.
// The picture is scaled up 4% so the moving crop never shows an edge. Times are film seconds.
export function bounceFilter(spans: { start: number; end: number }[], width: number, height: number): string {
  if (!spans.length) return "";
  const on = spans.map((s) => `between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})`).join("+");
  const amp = Math.round(height * 0.009);
  const x = `(iw-ow)/2+(${on})*${Math.round(amp * 0.5)}*sin(2*PI*2.3*t)`;
  const y = `(ih-oh)/2-(${on})*${amp}*abs(sin(2*PI*3.9*t))`;
  return `scale=${Math.round(width * 1.04 / 2) * 2}:${Math.round(height * 1.04 / 2) * 2},crop=${width}:${height}:x='${x}':y='${y}'`;
}

// A figurine mouth drawn in the edit (mapped 2026-10-26 from the user's reference reel, where the speaker's mouth is a
// short dark line that only goes thin-thick-thin). Asking Omni for that failed: "talks ... mouth NEVER opens, no teeth"
// still opened the mouth with teeth, 7 credits gone. So the line is drawn over a locked-off shot whose mouth sits at a
// known spot: a thin bar for the whole span and a thick bar switched on and off in a speech-like rhythm. drawbox
// fixes its size once, but `enable` is re-evaluated every frame, hence two bars rather than one changing height.
// x, y (centre) and width are fractions of the frame; times are film seconds.
export interface Mouth { start: number; end: number; x: number; y: number; width: number; color?: string; thick?: number }
export function mouthFilter(mouths: Mouth[], width: number, height: number): string {
  return mouths
    .flatMap((m) => {
      const w = Math.round(m.width * width);
      const cx = m.x * width;
      const cy = m.y * height;
      const thin = Math.max(3, Math.round(height * 0.004));
      // 2.6x thin was too subtle to read as talking (user, 2026-10-26: "a little thicker to show the variation").
      const thick = Math.round(thin * (m.thick ?? 4));
      const color = m.color ?? "0x3A2018";
      const span = `between(t,${m.start.toFixed(2)},${m.end.toFixed(2)})`;
      return [
        `drawbox=x=${Math.round(cx - w / 2)}:y=${Math.round(cy - thin / 2)}:w=${w}:h=${thin}:color=${color}:t=fill:enable='${span}'`,
        `drawbox=x=${Math.round(cx - w * 0.47)}:y=${Math.round(cy - thick / 2)}:w=${Math.round(w * 0.94)}:h=${thick}:color=${color}:t=fill:enable='${span}*gt(sin(2*PI*3.3*t)+0.6*sin(2*PI*5.1*t),0.35)'`,
      ];
    })
    .join(",");
}

// Joins the scene clips into one film, keeping their own sound and laying music / voiceover on top.
export async function assemble(o: AssembleOptions): Promise<{ output: string; clips: string[]; duration: number; held_last_frame: number }> {
  // Clips can now come from anywhere, so the project folder the film is saved into may not exist yet.
  if (o.clips?.length) mkdirSync(o.dir, { recursive: true });
  const out = join(o.dir, o.output_name.replace(/[^\w.-]+/g, "_").replace(/(\.mp4)?$/, ".mp4"));
  const clips = (o.clips?.length ? o.clips : defaultClips(o.dir)).filter((c) => c !== out);
  if (!clips.length) throw new Error(`No clips found in ${o.dir}. Generate or download a clip first, or pass clips explicitly.`);
  for (const f of [...clips, o.music, o.voiceover]) if (f && !existsSync(f)) throw new Error(`File not found: ${f}`);

  let infos = await Promise.all(clips.map(probe));
  // A narration longer than the footage would be cut off, so the last frame is held until the voice finishes.
  let hold = 0;
  if (o.hold_last_frame !== false && o.voiceover) {
    const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", o.voiceover]);
    hold = Math.max(0, Number(stdout.trim()) + 0.6 - infos.reduce((sum, i) => sum + i.duration, 0));
  }
  // Size the film to the biggest clip so a 720p opener cannot pull a 1080p clip down with it.
  const biggest = infos.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  // 2026-10-27: a 720x1280 film at ~1 Mbit/s went to YouTube and the user saw only an SD version. Flow delivers 720p,
  // so for publishing the film is rendered as a 1080p master (long side 1920, lanczos) - every clip is scaled up
  // before the mouths and captions are drawn, so the drawn parts stay sharp instead of being upscaled afterwards.
  const scaleUp = o.resolution === "1080p" ? 1920 / Math.max(biggest.width, biggest.height) : 1;
  const even = (n: number) => Math.round(n / 2) * 2;
  const width = even(biggest.width * Math.max(1, scaleUp));
  const height = even(biggest.height * Math.max(1, scaleUp));
  const args: string[] = ["-y"];
  for (const clip of clips) args.push("-i", clip);
  const filters: string[] = [];
  // The clips' own sound used to play at full volume no matter what, drowning a narration laid on top. Music already
  // had its own level; the clips now do too.
  const clipVolume = Math.min(1, Math.max(0, o.clip_volume ?? 1));
  infos.forEach((info, i) => {
    const freeze = hold > 0.05 && i === infos.length - 1 ? `,tpad=stop_mode=clone:stop_duration=${hold.toFixed(2)}` : "";
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos:out_range=tv,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24${freeze}[v${i}]`,
    );
    filters.push(
      info.hasAudio
        ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${clipVolume}${hold > 0.05 && i === infos.length - 1 ? `,apad=pad_dur=${hold.toFixed(2)}` : ""}[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${(info.duration + (i === infos.length - 1 ? hold : 0)).toFixed(2)}[a${i}]`,
    );
  });
  // Graphics are drawn over the joined film, so their times are film times, not clip times.
  const graphics = o.overlays ? overlayFilter(o.overlays, width, height, join(o.dir, "_work")) : "";
  // Drawn mouths sit on the face, so they go on before the bounce moves the picture; the bounce goes before the
  // captions so those stay steady.
  const motion = [mouthFilter(o.mouths ?? [], width, height), bounceFilter(o.bounce ?? [], width, height)].filter(Boolean).join(",");
  filters.push(`${infos.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${clips.length}:v=1:a=1[${graphics || motion ? "vraw" : "v"}][clipaudio]`);
  if (motion) filters.push(`[vraw]${motion}[${graphics ? "vmoved" : "v"}]`);
  if (graphics) filters.push(`[${motion ? "vmoved" : "vraw"}]${graphics}[v]`);

  const mix = ["[clipaudio]"];
  let input = clips.length;
  if (o.music) {
    args.push("-stream_loop", "-1", "-i", o.music);
    filters.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${o.music_volume}[music]`);
    mix.push("[music]");
    input++;
  }
  if (o.voiceover) {
    args.push("-i", o.voiceover);
    filters.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo[vo]`);
    mix.push("[vo]");
  }
  filters.push(mix.length > 1 ? `${mix.join("")}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0[a]` : "[clipaudio]anull[a]");

  const output = out;
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[v]", "-map", "[a]",
    // Stills come in as full-range JPEG colour (yuvj420p); players and YouTube expect TV range, so it is converted above
    // (out_range=tv) and tagged here. A 1080p master gets a finer quality setting for the platforms' re-encode.
    "-c:v", "libx264", "-crf", o.resolution === "1080p" ? "16" : "18", "-preset", o.resolution === "1080p" ? "slow" : "medium", "-pix_fmt", "yuv420p", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    output,
  );
  try {
    await run(FFMPEG, args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(e.code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT}).` : `ffmpeg failed: ${(e.stderr ?? String(e)).slice(-600)}`);
  }
  return { output, clips, duration: infos.reduce((sum, i) => sum + i.duration, 0) + hold, held_last_frame: Number(hold.toFixed(2)) };
}
