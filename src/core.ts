import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { assemble, localVoices, speakLocally, tightenPauses } from "./assemble.js";
import { GEMINI_VOICES, geminiKey, saveGeminiKey, speakWithGemini, transcribeWithGemini } from "./gemini.js";
import { extractLastFrame } from "./chain.js";
import { characterLook, createCharacter, downloadAsset, openProject, trashAsset, editCharacter, getFlowState, listAssets, listCharacters, rememberCharacter, runAgentBatch, runContinue, runEdit, runGeneration } from "./flow.js";
import { createPost, listChannels, listPosts, uploadMedia } from "./postiz.js";
import { JobQueue, type Job } from "./queue.js";
import { OUTPUT_ROOT, projectDir } from "./chrome.js";
import { BIN, COMPUTER, IS_MAC, IS_WIN, moveToBin } from "./platform.js";
import { TECHNIQUES, techniqueById } from "./techniques.js";

const words = (s: string) => s.split(/[^a-z0-9]+/i).filter((w) => w.length > 3).map((w) => w.toLowerCase());

export { OUTPUT_ROOT, projectDir };

const sceneSchema = z.object({
  prompt: z.string().min(1).describe("Full English prompt for one clip: action, shot and camera move, location, style, light, sound."),
  type: z.enum(["video", "image"]).default("video"),
  model: z
    .string()
    .optional()
    .describe("Model label as shown in Flow, e.g. 'Omni 1.1 Flash', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Nano Banana 2'. Omit to keep Flow's current model."),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional().describe("Video supports 16:9 and 9:16 only."),
  duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional().describe("Video length in seconds. Omni models only; Veo 3.1 clips are fixed at 8s."),
  resolution: z.enum(["360p", "720p"]).optional().describe("Video resolution. Omni models only."),
  max_credits: z.number().int().min(0).default(25).describe("Safety cap: the scene is skipped (nothing spent) if Flow quotes more credits than this."),
  variants: z.number().int().min(1).max(4).optional().describe("Outputs per prompt (each one spends credits). Default 1."),
  first_frame: z.string().optional().describe("First frame: absolute image path, or 'asset:<title>' for an image already in the Flow project."),
  last_frame: z.string().optional().describe("Last frame: absolute image path, or 'asset:<title>'."),
  reference_images: z
    .array(z.string())
    .max(3)
    .optional()
    .describe(
      "Reference media: absolute image paths, or 'asset:<title>' for media or characters already in the Flow project. Flow's COMPOSER takes references OR first/last frames on a video scene, never both, so with frames set these are skipped and the job says so. Flow itself can do both via agent mode (save the last frame, Animate it, then add the character).",
    ),
  download_quality: z.enum(["original", "upscaled"]).optional().describe("'upscaled' fetches 1080p video / 2K image (free, slower). Default original."),
  retries: z.number().int().min(0).max(3).default(1).describe("Automatic retries when Flow itself reports the generation failed."),
  technique: z.string().optional().describe("Id from flow_techniques (e.g. 'orbit-360'); its exact phrase is appended to the prompt. One per scene."),
  reference_previous: z
    .boolean()
    .optional()
    .describe("Use the previous scene's finished image as an extra reference, so this scene inherits its exact drawing of the characters, style and palette. Best way to keep a set of stills on-model."),
  chain_previous: z
    .boolean()
    .optional()
    .describe("Continue the previous scene in this call: its last frame becomes this scene's first frame. Not valid on the first scene or together with first_frame."),
});

