import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

// ── Types ──

export type RegexRule = {
  name: string;
  pattern: string;
  flags: string;
  replacement: string;
  enabled: boolean;
  description: string;
  stage?: string;
};

export type CharacterCardEntry = {
  filename: string;
  name: string;
};

export type CharacterMatchResult =
  | { status: "missing"; input: string }
  | { status: "ambiguous"; input: string; matches: CharacterCardEntry[] }
  | { status: "matched"; filename: string };

export type QqJsonAttachmentRef = {
  filename: string;
  fileId: string | null;
};

export type NaturalCharacterCommand =
  | { kind: "list" }
  | { kind: "show" }
  | { kind: "set"; target: string };

export type NormalizedWorldbookEntry = {
  comment: string;
  keys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  order: number;
  sticky: number;
};

export type DiscordAttachmentRef = {
  url: string;
  filename: string;
  contentType: string | null;
};

// ── Constants ──

export const REGEX_FLAGS_PATTERN = /^[dgimsuvy]*$/;
export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const TAVERN_CHAT_API_PREFIX = "/api/channels/tavern-chat";
export const MAX_CHARACTER_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_WORLDBOOK_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_REGEX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_PROMPT_CHARS = 24_000;
export const MAX_CHARACTER_VALUE_CHARS = 3_000;
export const MAX_WORLD_ENTRY_CONTENT_CHARS = 900;
export const MAX_WORLD_ENTRIES = 64;
export const MAX_WORLD_SECTION_CHARS = 16_000;
export const MAX_QQ_MEDIA_FETCH_BYTES = 20 * 1024 * 1024;
export const QQ_MEDIA_SEGMENT_PATTERN = /\[CQ:(image|file),([^\]]+)\]/g;
export const OPENCLAW_MEDIA_PATH_PATTERN = /\[OPENCLAW_MEDIA_PATH:([^\]\r\n]+)\]/g;
export const JSON_ATTACHMENT_TOOL_GUARD_TTL_MS = 3 * 60 * 1000;

export const CHARACTER_CREATE_ACTIONS = new Set([
  "create", "new", "write", "generate", "make",
  "\u521b\u5efa", "\u65b0\u5efa", "\u65b0\u589e", "\u751f\u6210", "\u5199", "\u81ea\u521b",
]);
export const CHARACTER_SWITCH_ACTION = "\u5207\u6362";
export const CHARACTER_CLEAR_TEXT_TRIGGERS = [
  "\u6e05\u7a7a\u89d2\u8272\u5361", "\u53d6\u6d88\u89d2\u8272\u5361", "\u4e0d\u7528\u89d2\u8272\u5361",
];
export const CHARACTER_CLEAR_ACTIONS = new Set<string>([
  "clear", "unset", "none", "\u6e05\u7a7a", ...CHARACTER_CLEAR_TEXT_TRIGGERS,
]);
export const CHARACTER_CLEAR_COMMAND_BODIES = new Set<string>(
  CHARACTER_CLEAR_TEXT_TRIGGERS.map((e) => e.toLowerCase()),
);
export const CHARACTER_TEXT_TRIGGERS = [
  "\u5207\u6362\u89d2\u8272\u5361", "\u6362\u89d2\u8272\u5361", "\u6362\u4eba\u8bbe",
  "\u5217\u51fa\u89d2\u8272\u5361", "\u67e5\u770b\u89d2\u8272\u5361", "\u89d2\u8272\u5361\u5217\u8868",
  ...CHARACTER_CLEAR_TEXT_TRIGGERS,
];
export const WORLDBOOK_SWITCH_ACTION = "\u5207\u6362";
export const WORLDBOOK_CLEAR_TEXT_TRIGGERS = [
  "\u6e05\u7a7a\u4e16\u754c\u4e66", "\u6e05\u7a7a\u4e16\u754c\u5361",
  "\u53d6\u6d88\u4e16\u754c\u4e66", "\u4e0d\u7528\u4e16\u754c\u4e66",
];
export const WORLDBOOK_CLEAR_ACTIONS = new Set<string>([
  "clear", "unset", "none", "\u6e05\u7a7a", ...WORLDBOOK_CLEAR_TEXT_TRIGGERS,
]);
export const WORLDBOOK_CLEAR_COMMAND_BODIES = new Set<string>(
  WORLDBOOK_CLEAR_TEXT_TRIGGERS.map((e) => e.toLowerCase()),
);
export const WORLDBOOK_TEXT_TRIGGERS = [
  "\u5207\u6362\u4e16\u754c\u4e66", "\u5207\u6362\u4e16\u754c\u89c2", "\u6362\u4e16\u754c\u4e66",
  "\u5217\u51fa\u4e16\u754c\u4e66", "\u67e5\u770b\u4e16\u754c\u4e66", "\u4e16\u754c\u4e66\u5217\u8868",
  ...WORLDBOOK_CLEAR_TEXT_TRIGGERS,
];

// ── Generic Utilities ──

