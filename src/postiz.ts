import { existsSync, openAsBlob, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { HOME_DIR } from "./chrome.js";

// Publishing through the user's own Postiz (set up 2026-10-26: self-hosted in Docker, public at
// https://postiz.ygassets.co.uk through a Cloudflare tunnel). Postiz holds the channel logins (YouTube, Instagram);
// flow-mcp only uploads the finished film and creates the post through Postiz's public API.
// The API key is written by the user into ~/.flow-mcp/postiz-key and never passes through Claude, like the Gemini key.
const KEY_FILE = join(HOME_DIR, "postiz-key");
const URL_FILE = join(HOME_DIR, "postiz-url");

function config(): { base: string; key: string } {
  const key = (process.env.POSTIZ_API_KEY ?? (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8") : "")).trim();
  const base = (process.env.POSTIZ_URL ?? (existsSync(URL_FILE) ? readFileSync(URL_FILE, "utf8") : "")).trim().replace(/\/+$/, "");
  if (!base) throw new Error(`No Postiz address yet. Put it (e.g. https://postiz.example.com) in ${URL_FILE}.`);
  if (!key) {
    throw new Error(
      `No Postiz API key yet. In Postiz open Settings -> Public API, copy the key, and save it on its own in ${KEY_FILE}. ` +
        `Do it yourself - never paste the key into a chat.`,
    );
  }
  return { base, key };
}

// Self-hosted Postiz serves the public API under /api; the hosted service at api.postiz.com does not.
const apiUrl = (base: string, path: string) => `${base}${/api\.postiz\.com/.test(base) ? "" : "/api"}/public/v1${path}`;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { base, key } = config();
  const res = await fetch(apiUrl(base, path), { ...init, headers: { Authorization: key, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the raw text for the error message
  }
  if (!res.ok) {
    const detail = typeof body === "object" && body && "message" in body ? String((body as { message: unknown }).message) : String(text).slice(0, 300);
    throw new Error(`Postiz answered ${res.status} for ${path}: ${detail}${res.status === 401 ? " (check the key in postiz-key)" : ""}`);
  }
  return body as T;
}

export interface PostizChannel {
  id: string;
  name: string;
  identifier: string; // platform: youtube, instagram, instagram-standalone, x, ...
  profile?: string;
  disabled?: boolean;
}

export async function listChannels(): Promise<PostizChannel[]> {
  const all = await call<PostizChannel[]>("/integrations");
  return all.map(({ id, name, identifier, profile, disabled }) => ({ id, name, identifier, profile, disabled }));
}

export async function uploadMedia(file: string): Promise<{ id: string; path: string }> {
  const form = new FormData();
  form.append("file", await openAsBlob(file, { type: /\.mp4$/i.test(file) ? "video/mp4" : "application/octet-stream" }), basename(file));
  return call<{ id: string; path: string }>("/upload", { method: "POST", body: form });
}

// What happened to the posts in a time window: QUEUE, PUBLISHED or ERROR, and the live link once published
// (first test 2026-10-27: PUBLISHED with releaseURL https://www.youtube.com/watch?v=...). Postiz's own log stays silent
// about a successful publish, so this is the place to look.
export async function listPosts(from: Date, to: Date): Promise<unknown[]> {
  const q = new URLSearchParams({ startDate: from.toISOString(), endDate: to.toISOString() });
  const body = await call<{ posts?: Record<string, unknown>[] } | Record<string, unknown>[]>(`/posts?${q}`);
  const posts = Array.isArray(body) ? body : (body.posts ?? []);
  return posts.map((p) => ({
    id: p.id,
    state: p.state,
    publishDate: p.publishDate,
    link: p.releaseURL ?? null,
    error: p.error ?? null,
    channel: (p.integration as { name?: string } | undefined)?.name,
  }));
}

export interface PublishOptions {
  channels: PostizChannel[];
  media: { id: string; path: string };
  text: string;
  title?: string;
  when?: string; // ISO time; omitted = post now
  draft?: boolean;
  privacy?: "public" | "unlisted" | "private";
  made_for_kids?: boolean;
  tags?: string[];
}

// Each platform needs its own settings block, keyed by the channel's identifier.
function settingsFor(c: PostizChannel, o: PublishOptions): Record<string, unknown> {
  const tags = (o.tags ?? []).map((t) => ({ value: t, label: t }));
  if (c.identifier === "youtube") {
    if (!o.title || o.title.length < 2 || o.title.length > 100) throw new Error("YouTube needs a title of 2-100 characters.");
    return { __type: "youtube", title: o.title, type: o.privacy ?? "public", selfDeclaredMadeForKids: o.made_for_kids ? "yes" : "no", tags };
  }
  if (c.identifier === "instagram" || c.identifier === "instagram-standalone") return { __type: c.identifier, post_type: "post", collaborators: [] };
  return { __type: c.identifier };
}

export async function createPost(o: PublishOptions): Promise<unknown> {
  const type = o.draft ? "draft" : o.when ? "schedule" : "now";
  const date = o.when ? new Date(o.when).toISOString() : new Date().toISOString();
  return call("/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type,
      date,
      shortLink: false,
      tags: [],
      posts: o.channels.map((c) => ({
        integration: { id: c.id },
        value: [{ content: o.text, image: [o.media] }],
        settings: settingsFor(c, o),
      })),
    }),
  });
}