// Raw shapes double as MCP input schemas and, wrapped in z.object, as HTTP body validators.
export const shapes = {
  status: { detailed: z.boolean().default(true).describe("false skips the plan/credits readout, which briefly opens Flow's account panel.") },
  generate: {
    project: z.string().min(1).describe("Folder name for the downloaded clips, e.g. 'HotelPromo'."),
    scenes: z.array(sceneSchema).min(1).max(100),
  },
  wait: {
    job_ids: z.array(z.string()).optional().describe("Job ids from a queued call, or the task_id of a call that answered still_working. Default: every queued job."),
    timeout_seconds: z.number().int().min(5).max(900).default(40).describe("An MCP call returns after at most 40 s whatever this says, so call again until finished is true."),
  },
  cancel: { job_id: z.string() },
  retry: { job_ids: z.array(z.string()).optional().describe("Jobs to re-queue. Default: every failed job.") },
  assets: { kind: z.enum(["image", "video", "scene"]).optional() },
  download: {
    project: z.string().min(1).describe("Local folder name under the output root."),
    assets: z.array(z.string().min(1)).min(1).max(30).describe("Titles (or title prefixes) from flow_assets, in the order they should be numbered."),
    quality: z.enum(["original", "upscaled"]).default("original"),
  },
  assemble: {
    project: z.string().min(1).describe("Same project name used in flow_generate."),
    clips: z.array(z.string()).optional().describe("Absolute clip paths in play order. Default: every scene-NN.mp4 in the project folder (first variant of each)."),
    music: z.string().optional().describe("Absolute path to a music file; looped and trimmed to the film length."),
    music_volume: z.number().min(0).max(1).default(0.25),
    clip_volume: z
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe("Volume of the clips' own sound, 0-1. Lower it (around 0.2-0.3) so a narration sits clearly on top; 1 keeps it as recorded."),
    voiceover: z.string().optional().describe("Absolute path to a voiceover audio file, starts at 0:00."),
    output_name: z.string().min(1).optional().describe("File name of the render. Default: <project>-final."),
    hold_last_frame: z.boolean().default(true).describe("Freeze the final frame so a longer voiceover is not cut off."),
    resolution: z
      .enum(["source", "1080p"])
      .default("source")
      .describe("'1080p' renders a publishing master (long side 1920, lanczos upscale, finer encode): use it for anything going to YouTube or Instagram - a 720p upload showed only SD on YouTube. 'source' keeps the clips' size."),
    bounce: z
      .array(z.object({ start: z.number().min(0), end: z.number().positive() }))
      .optional()
      .describe("Film-time spans where the WHOLE FRAME bobs, background included. The user rejected it as camera shake (claude-reel-p2, 2026-10-26); prefer a clip where only the character moves. Use only briefly, if at all."),
    mouths: z
      .array(
        z.object({
          start: z.number().min(0),
          end: z.number().positive(),
          x: z.number().min(0).max(1).describe("Mouth centre, fraction of the frame width."),
          y: z.number().min(0).max(1).describe("Mouth centre, fraction of the frame height."),
          width: z.number().min(0.01).max(0.5).describe("Mouth width, fraction of the frame width."),
          color: z.string().optional().describe("ffmpeg colour, default dark brown 0x3A2018."),
          thick: z.number().min(1.5).max(8).optional().describe("How much thicker the 'open' line is than the closed one. Default 4 (the user's choice; 2.6 was too subtle)."),
        }),
      )
      .optional()
      .describe("A figurine mouth drawn in the edit: a short dark line that goes thin-thick while the character speaks, over a locked-off shot whose mouth sits at a known spot. Safer than asking the video model for a closed mouth, which it ignores when the character talks."),
    overlays: z
      .object({
        logo: z.string().max(40).optional().describe("Handle shown small in the top-left corner for the whole film, e.g. 'gentlevibzz'."),
        captions: z
          .array(z.object({ text: z.string().min(1), start: z.number().min(0), end: z.number().positive() }))
          .optional()
          .describe("Subtitles: one entry per spoken line with the seconds it is spoken; shown three words at a time."),
        caption_style: z
          .enum(["words", "line-top"])
          .optional()
          .describe("'words' (default): three words at a time, low in the frame, explainer style. 'line-top': the whole line at once in a dark pill near the top, for dialogue sketches."),
        cards: z
          .array(z.object({ title: z.string().min(1).max(30), subtitle: z.string().max(40).optional(), start: z.number().min(0), end: z.number().positive(), tone: z.enum(["neutral", "alert", "good"]).optional() }))
          .optional()
          .describe("Label cards near the top: small spaced title (e.g. 'TELOMERES') over a bold line. tone: neutral gold, alert red, good green."),
        badges: z
          .array(z.object({ text: z.string().min(1).max(24), start: z.number().min(0), end: z.number().positive(), tone: z.enum(["neutral", "alert", "good"]).optional() }))
          .optional()
          .describe("Solid status badge mid-screen, e.g. 'REPAIR · ON' (default tone good)."),
        chips: z
          .array(z.object({ items: z.array(z.string().min(1).max(30)).min(1).max(6), start: z.number().min(0), end: z.number().positive(), stagger: z.number().min(0).max(5).optional() }))
          .optional()
          .describe("A stack of small chips that appear one after another (stagger seconds apart, default 0.6)."),
        term: z
          .object({
            word: z.string().min(1).max(24),
            meaning: z.string().min(1).max(110),
            start: z.number().min(0),
            end: z.number().positive(),
            label: z.string().max(16).optional(),
            tone: z.enum(["neutral", "alert", "good"]).optional(),
          })
          .optional()
          .describe("Term card that explains one AI term at the end of a reel: the frame dims, a small label (default 'AI TERM'), the term large, its meaning below. Place it after the last spoken line, e.g. the last 3 s, with hold_last_frame so the film runs long enough."),
      })
      .optional()
      .describe("On-screen graphics drawn onto the film (free). All times are seconds in the finished film."),
  },
  agent: {
    project: z.string().min(1).describe("Folder name for the downloaded images."),
    scenes: z.array(z.string().min(1)).min(1).max(50).describe("One image description per scene, in order."),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("16:9"),
    download_quality: z.enum(["original", "upscaled"]).optional(),
  },
  voices: {},
  narrate: {
    project: z.string().min(1).describe("Folder for the narration audio."),
    engine: z
      .enum(["gemini", "mac"])
      .default("gemini")
      .describe(
        "'gemini' uses Google AI Studio's text-to-speech - the same voices Flow has, free on the AI Studio tier, no length limit, needs a key in ~/.flow-mcp/gemini-key. 'mac' uses a voice installed on this computer (macOS voices on a Mac, the built-in speech voices on Windows): free, instant, no key.",
      ),
    text: z.string().min(1).max(400).describe("The line to speak. About 20 words fits 8 s, 30 words fits 12 s; anything longer needs a longer take."),
    voice: z.string().min(1).default("Charon").describe("Voice name from flow_voices, e.g. Charon (informative), Aoede (breezy), Gacrux (mature) for Google; Zoe or Samantha for macOS."),
    style: z.string().max(200).optional().describe("Delivery note for the 'gemini' engine, e.g. 'slowly and warmly, like a documentary narrator'."),
    max_pause: z
      .number()
      .min(0.1)
      .max(3)
      .optional()
      .describe("Shorten every pause longer than this many seconds down to it. Gemini stretches 'deadpan' or 'tired' deliveries with 2 s gaps between sentences; 0.5 keeps them tight."),
  },
  edit: {
    project: z.string().min(1).describe("Local folder for the edited clip."),
    asset: z.string().min(1).describe("Title (or title prefix) of a video already in the Flow project; see flow_assets."),
    prompt: z.string().min(1).describe("What to change, e.g. 'change the time of day to golden hour', 'remove the cup', 'make it snow'."),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Flow shows no quote for edits, so max_credits cannot protect you: a 4 s clip cost 20 credits when measured. The real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
  },
  continue_shot: {
    project: z.string().min(1).describe("Local folder for the new clip."),
    from_asset: z.string().min(1).describe("Title (or title prefix) of the video to continue from; see flow_assets."),
    prompt: z.string().min(1).describe("What happens in the new clip, written as one continuous shot with one camera move."),
    attach: z
      .array(z.string().min(1))
      .max(3)
      .optional()
      .describe("Characters or avatars to keep attached, by name, e.g. ['Me'] for your own Flow avatar or ['Pip']. This is the whole point of this tool: the normal composer cannot hold a character and a start frame at the same time."),
    aspect_ratio: z.enum(["16:9", "9:16"]).default("16:9"),
    mode: z
      .enum(["exact", "likeness"])
      .default("exact")
      .describe(
        "'exact' uses Flow's first-frame animation (I2V): the clip begins on the source clip's real last frame, invisible cut, but attached characters are IGNORED - the likeness has to come from the frame itself. 'likeness' uses reference-to-video (R2V): the character stays locked but the opening frame is only approximate. Flow cannot do both; this is a model limit, not a UI one.",
      ),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Agent mode shows no credit quote before it runs, so max_credits cannot protect you; the real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    force: z
      .boolean()
      .optional()
      .describe("Skip the guard that refuses to run when Flow already holds a fresh-looking continuation of this clip. Only pass it when you have checked the grid and genuinely want another paid take."),
  },
  project: {
    name: z.string().min(1).optional().describe("Exact title of the Flow project to open. Omit to list the projects."),
    create: z.boolean().default(false).describe("Create the project when none has that title."),
  },
  trash: { name: z.string().min(1).describe("Exact title of the item to move to Flow's Trash, as listed by flow_assets.") },
  set_key: { key: z.string().min(1).max(200) },
  channels: {},
  posts: {
    days: z.number().min(1).max(60).default(7).describe("How many days back and forward from now to look."),
  },
  publish: {
    project: z.string().min(1).describe("Project whose film to publish."),
    file: z.string().min(1).optional().describe("Absolute path of the video. Default: the newest <project>-final*.mp4 in the project folder."),
    channels: z
      .array(z.string().min(1))
      .min(1)
      .describe("Postiz channels to post to, by name, platform ('youtube', 'instagram') or id, as listed by flow_channels."),
    text: z.string().min(1).max(5000).describe("Caption / description, hashtags included."),
    title: z.string().min(2).max(100).optional().describe("Video title (YouTube needs one, 2-100 characters)."),
    when: z.string().optional().describe("When to publish, ISO 8601 with a timezone, e.g. '2026-10-28T18:00:00+00:00'. Required unless now or draft is set."),
    now: z.boolean().default(false).describe("Publish immediately. Only when the user has explicitly asked for it."),
    draft: z.boolean().default(false).describe("Create a draft in Postiz for the user to check and send by hand."),
    privacy: z.enum(["public", "unlisted", "private"]).default("public").describe("YouTube visibility."),
    made_for_kids: z.boolean().default(false).describe("YouTube 'made for kids' declaration."),
    tags: z.array(z.string().min(1)).max(30).optional().describe("YouTube tags."),
  },
  discard: { path: z.string().min(1).describe("A saved film, still, narration or whole project folder inside the films folder, to move to this computer's bin (Mac Trash, Windows Recycle Bin).") },
  outputs: {},
  characters: {},
  character_edit: {
    name: z.string().min(1).describe("Character to change, as listed by flow_characters."),
    project: z.string().min(1).optional().describe("Project folder to save the new portrait in (<project>/_cast). Default: a shared _cast folder."),
    change: z
      .string()
      .min(1)
      .max(600)
      .optional()
      .describe(
        "What to change about the look, e.g. 'make his coat red, keep everything else the same'. Leave it out to only save the character's current portrait (after a change made by hand in Flow, or one whose portrait never arrived).",
      ),
    look: z
      .string()
      .min(1)
      .max(1500)
      .optional()
      .describe(
        "The character's whole description AFTER the change, e.g. the old one with 'navy coat' swapped for 'red coat'. Scenes quote it word for word to hold the design, so a stale colour in it fights the new portrait. Without it, the change is added to the end of the old description.",
      ),
  },
  character: {
    name: z.string().min(1).max(60).describe("Character name; scenes then reference it as 'asset:<name>' in reference_images."),
    project: z.string().min(1).optional().describe("Project folder the character belongs to; its portrait is saved in <project>/_cast. Default: a shared _cast folder."),
    describe: z
      .string()
      .max(1200)
      .optional()
      .describe("What the character looks like. Flow draws the portrait first (free image), then builds the character from it. Use this or `image`."),
    image: z
      .string()
      .min(1)
      .optional()
      .describe("Existing picture instead of `describe`: absolute path, or 'asset:<title>' of an image already in the Flow project."),
    aspect_ratio: z.enum(["3:4", "1:1", "9:16", "16:9", "4:3"]).optional().describe("Frame for the drawn portrait when using `describe`. Default 3:4."),
    personality: z.string().max(500).optional().describe("How the character acts; Flow uses it when crafting scenes."),
    voice: z.string().optional().describe("Flow voice name, e.g. 'Charon' (male, informative) or 'Aoede' (female, breezy)."),
  },
  techniques: { category: z.enum(["camera", "product", "transition", "image"]).optional() },
};