export function sanitizeFilename(input: string): string {
  const base = path.basename(input.replaceAll("\\", "/"));
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function listFilesByExtensions(dir: string, allowed: string[]): Promise<string[]> {
  await ensureDir(dir);
  const set = new Set(allowed.map((e) => e.toLowerCase()));
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && set.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

export async function fileExists(filePath: string): Promise<boolean> {
  try { return (await stat(filePath)).isFile(); }
  catch { return false; }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

export function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((e) => asString(e)).filter((e): e is string => Boolean(e))
      .map((e) => normalizeWhitespace(e)).filter(Boolean);
  }
  const single = asString(value);
  if (!single) return [];
  return single.split(",").map((e) => normalizeWhitespace(e)).filter(Boolean);
}

export function pickPromptString(source: Record<string, unknown>, paths: string[][]): string | null {
  for (const p of paths) {
    let cursor: unknown = source;
    for (const key of p) {
      const obj = asRecord(cursor);
      if (!obj) { cursor = null; break; }
      cursor = obj[key];
    }
    const v = asString(cursor);
    if (v) return v;
  }
  return null;
}

export function pickPromptStringList(source: Record<string, unknown>, paths: string[][]): string[] {
  for (const p of paths) {
    let cursor: unknown = source;
    for (const key of p) {
      const obj = asRecord(cursor);
      if (!obj) { cursor = null; break; }
      cursor = obj[key];
    }
    if (Array.isArray(cursor)) {
      const values = cursor.map((e) => asString(e)).filter((e): e is string => Boolean(e))
        .map((e) => normalizeWhitespace(e));
      if (values.length > 0) return values;
      continue;
    }
    const single = asString(cursor);
    if (single) {
      const values = single.split(",").map((e) => normalizeWhitespace(e)).filter(Boolean);
      if (values.length > 0) return values;
    }
  }
  return [];
}

export function splitActionAndRest(input: string): { action: string; rest: string } {
  const trimmed = input.trim();
  if (!trimmed) return { action: "", rest: "" };
  const space = trimmed.indexOf(" ");
  if (space < 0) return { action: trimmed.toLowerCase(), rest: "" };
  return { action: trimmed.slice(0, space).toLowerCase(), rest: trimmed.slice(space + 1).trim() };
}

export function normalizeCommandBodyForMatch(input: string | undefined): string {
  if (!input) return "";
  return input.trim().replace(/[\u3002\uff01\uff1f?!]+$/g, "").replace(/\s+/g, " ").toLowerCase();
}

export function matchesAnyCommandBody(input: string | undefined, expected: ReadonlySet<string>): boolean {
  const normalized = normalizeCommandBodyForMatch(input);
  return normalized ? expected.has(normalized) : false;
}

export function normalizeOptionalFilename(value: unknown): string | null {
  return asString(value)?.trim() || null;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function isPngLikeRef(value?: string): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return lower.endsWith(".png") || /\.png(\?|$)/.test(lower);
}

export function isJsonLikeRef(value?: string): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return lower.endsWith(".json") || /\.json(\?|$)/.test(lower);
}

export function isPngBuffer(bytes: Buffer): boolean {
  return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

export function normalizeAttachmentFilename(value: string): string {
  const withoutQuery = value.split("?")[0] ?? value;
  const decoded = (() => { try { return decodeURIComponent(withoutQuery); } catch { return withoutQuery; } })();
  return sanitizeFilename(path.basename(decoded.replaceAll("\\", "/")));
}

export function collectTextFields(value: unknown): string[] {
  const out: string[] = [];
  if (typeof value === "string") { const t = value.trim(); if (t) out.push(t); return out; }
  const record = asRecord(value);
  if (!record) return out;
  for (const key of ["content", "Content", "rawBody", "RawBody", "body", "Body", "text", "Text", "raw", "Raw", "message", "Message"]) {
    const field = asString(record[key]);
    if (field) out.push(field);
  }
  for (const nk of ["ctx", "payload", "context", "message"]) {
    const nested = asRecord(record[nk]);
    if (nested) out.push(...collectTextFields(nested));
  }
  return out;
}

export function normalizeRegexFlags(value?: string): string {
  const raw = (value ?? "g").trim();
  if (!REGEX_FLAGS_PATTERN.test(raw)) throw new Error(`Invalid regex flags: ${raw}`);
  const deduped: string[] = [];
  for (const flag of raw) { if (!deduped.includes(flag)) deduped.push(flag); }
  return deduped.join("") || "g";
}

export function getFetchFn():
  | ((input: string, init?: { redirect?: "follow"; headers?: Record<string, string> }) => Promise<any>)
  | null {
  const fetchFn = (globalThis as any).fetch;
  return typeof fetchFn === "function" ? fetchFn : null;
}

export async function readMediaRefBuffer(
  mediaRef: string,
  headers?: Record<string, string>,
): Promise<Buffer | null> {
  if (isHttpUrl(mediaRef)) {
    const fetchFn = getFetchFn();
    if (!fetchFn) return null;
    const response = await fetchFn(mediaRef, { redirect: "follow", headers });
    if (!response.ok) return null;
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_QQ_MEDIA_FETCH_BYTES) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_QQ_MEDIA_FETCH_BYTES) return null;
    return bytes;
  }
  return await readFile(mediaRef);
}

// ── HTTP Helpers ──

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function decodeUrlPath(value: string): string | null {
  try { return decodeURIComponent(value); } catch { return null; }
}

export function toHeaderRecord(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") { out[key] = value; continue; }
    if (Array.isArray(value) && value.length > 0) out[key] = value.join(", ");
  }
  return out;
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) { raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); }
  return raw.trim() ? JSON.parse(raw) as unknown : {};
}

export async function readUploadedFile(params: {
  req: IncomingMessage;
  requestPath: string;
  maxBytes: number;
}): Promise<{ filename: string; bytes: Buffer }> {
  const request = new Request(`http://localhost${params.requestPath}`, {
    method: params.req.method ?? "POST",
    headers: toHeaderRecord(params.req.headers),
    body: Readable.toWeb(params.req as unknown as Readable) as unknown as BodyInit,
    duplex: "half",
  });
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("Missing uploaded file field: file");
  if (file.size > params.maxBytes) throw new Error("File too large");
  const filename = sanitizeFilename(file.name);
  if (!filename) throw new Error("Invalid filename");
  return { filename, bytes: Buffer.from(await file.arrayBuffer()) };
}