type Args<K extends keyof typeof shapes> = z.infer<z.ZodObject<(typeof shapes)[K]>>;

export const jobView = ({ id, status, params, files, attempts, credits, progress, note, error }: Job) => ({
  id,
  status,
  project: params.output_dir,
  scene: params.file_stem,
  prompt: params.prompt,
  attempts,
  credits,
  progress,
  files,
  note,
  error,
});

// One implementation runs in whichever process owns the Flow tab; the other process talks to it over HTTP (remote.ts).
export interface Core {
  status(a: Args<"status">): Promise<unknown>;
  generate(a: Args<"generate">): Promise<unknown>;
  wait(a: Args<"wait">): Promise<unknown>;
  cancel(a: Args<"cancel">): Promise<unknown>;
  retry(a: Args<"retry">): Promise<unknown>;
  assets(a: Args<"assets">): Promise<unknown>;
  download(a: Args<"download">): Promise<unknown>;
  assemble(a: Args<"assemble">): Promise<unknown>;
  techniques(a: Args<"techniques">): Promise<unknown>;
  voices(): Promise<unknown>;
  narrate(a: Args<"narrate">): Promise<unknown>;
  character(a: Args<"character">): Promise<unknown>;
  characters(): Promise<unknown>;
  character_edit(a: Args<"character_edit">): Promise<unknown>;
  edit(a: Args<"edit">): Promise<unknown>;
  project(a: Args<"project">): Promise<unknown>;
  trash(a: Args<"trash">): Promise<unknown>;
  discard(a: Args<"discard">): Promise<unknown>;
  set_key(a: Args<"set_key">): Promise<unknown>;
  channels(): Promise<unknown>;
  posts(a: Args<"posts">): Promise<unknown>;
  publish(a: Args<"publish">): Promise<unknown>;
  continue_shot(a: Args<"continue_shot">): Promise<unknown>;
  agent(a: Args<"agent">): Promise<unknown>;
  outputs(): Promise<unknown>;
}

// Flow's own voices: still offered when giving a character a voice, but narration no longer goes through Flow.
export const VOICES = [
  { name: "Achernar", description: "female, soft, high pitch" },
  { name: "Achird", description: "male, friendly, mid pitch" },
  { name: "Algenib", description: "male, gravelly, low pitch" },
  { name: "Algieba", description: "male, easy-going, mid-low pitch" },
  { name: "Alnilam", description: "male, firm, mid-low pitch" },
  { name: "Aoede", description: "female, breezy, mid pitch" },
  { name: "Autonoe", description: "female, bright, mid pitch" },
  { name: "Callirrhoe", description: "female, easy-going, mid pitch" },
  { name: "Charon", description: "male, informative, lower pitch" },
  { name: "Despina", description: "female, smooth, mid pitch" },
  { name: "Enceladus", description: "male, breathy, lower pitch" },
  { name: "Erinome", description: "female, clear, mid pitch" },
  { name: "Fenrir", description: "male, excitable, younger pitch" },
  { name: "Gacrux", description: "female, mature, mid pitch" },
  { name: "Iapetus", description: "male, clear, mid-low pitch" },
];

const BUSY = "A generation is running in the Flow tab. Wait for it to finish (flow_wait), then retry.";

export class LocalCore implements Core {
  private queue: JobQueue = new JobQueue(async (job) => {
    const { chain_from, reference_from } = job.params;
    if (reference_from) {
      const still = this.queue.get(reference_from)?.files.find((f) => /\.(jpe?g|png|webp)$/i.test(f));
      if (!still) throw new Error(`reference_previous: the previous scene (${reference_from}) produced no image.`);
      job.params.reference_images = [still, ...(job.params.reference_images ?? [])].slice(0, 3);
    }
    if (chain_from) {
      const clip = this.queue.get(chain_from)?.files.find((f) => /\.(mp4|webm|mov)$/i.test(f));
      if (!clip) throw new Error(`chain_previous: the previous scene (${chain_from}) produced no video, so this scene was skipped.`);
      job.params.first_frame = await extractLastFrame(clip);
    }
    if (job.params.continue_from) return runContinue(job);
    if (job.params.agent_scenes) return runAgentBatch(job);
    if (job.params.edit_asset) return runEdit(job);
    return runGeneration(job);
  });

  async status({ detailed }: Args<"status">) {
    const flow = await getFlowState(detailed && !this.queue.busy);
    return { flow, pacing: this.queue.pausedReason, output_root: OUTPUT_ROOT, jobs: this.queue.list().map(jobView) };
  }

  async generate({ project, scenes }: Args<"generate">) {
    const invalid = scenes.findIndex((s, i) => s.chain_previous && (i === 0 || s.first_frame || s.type === "image"));
    if (invalid >= 0) {
      throw new Error(`Scene ${invalid + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.`);
    }
    const noPrev = scenes.findIndex((s, i) => s.reference_previous && i === 0);
    if (noPrev >= 0) throw new Error("Scene 1 has no previous scene to reference.");
    const unknown = scenes.find((s) => s.technique && !techniqueById(s.technique));
    if (unknown) throw new Error(`Unknown technique "${unknown.technique}". Call flow_techniques for valid ids.`);

    const output_dir = projectDir(project);
    // Continue numbering after whatever is already on disk or queued, so reruns never overwrite earlier scenes.
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(/^scene-(\d+)/)?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir).map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
    const offset = Math.max(0, ...onDisk, ...queued);
    const jobs: Job[] = [];
    for (const [i, { chain_previous, reference_previous, technique, ...scene }] of scenes.entries()) {
      const phrase = technique ? techniqueById(technique)!.phrase : "";
      // A referenced character must come out identical, not merely similar, so the scene says so explicitly. The
      // wording stays medium-neutral: the same lock has to serve a flat cartoon character and a photoreal avatar.
      const cast = (scene.reference_images ?? [])
        .filter((r) => r.startsWith("asset:"))
        .map((r) => r.slice(6).trim())
        .filter((n) => characterLook(n) !== undefined || /^[\w .'-]{1,60}$/.test(n));
      const lock = cast.length
        ? ` CHARACTER LOCK — ${cast.join(" and ")} must match the reference image exactly, as if copying it: same head shape and size, same face, same eyes, same hair, same skin, same build and proportions, same clothing items in the same colours, same hands, and the same rendering style and level of realism as the reference. Never redesign, restyle, re-proportion, re-age or re-colour them, and never swap an item for a similar one.${cast
            .map((n) => (characterLook(n) ? ` ${n} is exactly: ${characterLook(n)}.` : ""))
            .join("")}`
        : "";
      const inherit = reference_previous
        ? " Match the previous image exactly for the subject's appearance, colour palette, lighting and rendering style; this is the same scene a moment later."
        : "";
      jobs.push(
        this.queue.add({
          ...scene,
          prompt: `${scene.prompt.trim().replace(/\.?$/, ".")}${phrase ? ` ${phrase}` : ""}${lock}${inherit}`,
          chain_from: chain_previous ? jobs[i - 1].id : undefined,
          reference_from: reference_previous ? jobs[i - 1].id : undefined,
          output_dir,
          file_stem: `scene-${String(offset + i + 1).padStart(2, "0")}`,
        }),
      );
    }
    return { output_dir, jobs: jobs.map(jobView) };
  }

  async wait({ job_ids, timeout_seconds }: Args<"wait">) {
    const pick = () => (job_ids ? job_ids.map((id) => this.queue.get(id)).filter((j): j is Job => Boolean(j)) : this.queue.list());
    const deadline = Date.now() + timeout_seconds * 1000;
    while (Date.now() < deadline && pick().some((j) => j.status === "queued" || j.status === "running")) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    const jobs = pick();
    return {
      finished: jobs.every((j) => j.status !== "queued" && j.status !== "running"),
      pacing: this.queue.pausedReason,
      jobs: jobs.map(jobView),
    };
  }

  async cancel({ job_id }: Args<"cancel">) {
    const job = this.queue.cancel(job_id);
    if (!job) throw new Error(`No job with id ${job_id}. Use flow_status to list jobs.`);
    return jobView(job);
  }

  async retry({ job_ids }: Args<"retry">) {
    const ids = job_ids ?? this.queue.list().filter((j) => j.status === "failed").map((j) => j.id);
    const jobs = ids.map((id) => this.queue.retry(id)).filter((j): j is Job => Boolean(j));
    if (!jobs.length) throw new Error("No failed jobs to retry.");
    return { jobs: jobs.map(jobView) };
  }

  async assets({ kind }: Args<"assets">) {
    if (this.queue.busy) throw new Error(BUSY);
    return (await listAssets()).filter((a) => !kind || a.kind === kind).map(({ name, kind }) => ({ name, kind }));
  }

  async download({ project, assets, quality }: Args<"download">) {
    if (this.queue.busy) throw new Error(BUSY);
    const dir = projectDir(project);
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    // Numbering from 1 every call overwrote clips fetched earlier - it destroyed a finished shot once. Carry on from
    // the highest clip-NN already on disk instead.
    let next = Math.max(0, ...readdirSync(dir).map((f) => Number(f.match(/^clip-(\d+)/)?.[1] ?? 0))) + 1;
    for (const name of assets) {
      try {
        files.push(...(await downloadAsset(name, join(dir, `clip-${String(next++).padStart(2, "0")}`), quality)));
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : err} (downloaded so far: ${files.length})`);
      }
    }
    return { dir, files };
  }

  async assemble({ project, ...rest }: Args<"assemble">) {
    return assemble({ dir: projectDir(project), ...rest, output_name: rest.output_name ?? `${project}-final` });
  }

  // Everything already downloaded, newest project first, so the panel can show past work after a restart.
  async outputs() {
    if (!existsSync(OUTPUT_ROOT)) return { root: OUTPUT_ROOT, projects: [] };
    const media = /\.(mp4|webm|mov|gif|jpe?g|png|webp|m4a|mp3|wav|aiff?)$/i;
    const projects = readdirSync(OUTPUT_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = join(OUTPUT_ROOT, d.name);
        const files = readdirSync(dir)
          .filter((f) => media.test(f) && !f.endsWith("-lastframe.jpg"))
          .map((f) => ({ name: f, path: join(dir, f), kind: /\.(mp4|webm|mov)$/i.test(f) ? "video" : /\.(m4a|mp3|wav|aiff?)$/i.test(f) ? "audio" : "image", mtime: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { name: d.name, dir, files, mtime: Math.max(0, ...files.map((f) => f.mtime)) };
      })
      .filter((p) => p.files.length)
      .sort((a, b) => b.mtime - a.mtime);
    return { root: OUTPUT_ROOT, projects };
  }

  private nextStem(output_dir: string, prefix: string): string {
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(new RegExp(`^${prefix}-(\\d+)`))?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir && j.params.file_stem.startsWith(prefix)).map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
    return `${prefix}-${String(Math.max(0, ...onDisk, ...queued) + 1).padStart(2, "0")}`;
  }

  async agent({ project, scenes, aspect_ratio, download_quality }: Args<"agent">) {
    const output_dir = projectDir(project);
    const job = this.queue.add({
      prompt: `Agent batch: ${scenes.length} images`,
      type: "image",
      max_credits: 0,
      aspect_ratio,
      download_quality,
      agent_scenes: scenes,
      output_dir,
      file_stem: this.nextStem(output_dir, "scene"),
    });
    return { output_dir, jobs: [jobView(job)] };
  }

  async edit({ project, asset, prompt, download_quality }: Args<"edit">) {
    const output_dir = projectDir(project);
    const job = this.queue.add({ prompt, type: "video", max_credits: 0, edit_asset: asset, download_quality, output_dir, file_stem: this.nextStem(output_dir, "edit") });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Flow's composer takes a start frame OR a character, never both; agent mode takes both, so this goes that way.
  async continue_shot({ project, from_asset, prompt, attach, aspect_ratio, mode, download_quality, force }: Args<"continue_shot">) {
    // A lost queue entry is not proof that nothing ran: when the owner process is replaced mid-job the job vanishes
    // while Flow carries on and charges for it. Re-running then spends twice, which is exactly what happened on
    // 2026-09-20. Flow's own grid is the only honest record, so ask it before starting another paid generation.
    if (!force) {
      const recent = (await listAssets()).slice(0, 6).filter((a) => a.kind === "video");
      const source = from_asset.toLowerCase();
      const echo = recent.find((a) => {
        const n = a.name.toLowerCase();
        return n !== source && !n.startsWith(source) && words(n).some((w) => words(source).includes(w));
      });
      if (echo) {
        throw new Error(
          `Flow already holds a recent clip called "${echo.name}", which looks like a continuation of "${from_asset}" that may have just been generated and charged for. ` +
            `Check it with flow_assets / flow_download before spending again. Pass force: true if you really do want another take.`,
        );
      }
    }
    const output_dir = projectDir(project);
    const job = this.queue.add({
      prompt,
      type: "video",
      max_credits: 0,
      continue_from: from_asset,
      attach,
      continue_mode: mode,
      aspect_ratio,
      download_quality,
      output_dir,
      file_stem: this.nextStem(output_dir, "shot"),
    });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Moves a file or a project folder from the films folder to the system's bin - recoverable from there, never
  // erased. Anything outside the films folder is refused, so a bad path can never reach the rest of the Mac.
  async discard({ path }: Args<"discard">) {
    const target = resolve(path);
    // relative() works with either separator; a path that climbs out ("..") or lands on another drive is refused.
    const rel = relative(OUTPUT_ROOT, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Only things inside your films folder can be moved to the bin from here.");
    if (!existsSync(target)) throw new Error("That file is already gone.");
    return { trashed: target, to: moveToBin(target), bin: BIN };
  }

  async project({ name, create }: Args<"project">) {
    if (this.queue.busy) throw new Error(BUSY);
    return openProject(name, create);
  }

  async trash({ name }: Args<"trash">) {
    if (this.queue.busy) throw new Error(BUSY);
    return trashAsset(name);
  }

  async channels() {
    return listChannels();
  }

  async posts({ days }: Args<"posts">) {
    const span = days * 86_400_000;
    return listPosts(new Date(Date.now() - span), new Date(Date.now() + span));
  }

  // Publishing is public and cannot be taken back from here, so nothing goes out "now" unless asked for in so many
  // words: a time (schedule) or a draft is required otherwise.
  async publish({ project, file, channels, text, title, when, now, draft, privacy, made_for_kids, tags }: Args<"publish">) {
    if (!when && !now && !draft) throw new Error("Say when to publish (when: an ISO time), or set draft: true. now: true only if the user explicitly asked to post immediately.");
    if (when && Number.isNaN(Date.parse(when))) throw new Error(`'${when}' is not a time I can read. Use ISO 8601, e.g. 2026-10-28T18:00:00+00:00.`);
    if (when && !now && !draft && Date.parse(when) < Date.now() + 60_000) throw new Error(`${when} is in the past (or under a minute away). Pick a later time or use now: true.`);
    const dir = projectDir(project);
    const video =
      file ??
      (existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.startsWith(`${project}-final`) && f.endsWith(".mp4"))
            .map((f) => join(dir, f))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
        : undefined);
    if (!video || !existsSync(video)) throw new Error(`No final render found for ${project}. Pass file, or render it with flow_assemble first.`);

    const all = await listChannels();
    const picked = channels.map((want) => {
      const w = want.toLowerCase();
      const hits = all.filter((c) => !c.disabled && (c.id === want || c.name.toLowerCase() === w || c.identifier === w || c.profile?.toLowerCase() === w));
      if (hits.length !== 1) {
        throw new Error(
          `${hits.length ? `"${want}" matches ${hits.length} channels` : `No connected channel "${want}"`}. Connected: ${all.map((c) => `${c.name} (${c.identifier})`).join(", ") || "none"}.`,
        );
      }
      return hits[0];
    });

    const media = await uploadMedia(video);
    const created = await createPost({ channels: picked, media, text, title, when: now ? undefined : when, draft, privacy, made_for_kids, tags });
    return {
      published: now ? "now" : draft ? "draft" : `scheduled for ${new Date(when!).toISOString()}`,
      video,
      channels: picked.map((c) => `${c.name} (${c.identifier})`),
      media: media.path,
      postiz: created,
    };
  }

  async character(a: Args<"character">) {
    if (this.queue.busy) throw new Error(BUSY);
    if (!a.image && !a.describe) throw new Error("Pass either `describe` (Flow draws the portrait) or `image`.");
    const made = await createCharacter(a);
    if (a.describe) rememberCharacter(a.name, a.describe);
    return { ...made, use_as: `asset:${a.name}` };
  }

  async character_edit({ name, project, change, look }: Args<"character_edit">) {
    if (this.queue.busy) throw new Error(BUSY);
    const out = await editCharacter(name, change, undefined, project);
    // Every scene that references the character quotes this description in its character lock, so it has to describe
    // the NEW look - "deep navy coat" left in it would argue with a portrait whose coat is now red.
    if (look) rememberCharacter(name, look);
    else if (change) rememberCharacter(name, `${characterLook(name) ?? ""} Changed since, and this wins over anything above: ${change.replace(/[.\s]+$/, "")}`.trim());
    return { ...out, use_as: `asset:${name}` };
  }

  async characters() {
    if (this.queue.busy) throw new Error(BUSY);
    return (await listCharacters()).map((name) => ({ name, use_as: `asset:${name}` }));
  }

  // Panel only: deliberately NOT registered as an MCP tool, so a key typed into Flow Studio never reaches Claude.
  async set_key({ key }: Args<"set_key">) {
    return saveGeminiKey(key);
  }

  async voices() {
    // The panel words itself from these, so a PC never reads "this Mac".
    const place = { computer: COMPUTER, bin: BIN, local_engine: IS_MAC ? "macOS voice" : IS_WIN ? "Windows voice" : "System voice", platform: process.platform };
    return { gemini: GEMINI_VOICES, gemini_ready: Boolean(geminiKey()), mac: await localVoices(), place };
  }

  async narrate({ project, text, voice, engine, style, max_pause }: Args<"narrate">) {
    const output_dir = projectDir(project);
    mkdirSync(output_dir, { recursive: true });
    // 2026-10-26: two narrations started together both got narration-07 (the number comes from what is on disk, and
    // a take only lands when it is finished), so the later one overwrote the earlier. The file is now reserved the
    // moment its number is picked: an exclusive create fails if another call took it, and we try the next number.
    let target = "";
    for (let tries = 0; !target && tries < 50; tries++) {
      const candidate = join(output_dir, `${this.nextStem(output_dir, "narration")}.m4a`);
      try {
        writeFileSync(candidate, "", { flag: "wx" });
        target = candidate;
      } catch {
        // taken a moment ago: nextStem now sees it on disk and moves on
      }
    }
    if (!target) throw new Error(`Could not reserve a narration file name in ${output_dir}.`);
    try {
      const spoken = engine === "mac" ? await speakLocally(text.trim(), voice, target) : await speakWithGemini(text.trim(), voice, target, style);
      if (max_pause) spoken.duration = await tightenPauses(target, max_pause);
      // What the take really says, so a paraphrase is caught here and not by the viewer. Best effort: a failed
      // check never costs the take.
      const heard = engine === "gemini" ? await transcribeWithGemini(target).catch((e: Error) => `(not checked: ${e.message})`) : undefined;
      return { output_dir, credits: 0, engine, voice, ...spoken, ...(heard !== undefined && { heard }) };
    } catch (err) {
      rmSync(target, { force: true });
      throw err;
    }
  }

  async techniques({ category }: Args<"techniques">) {
    return TECHNIQUES.filter((t) => !category || t.category === category);
  }
}
