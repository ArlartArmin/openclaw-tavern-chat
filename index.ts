import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { inflateSync } from "node:zlib";

type RegexRule = {
  name: string;
  pattern: string;
  flags: string;
  replacement: string;
  enabled: boolean;
  description: string;
  stage?: string;
};

type CharacterCardEntry = {
  filename: string;
  name: string;
};

type CharacterMatchResult =
  | { status: "missing"; input: string }
  | { status: "ambiguous"; input: string; matches: CharacterCardEntry[] }
  | { status: "matched"; filename: string };

type QqJsonAttachmentRef = {
  filename: string;
  fileId: string | null;
};

const REGEX_FLAGS_PATTERN = /^[dgimsuvy]*$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TAVERN_CHAT_API_PREFIX = "/api/channels/tavern-chat";
const MAX_CHARACTER_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_WORLDBOOK_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_REGEX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_CHARS = 24_000;
const MAX_CHARACTER_VALUE_CHARS = 3_000;
const MAX_WORLD_ENTRY_CONTENT_CHARS = 900;
const MAX_WORLD_ENTRIES = 64;
const MAX_WORLD_SECTION_CHARS = 16_000;
const MAX_QQ_MEDIA_FETCH_BYTES = 20 * 1024 * 1024;
const QQ_MEDIA_SEGMENT_PATTERN = /\[CQ:(image|file),([^\]]+)\]/g;
const OPENCLAW_MEDIA_PATH_PATTERN = /\[OPENCLAW_MEDIA_PATH:([^\]\r\n]+)\]/g;
const JSON_ATTACHMENT_TOOL_GUARD_TTL_MS = 3 * 60 * 1000;
const jsonAttachmentToolGuardSessions = new Map<string, number>();

/**
 * Sticky tracking: sessionKey -> Map<entryKey, remainingTurns>
 * When a non-constant entry is triggered by keyword match and has sticky > 0,
 * it stays injected for that many additional turns even without keyword match.
 */
const worldbookStickyState = new Map<string, Map<string, number>>();
const CHARACTER_CREATE_ACTIONS = new Set([
  "create",
  "new",
  "write",
  "generate",
  "make",
  "\u521b\u5efa",
  "\u65b0\u5efa",
  "\u65b0\u589e",
  "\u751f\u6210",
  "\u5199",
  "\u81ea\u521b",
]);
const CHARACTER_SWITCH_ACTION = "\u5207\u6362";
const CHARACTER_CLEAR_TEXT_TRIGGERS = [
  "\u6e05\u7a7a\u89d2\u8272\u5361",
  "\u53d6\u6d88\u89d2\u8272\u5361",
  "\u4e0d\u7528\u89d2\u8272\u5361",
];
const CHARACTER_CLEAR_ACTIONS = new Set<string>([
  "clear",
  "unset",
  "none",
  "\u6e05\u7a7a",
  ...CHARACTER_CLEAR_TEXT_TRIGGERS,
]);
const CHARACTER_CLEAR_COMMAND_BODIES = new Set<string>(
  CHARACTER_CLEAR_TEXT_TRIGGERS.map((entry) => entry.toLowerCase()),
);

const CHARACTER_TEXT_TRIGGERS = [
  "\u5207\u6362\u89d2\u8272\u5361",
  "\u6362\u89d2\u8272\u5361",
  "\u6362\u4eba\u8bbe",
  "\u5217\u51fa\u89d2\u8272\u5361",
  "\u67e5\u770b\u89d2\u8272\u5361",
  "\u89d2\u8272\u5361\u5217\u8868",
  ...CHARACTER_CLEAR_TEXT_TRIGGERS,
];

const WORLDBOOK_SWITCH_ACTION = "\u5207\u6362";
const WORLDBOOK_CLEAR_TEXT_TRIGGERS = [
  "\u6e05\u7a7a\u4e16\u754c\u4e66",
  "\u6e05\u7a7a\u4e16\u754c\u5361",
  "\u53d6\u6d88\u4e16\u754c\u4e66",
  "\u4e0d\u7528\u4e16\u754c\u4e66",
];
const WORLDBOOK_CLEAR_ACTIONS = new Set<string>([
  "clear",
  "unset",
  "none",
  "\u6e05\u7a7a",
  ...WORLDBOOK_CLEAR_TEXT_TRIGGERS,
]);
const WORLDBOOK_CLEAR_COMMAND_BODIES = new Set<string>(
  WORLDBOOK_CLEAR_TEXT_TRIGGERS.map((entry) => entry.toLowerCase()),
);

const WORLDBOOK_TEXT_TRIGGERS = [
  "\u5207\u6362\u4e16\u754c\u4e66",
  "\u5207\u6362\u4e16\u754c\u89c2",
  "\u6362\u4e16\u754c\u4e66",
  "\u5217\u51fa\u4e16\u754c\u4e66",
  "\u67e5\u770b\u4e16\u754c\u4e66",
  "\u4e16\u754c\u4e66\u5217\u8868",
  ...WORLDBOOK_CLEAR_TEXT_TRIGGERS,
];

function sanitizeFilename(input: string): string {
  const base = path.basename(input.replaceAll("\\", "/"));
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function listFilesByExtensions(dir: string, allowed: string[]): Promise<string[]> {
  await ensureDir(dir);
  const set = new Set(allowed.map((entry) => entry.toLowerCase()));
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && set.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

function normalizeRegexFlags(value?: string): string {
  const raw = (value ?? "g").trim();
  if (!REGEX_FLAGS_PATTERN.test(raw)) {
    throw new Error(`Invalid regex flags: ${raw}`);
  }
  const deduped: string[] = [];
  for (const flag of raw) {
    if (!deduped.includes(flag)) {
      deduped.push(flag);
    }
  }
  return deduped.join("") || "g";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function pickCharacterName(value: Record<string, unknown>): string | null {
  return (
    asString(value.name) ??
    asString(asRecord(value.data)?.name) ??
    asString(asRecord(value.character)?.name) ??
    asString(asRecord(value.card)?.name) ??
    null
  );
}

function parseCharacterNameFromJson(content: string): string | null {
  try {
    const parsed = asRecord(JSON.parse(content) as unknown);
    if (!parsed) {
      return null;
    }
    return pickCharacterName(parsed);
  } catch {
    return null;
  }
}

function readPngCharacterTextChunk(chunk: Buffer, type: "tEXt" | "iTXt"): string | null {
  const keywordEnd = chunk.indexOf(0);
  if (keywordEnd <= 0) {
    return null;
  }
  const keyword = chunk.toString("latin1", 0, keywordEnd);
  if (keyword !== "chara") {
    return null;
  }

  if (type === "tEXt") {
    return chunk.toString("utf8", keywordEnd + 1).trim() || null;
  }

  let cursor = keywordEnd + 1;
  if (cursor + 1 >= chunk.length) {
    return null;
  }
  const compressionFlag = chunk[cursor] ?? 0;
  cursor += 2; // compression flag + compression method

  const languageTagEnd = chunk.indexOf(0, cursor);
  if (languageTagEnd < 0) {
    return null;
  }
  cursor = languageTagEnd + 1;

  const translatedKeywordEnd = chunk.indexOf(0, cursor);
  if (translatedKeywordEnd < 0) {
    return null;
  }
  cursor = translatedKeywordEnd + 1;

  const textBytes = chunk.subarray(cursor);
  if (textBytes.length === 0) {
    return null;
  }
  if (compressionFlag === 1) {
    try {
      return inflateSync(textBytes).toString("utf8").trim() || null;
    } catch {
      return null;
    }
  }
  return textBytes.toString("utf8").trim() || null;
}

function parseCharacterNameFromPng(bytes: Buffer): string | null {
  if (bytes.length < PNG_SIGNATURE.length) {
    return null;
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }

  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (crcEnd > bytes.length) {
      break;
    }

    if (type === "tEXt" || type === "iTXt") {
      const encoded = readPngCharacterTextChunk(bytes.subarray(dataStart, dataEnd), type);
      if (encoded) {
        try {
          const jsonString = Buffer.from(encoded, "base64").toString("utf8");
          const parsed = asRecord(JSON.parse(jsonString) as unknown);
          if (parsed) {
            return pickCharacterName(parsed);
          }
        } catch {
          // Keep scanning subsequent chunks.
        }
      }
    }
    offset = crcEnd;
  }
  return null;
}

function isPngBuffer(bytes: Buffer): boolean {
  return (
    bytes.length >= PNG_SIGNATURE.length &&
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

async function loadCharacterCards(charactersDir: string): Promise<CharacterCardEntry[]> {
  const files = await listFilesByExtensions(charactersDir, [".json", ".png"]);
  const entries: CharacterCardEntry[] = [];
  for (const filename of files) {
    let name = path.parse(filename).name;
    const fullPath = path.join(charactersDir, filename);
    try {
      if (filename.toLowerCase().endsWith(".json")) {
        const parsedName = parseCharacterNameFromJson(await readFile(fullPath, "utf8"));
        if (parsedName) {
          name = parsedName;
        }
      } else if (filename.toLowerCase().endsWith(".png")) {
        const parsedName = parseCharacterNameFromPng(await readFile(fullPath));
        if (parsedName) {
          name = parsedName;
        }
      }
    } catch {
      // Ignore malformed card payloads and keep filename fallback.
    }
    entries.push({ filename, name });
  }
  return entries;
}

function formatCharacterListItem(entry: CharacterCardEntry): string {
  const baseName = path.parse(entry.filename).name;
  if (entry.name.trim().toLowerCase() === baseName.trim().toLowerCase()) {
    return entry.filename;
  }
  return `${entry.name} (${entry.filename})`;
}

function resolveCharacterMatch(
  inputRaw: string,
  entries: CharacterCardEntry[],
): CharacterMatchResult {
  const input = sanitizeFilename(inputRaw);
  if (!input) {
    return { status: "missing", input };
  }
  const loweredInput = input.toLowerCase();

  const exactFilename = entries.find((entry) => entry.filename.toLowerCase() === loweredInput);
  if (exactFilename) {
    return { status: "matched", filename: exactFilename.filename };
  }

  if (!path.extname(input)) {
    const baseMatches = entries.filter(
      (entry) => path.parse(entry.filename).name.toLowerCase() === loweredInput,
    );
    if (baseMatches.length === 1) {
      return { status: "matched", filename: baseMatches[0].filename };
    }
    if (baseMatches.length > 1) {
      return { status: "ambiguous", input, matches: baseMatches };
    }
  }

  const nameMatches = entries.filter((entry) => entry.name.trim().toLowerCase() === loweredInput);
  if (nameMatches.length === 1) {
    return { status: "matched", filename: nameMatches[0].filename };
  }
  if (nameMatches.length > 1) {
    return { status: "ambiguous", input, matches: nameMatches };
  }
  return { status: "missing", input };
}

function formatAmbiguousCharacterMatch(input: string, matches: CharacterCardEntry[]): string {
  const options = matches.map((entry) => `${entry.name} (${entry.filename})`).join(", ");
  return `Character is ambiguous for "${input}". Use filename: ${options}`;
}

function parseRegexSpec(input: string): { pattern: string; flags: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Regex pattern is required");
  }
  if (!trimmed.startsWith("/")) {
    const flags = normalizeRegexFlags("g");
    void new RegExp(trimmed, flags);
    return { pattern: trimmed, flags };
  }
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) {
    throw new Error("Invalid regex literal");
  }
  const pattern = trimmed.slice(1, lastSlash);
  const flags = normalizeRegexFlags(trimmed.slice(lastSlash + 1));
  void new RegExp(pattern, flags);
  return { pattern, flags };
}

function normalizeRegexRule(value: unknown): RegexRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const pattern = typeof raw.pattern === "string" ? raw.pattern.trim() : "";
  if (!pattern) {
    return null;
  }
  const flags = normalizeRegexFlags(typeof raw.flags === "string" ? raw.flags : "g");
  void new RegExp(pattern, flags);
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    pattern,
    flags,
    replacement: typeof raw.replacement === "string" ? raw.replacement : "",
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    description: typeof raw.description === "string" ? raw.description : "",
    stage: typeof raw.stage === "string" && raw.stage.trim() ? raw.stage.trim() : undefined,
  };
}

function extractRegexRuleArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const raw = value as Record<string, unknown>;
  if (Array.isArray(raw.rules)) {
    return raw.rules;
  }
  if (Array.isArray(raw.regexRules)) {
    return raw.regexRules;
  }
  return [];
}

async function loadRegexRules(filePath: string): Promise<RegexRule[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return extractRegexRuleArray(parsed)
      .map((entry) => {
        try {
          return normalizeRegexRule(entry);
        } catch {
          return null;
        }
      })
      .filter((entry): entry is RegexRule => entry != null);
  } catch (err) {
    const message = String(err);
    if (message.includes("ENOENT")) {
      return [];
    }
    throw err;
  }
}

async function saveRegexRules(filePath: string, rules: RegexRule[]): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(rules, null, 2), "utf8");
}

function resolveRuleIndex(rules: RegexRule[], idRaw: string): number {
  const id = idRaw.trim();
  if (!id) {
    return -1;
  }
  const asNumber = Number.parseInt(id, 10);
  if (Number.isFinite(asNumber) && String(asNumber) === id) {
    const idx = asNumber - 1;
    return idx >= 0 && idx < rules.length ? idx : -1;
  }
  const lower = id.toLowerCase();
  return rules.findIndex((entry) => entry.name.trim().toLowerCase() === lower);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function decodeUrlPath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function toHeaderRecord(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.length > 0) {
      out[key] = value.join(", ");
    }
  }
  return out;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  }
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

async function readUploadedFile(params: {
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
  if (!(file instanceof File)) {
    throw new Error("Missing uploaded file field: file");
  }
  if (file.size > params.maxBytes) {
    throw new Error("File too large");
  }
  const filename = sanitizeFilename(file.name);
  if (!filename) {
    throw new Error("Invalid filename");
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  return { filename, bytes };
}

function isSupportedCharacterFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ext === ".png" || ext === ".json";
}

function ensureCharacterFilename(filenameRaw: string): string {
  const filename = sanitizeFilename(filenameRaw);
  if (!filename || filename !== filenameRaw || !isSupportedCharacterFile(filename)) {
    throw new Error("Invalid filename");
  }
  return filename;
}

function parseCharacterPayloadFromPng(bytes: Buffer): Record<string, unknown> | null {
  if (bytes.length < PNG_SIGNATURE.length) {
    return null;
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }

  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (crcEnd > bytes.length) {
      break;
    }

    if (type === "tEXt" || type === "iTXt") {
      const encoded = readPngCharacterTextChunk(bytes.subarray(dataStart, dataEnd), type);
      if (encoded) {
        try {
          const jsonString = Buffer.from(encoded, "base64").toString("utf8");
          const parsed = asRecord(JSON.parse(jsonString) as unknown);
          if (parsed) {
            return parsed;
          }
        } catch {
          // Keep scanning in case a later chunk is valid.
        }
      }
    }
    offset = crcEnd;
  }
  return null;
}

async function loadCharacterDetailPayload(params: {
  stateDir: string;
  filenameRaw: string;
}): Promise<Record<string, unknown>> {
  const filename = ensureCharacterFilename(params.filenameRaw);
  const charactersDir = path.join(params.stateDir, "characters");
  await ensureDir(charactersDir);
  const fullPath = path.join(charactersDir, filename);

  if (filename.toLowerCase().endsWith(".json")) {
    const content = await readFile(fullPath, "utf8");
    const parsed = asRecord(JSON.parse(content) as unknown);
    return {
      success: true,
      filename,
      character: parsed ?? { raw: content },
    };
  }

  const parsed = parseCharacterPayloadFromPng(await readFile(fullPath));
  return {
    success: true,
    filename,
    character: parsed ?? {
      name: path.parse(filename).name,
      filename,
      note: "No embedded character metadata found in PNG.",
    },
  };
}

async function listCharacterEntriesForApi(stateDir: string): Promise<
  Array<{
    name: string;
    filename: string;
  }>
> {
  const charactersDir = path.join(stateDir, "characters");
  const cards = await loadCharacterCards(charactersDir);
  return cards.map((entry) => ({ name: entry.name, filename: entry.filename }));
}

function normalizeWorldbookFilename(input: string): string {
  const safe = sanitizeFilename(input);
  if (!safe) {
    return "";
  }
  return safe.toLowerCase().endsWith(".json") ? safe : `${safe}.json`;
}

function ensureWorldbookFilename(filenameRaw: string): string {
  const filename = normalizeWorldbookFilename(filenameRaw);
  if (!filename || filename !== filenameRaw || !filename.toLowerCase().endsWith(".json")) {
    throw new Error("Invalid filename");
  }
  return filename;
}

function countWorldbookEntries(worldbook: Record<string, unknown>): number | null {
  const entries = worldbook.entries;
  if (Array.isArray(entries)) {
    return entries.length;
  }
  const objectEntries = asRecord(entries);
  if (objectEntries) {
    return Object.keys(objectEntries).length;
  }
  return null;
}

async function listWorldbooksForApi(stateDir: string): Promise<
  Array<{
    filename: string;
    name: string;
    entriesCount: number | null;
    updatedAt: string | null;
    sizeBytes: number | null;
  }>
> {
  const worldbooksDir = path.join(stateDir, "worldbooks");
  const files = await listFilesByExtensions(worldbooksDir, [".json"]);
  const out: Array<{
    filename: string;
    name: string;
    entriesCount: number | null;
    updatedAt: string | null;
    sizeBytes: number | null;
  }> = [];

  for (const filename of files) {
    const fullPath = path.join(worldbooksDir, filename);
    let name = filename.replace(/\.json$/i, "");
    let entriesCount: number | null = null;
    let updatedAt: string | null = null;
    let sizeBytes: number | null = null;
    try {
      const [content, info] = await Promise.all([readFile(fullPath, "utf8"), stat(fullPath)]);
      const parsed = asRecord(JSON.parse(content) as unknown);
      if (parsed) {
        const fromName = asString(parsed.name);
        if (fromName) {
          name = fromName;
        }
        entriesCount = countWorldbookEntries(parsed);
      }
      updatedAt = Number.isFinite(info.mtimeMs) ? new Date(info.mtimeMs).toISOString() : null;
      sizeBytes = Number.isFinite(info.size) ? info.size : null;
    } catch {
      // Best-effort metadata; keep fallback values.
    }
    out.push({ filename, name, entriesCount, updatedAt, sizeBytes });
  }

  return out;
}

async function loadWorldbookContentPayload(params: {
  stateDir: string;
  filenameRaw: string;
}): Promise<Record<string, unknown>> {
  const filename = ensureWorldbookFilename(params.filenameRaw);
  const worldbooksDir = path.join(params.stateDir, "worldbooks");
  await ensureDir(worldbooksDir);
  const fullPath = path.join(worldbooksDir, filename);
  const content = await readFile(fullPath, "utf8");
  const parsed = asRecord(JSON.parse(content) as unknown);
  if (!parsed) {
    throw new Error("Invalid worldbook JSON object");
  }
  return {
    success: true,
    filename,
    worldbook: parsed,
  };
}

async function saveWorldbookContentPayload(params: {
  stateDir: string;
  filenameRaw: string;
  body: unknown;
}): Promise<void> {
  const filename = ensureWorldbookFilename(params.filenameRaw);
  const payload = asRecord(params.body);
  const worldbook = asRecord(payload?.worldbook);
  if (!worldbook) {
    throw new Error("Missing worldbook payload");
  }
  const worldbooksDir = path.join(params.stateDir, "worldbooks");
  await ensureDir(worldbooksDir);
  const fullPath = path.join(worldbooksDir, filename);
  await writeFile(fullPath, JSON.stringify(worldbook, null, 2), "utf8");
}

async function deleteWorldbookFile(params: {
  stateDir: string;
  filenameRaw: string;
}): Promise<void> {
  const filename = ensureWorldbookFilename(params.filenameRaw);
  const worldbooksDir = path.join(params.stateDir, "worldbooks");
  await ensureDir(worldbooksDir);
  await rm(path.join(worldbooksDir, filename));
}

function parseImportedRegexRules(value: unknown): RegexRule[] {
  const list = extractRegexRuleArray(value);
  if (list.length === 0) {
    throw new Error("Regex upload JSON has no rules");
  }
  const out: RegexRule[] = [];
  for (const [index, entry] of list.entries()) {
    const normalized = normalizeRegexRule(entry);
    if (!normalized) {
      throw new Error(`Invalid regex rule at index ${index}`);
    }
    out.push(normalized);
  }
  return out;
}

function collectRegexMatches(pattern: string, flags: string, testText: string): string[] {
  const matchFlags = flags.includes("g") ? flags : `${flags}g`;
  const regex = new RegExp(pattern, matchFlags);
  const out: string[] = [];
  for (const match of testText.matchAll(regex)) {
    out.push(match[0] ?? "");
    if (out.length >= 200) {
      break;
    }
  }
  return out;
}

function runRegexTest(payload: unknown): {
  success: true;
  matches: string[];
  result: string;
  changed: boolean;
} {
  const raw = asRecord(payload);
  const pattern = asString(raw?.pattern);
  if (!pattern) {
    throw new Error("Regex pattern is required");
  }
  const flags = normalizeRegexFlags(asString(raw?.flags) ?? "g");
  const replacement = typeof raw?.replacement === "string" ? raw.replacement : "";
  const testText = typeof raw?.testText === "string" ? raw.testText : "";
  const regex = new RegExp(pattern, flags);
  const result = testText.replace(regex, replacement);
  return {
    success: true,
    matches: collectRegexMatches(pattern, flags, testText),
    result,
    changed: result !== testText,
  };
}

type NormalizedWorldbookEntry = {
  comment: string;
  keys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  order: number;
  sticky: number;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function pickPromptString(source: Record<string, unknown>, paths: string[][]): string | null {
  for (const path of paths) {
    let cursor: unknown = source;
    for (const key of path) {
      const object = asRecord(cursor);
      if (!object) {
        cursor = null;
        break;
      }
      cursor = object[key];
    }
    const value = asString(cursor);
    if (value) {
      return value;
    }
  }
  return null;
}

function pickPromptStringList(source: Record<string, unknown>, paths: string[][]): string[] {
  for (const path of paths) {
    let cursor: unknown = source;
    for (const key of path) {
      const object = asRecord(cursor);
      if (!object) {
        cursor = null;
        break;
      }
      cursor = object[key];
    }
    if (Array.isArray(cursor)) {
      const values = cursor
        .map((entry) => asString(entry))
        .filter((entry): entry is string => Boolean(entry))
        .map((entry) => normalizeWhitespace(entry));
      if (values.length > 0) {
        return values;
      }
      continue;
    }
    const single = asString(cursor);
    if (single) {
      const values = single
        .split(",")
        .map((entry) => normalizeWhitespace(entry))
        .filter(Boolean);
      if (values.length > 0) {
        return values;
      }
    }
  }
  return [];
}

/**
 * Replace SillyTavern-style placeholders in character card text.
 * Common placeholders: {{char}}, {{user}}, {{<user>}}, {{User}}, {{Char}}, etc.
 */
function replaceTavernPlaceholders(text: string, charName: string, userName: string): string {
  return text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{<char>\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{<user>\}\}/gi, userName);
}

function buildCharacterCardSection(filename: string, character: Record<string, unknown>, userName?: string): string {
  const lines: string[] = [];
  const append = (label: string, value: string | null) => {
    if (!value) {
      return;
    }
    lines.push(`${label}: ${truncate(normalizeWhitespace(value), MAX_CHARACTER_VALUE_CHARS)}`);
  };

  // system_prompt is the character's own system-level instruction (V2 spec).
  // Many card authors put core behavioral directives here.
  // Inject it first so it takes highest priority in the prepended context.
  const systemPrompt = pickPromptString(character, [
    ["system_prompt"],
    ["data", "system_prompt"],
    ["character", "system_prompt"],
    ["card", "system_prompt"],
  ]);
  if (systemPrompt) {
    lines.push(`[Character System Prompt]\n${truncate(normalizeWhitespace(systemPrompt), MAX_CHARACTER_VALUE_CHARS)}`);
    lines.push("");
  }

  lines.push(`[Character Card]`);
  lines.push(`filename: ${filename}`);

  append(
    "name",
    pickPromptString(character, [
      ["name"],
      ["data", "name"],
      ["character", "name"],
      ["card", "name"],
      ["char_name"],
    ]),
  );
  append(
    "creator",
    pickPromptString(character, [
      ["creator"],
      ["author"],
      ["data", "creator"],
      ["character", "creator"],
    ]),
  );
  append(
    "description",
    pickPromptString(character, [
      ["description"],
      ["desc"],
      ["data", "description"],
      ["character", "description"],
      ["card", "description"],
    ]),
  );
  append(
    "personality",
    pickPromptString(character, [
      ["personality"],
      ["data", "personality"],
      ["character", "personality"],
      ["card", "personality"],
    ]),
  );
  append(
    "scenario",
    pickPromptString(character, [
      ["scenario"],
      ["data", "scenario"],
      ["character", "scenario"],
      ["card", "scenario"],
    ]),
  );
  append(
    "first_message",
    pickPromptString(character, [
      ["first_mes"],
      ["firstMessage"],
      ["greeting"],
      ["data", "first_mes"],
      ["character", "first_mes"],
      ["card", "first_mes"],
    ]),
  );
  append(
    "example_dialogue",
    pickPromptString(character, [
      ["mes_example"],
      ["example_dialogue"],
      ["data", "mes_example"],
      ["character", "mes_example"],
      ["card", "mes_example"],
    ]),
  );
  const tags = pickPromptStringList(character, [
    ["tags"],
    ["data", "tags"],
    ["character", "tags"],
    ["card", "tags"],
  ]);
  if (tags.length > 0) {
    lines.push(`tags: ${truncate(tags.join(", "), MAX_CHARACTER_VALUE_CHARS)}`);
  }

  const charName = pickPromptString(character, [
    ["name"],
    ["data", "name"],
    ["character", "name"],
    ["card", "name"],
    ["char_name"],
  ]) ?? path.parse(filename).name;
  const effectiveUserName = userName || "用户";
  return replaceTavernPlaceholders(lines.join("\n"), charName, effectiveUserName);
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => asString(entry))
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => normalizeWhitespace(entry))
      .filter(Boolean);
  }
  const single = asString(value);
  if (!single) {
    return [];
  }
  return single
    .split(",")
    .map((entry) => normalizeWhitespace(entry))
    .filter(Boolean);
}

function resolveWorldbookRoot(worldbook: Record<string, unknown>): Record<string, unknown> {
  const nestedWorldbook = asRecord(worldbook.worldbook);
  const nestedData = asRecord(worldbook.data);
  const nestedDataWorldbook = asRecord(nestedData?.worldbook);
  const candidates = [worldbook, nestedWorldbook, nestedData, nestedDataWorldbook].filter(
    (entry): entry is Record<string, unknown> => Boolean(entry),
  );
  for (const candidate of candidates) {
    const entries = candidate.entries;
    if (Array.isArray(entries) || Boolean(asRecord(entries))) {
      return candidate;
    }
  }
  return worldbook;
}

function normalizeWorldbookEntries(worldbook: Record<string, unknown>): NormalizedWorldbookEntry[] {
  const worldbookRoot = resolveWorldbookRoot(worldbook);
  const rawEntries = worldbookRoot.entries;
  let entries: Record<string, unknown>[] = [];
  if (Array.isArray(rawEntries)) {
    entries = rawEntries
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  } else {
    const objectEntries = asRecord(rawEntries);
    if (objectEntries) {
      entries = Object.values(objectEntries)
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry));
    }
  }

  return entries.map((entry, index) => {
    const comment = normalizeWhitespace(
      asString(entry.comment) ??
        asString(entry.title) ??
        asString(entry.name) ??
        `Entry ${index + 1}`,
    );
    const content = normalizeWhitespace(
      asString(entry.content) ?? asString(entry.text) ?? asString(entry.entry) ?? "",
    );
    const enabled =
      typeof entry.enabled === "boolean"
        ? entry.enabled
        : typeof entry.disable === "boolean"
          ? !entry.disable
          : true;
    return {
      comment: comment || `Entry ${index + 1}`,
      keys: toStringList(entry.keys ?? entry.key ?? entry.keyword ?? entry.keywords),
      content,
      enabled,
      constant: toBoolean(entry.constant, false),
      order: Math.trunc(toNumber(entry.order, toNumber(entry.insertion_order, index))),
      sticky: Math.max(0, Math.trunc(toNumber(entry.sticky, 0))),
    };
  });
}

/**
 * Extract searchable text from conversation messages (history).
 * Handles both string content and structured content blocks.
 */
function extractTextFromMessages(messages: unknown[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const record = asRecord(msg);
    if (!record) continue;
    const content = record.content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        const blockRecord = asRecord(block);
        if (blockRecord && blockRecord.type === "text" && typeof blockRecord.text === "string") {
          parts.push(blockRecord.text);
        }
      }
    }
  }
  return parts.join("\n");
}

/**
 * Check if any of the entry's keys match the given context text.
 * Uses case-insensitive word boundary matching for each key.
 */
function entryMatchesContext(entry: NormalizedWorldbookEntry, contextLower: string): boolean {
  if (entry.keys.length === 0) return true; // No keys = always match
  for (const key of entry.keys) {
    const keyLower = key.toLowerCase();
    if (!keyLower) continue;
    if (contextLower.includes(keyLower)) return true;
  }
  return false;
}

/**
 * Build a unique key for sticky tracking of a worldbook entry.
 */
function worldbookEntryKey(entry: NormalizedWorldbookEntry): string {
  return `${entry.comment}::${entry.keys.join(",")}`;
}

/**
 * Select which worldbook entries to inject based on keyword matching and sticky state.
 *
 * Rules (matching SillyTavern semantics):
 * - constant entries: always injected regardless of keywords
 * - entries with no keys: always injected (no filter criteria)
 * - entries with keys: injected only if any key appears in the context text
 * - sticky entries: once triggered, remain injected for `sticky` additional turns
 *   even if keywords no longer match
 */
function selectWorldbookEntries(params: {
  allEntries: NormalizedWorldbookEntry[];
  contextText: string;
  sessionKey: string | null;
}): NormalizedWorldbookEntry[] {
  const { allEntries, contextText, sessionKey } = params;
  const contextLower = contextText.toLowerCase();

  // Get or create sticky state for this session
  const stickyMap = sessionKey
    ? (worldbookStickyState.get(sessionKey) ?? new Map<string, number>())
    : new Map<string, number>();

  const selected: NormalizedWorldbookEntry[] = [];
  const nextStickyMap = new Map<string, number>();

  for (const entry of allEntries) {
    if (!entry.enabled) continue;

    // Constant entries always included
    if (entry.constant) {
      selected.push(entry);
      continue;
    }

    const eKey = worldbookEntryKey(entry);
    const stickyRemaining = stickyMap.get(eKey) ?? 0;
    const matched = entryMatchesContext(entry, contextLower);

    if (matched) {
      selected.push(entry);
      // Reset sticky counter on fresh match
      if (entry.sticky > 0) {
        nextStickyMap.set(eKey, entry.sticky);
      }
    } else if (stickyRemaining > 0) {
      // Still within sticky window — include even without keyword match
      selected.push(entry);
      nextStickyMap.set(eKey, stickyRemaining - 1);
    }
    // else: not matched, not sticky → skip
  }

  // Persist sticky state
  if (sessionKey) {
    if (nextStickyMap.size > 0) {
      worldbookStickyState.set(sessionKey, nextStickyMap);
    } else {
      worldbookStickyState.delete(sessionKey);
    }
  }

  // Sort: constant first, then by order
  selected.sort((a, b) => {
    if (a.constant !== b.constant) return a.constant ? -1 : 1;
    return a.order - b.order;
  });

  return selected.slice(0, MAX_WORLD_ENTRIES);
}

function buildWorldbookSection(
  filename: string,
  worldbook: Record<string, unknown>,
  options?: { contextText?: string; sessionKey?: string | null },
): string {
  const worldbookRoot = resolveWorldbookRoot(worldbook);
  const worldbookName = normalizeWhitespace(
    asString(worldbookRoot.name) ??
      asString(worldbookRoot.title) ??
      filename.replace(/\.json$/i, ""),
  );
  const allEntries = normalizeWorldbookEntries(worldbookRoot);
  const totalEnabled = allEntries.filter((entry) => entry.enabled).length;

  // Use keyword matching when context is available, otherwise fall back to all enabled entries
  const contextText = options?.contextText;
  const selectedEntries = contextText
    ? selectWorldbookEntries({
        allEntries,
        contextText,
        sessionKey: options?.sessionKey ?? null,
      })
    : allEntries
        .filter((entry) => entry.enabled)
        .sort((a, b) => {
          if (a.constant !== b.constant) return a.constant ? -1 : 1;
          return a.order - b.order;
        })
        .slice(0, MAX_WORLD_ENTRIES);

  const lines: string[] = [
    "[Worldbook]",
    `filename: ${filename}`,
    `name: ${worldbookName}`,
    `total_enabled_entries: ${totalEnabled}`,
    `active_entries: ${selectedEntries.length}`,
  ];
  if (contextText && selectedEntries.length < totalEnabled) {
    lines.push(`note: ${totalEnabled - selectedEntries.length} entries filtered out (no keyword match in current context)`);
  }

  if (selectedEntries.length === 0) {
    lines.push("entries: none (no keywords matched current context)");
    return lines.join("\n");
  }

  lines.push("entries:");
  for (let index = 0; index < selectedEntries.length; index += 1) {
    const entry = selectedEntries[index];
    if (`${lines.join("\n")}\n`.length >= MAX_WORLD_SECTION_CHARS) {
      lines.push("- [truncated]");
      break;
    }
    const flags: string[] = [];
    if (entry.constant) {
      flags.push("constant");
    }
    if (entry.sticky > 0) {
      flags.push(`sticky=${entry.sticky}`);
    }
    flags.push(`order=${entry.order}`);
    lines.push(`- ${index + 1}. ${entry.comment} (${flags.join(", ")})`);
    if (entry.keys.length > 0) {
      lines.push(`  keys: ${truncate(entry.keys.join(", "), MAX_WORLD_ENTRY_CONTENT_CHARS)}`);
    }
    if (entry.content) {
      lines.push(`  content: ${truncate(entry.content, MAX_WORLD_ENTRY_CONTENT_CHARS)}`);
    }
  }

  return truncate(lines.join("\n"), MAX_WORLD_SECTION_CHARS);
}

function normalizeOptionalFilename(value: unknown): string | null {
  const filename = asString(value);
  if (!filename) {
    return null;
  }
  return filename.trim() || null;
}

/**
 * Extract the embedded character_book (worldbook) from a character card object.
 * Supports V2 spec paths: data.character_book, character.character_book, etc.
 */
function extractCharacterBook(character: Record<string, unknown>): Record<string, unknown> | null {
  const paths = [
    ["character_book"],
    ["data", "character_book"],
    ["character", "character_book"],
    ["card", "character_book"],
  ];
  for (const pathSegments of paths) {
    let cursor: unknown = character;
    for (const key of pathSegments) {
      const obj = asRecord(cursor);
      if (!obj) {
        cursor = null;
        break;
      }
      cursor = obj[key];
    }
    const result = asRecord(cursor);
    if (result) {
      // Verify it looks like a worldbook (has entries)
      const root = resolveWorldbookRoot(result);
      const entries = root.entries;
      if (Array.isArray(entries) || Boolean(asRecord(entries))) {
        return result;
      }
    }
  }
  return null;
}

async function buildSessionModuleSystemPrompt(params: {
  stateDir: string;
  characterCardFilename?: string | null;
  worldbookFilename?: string | null;
  contextText?: string;
  sessionKey?: string | null;
  userName?: string | null;
  log?: Pick<OpenClawPluginApi["logger"], "warn">;
}): Promise<string | undefined> {
  const characterCardFilename = normalizeOptionalFilename(params.characterCardFilename);
  const worldbookFilename = normalizeOptionalFilename(params.worldbookFilename);
  if (!characterCardFilename && !worldbookFilename) {
    return undefined;
  }

  const sections: string[] = [];
  let characterBook: Record<string, unknown> | null = null;
  let charName: string | null = null;

  if (characterCardFilename) {
    try {
      const payload = await loadCharacterDetailPayload({
        stateDir: params.stateDir,
        filenameRaw: characterCardFilename,
      });
      const detailObject = asRecord(payload);
      const character = asRecord(detailObject?.character);
      if (detailObject && character) {
        const filename = asString(detailObject.filename) ?? characterCardFilename;
        charName = pickCharacterName(character) ?? path.parse(filename).name;
        sections.push(buildCharacterCardSection(filename, character, params.userName ?? undefined));
        // Extract embedded character_book for later injection
        characterBook = extractCharacterBook(character);
      }
    } catch (err) {
      params.log?.warn?.(
        `tavern-chat context: failed to load character card "${characterCardFilename}": ${String(err)}`,
      );
    }
  }

  // Inject embedded character_book (from the character card) before the global worldbook.
  // If both exist, the character's book provides character-specific lore while the
  // global worldbook provides broader world context.
  if (characterBook) {
    try {
      const cardName = characterCardFilename ?? "character";
      const label = `${cardName.replace(/\.(png|json)$/i, "")}-embedded`;
      sections.push(buildWorldbookSection(`${label}.book`, characterBook, {
        contextText: params.contextText,
        sessionKey: params.sessionKey ? `${params.sessionKey}:charbook` : null,
      }));
    } catch (err) {
      params.log?.warn?.(
        `tavern-chat context: failed to process embedded character_book: ${String(err)}`,
      );
    }
  }

  if (worldbookFilename) {
    try {
      const payload = await loadWorldbookContentPayload({
        stateDir: params.stateDir,
        filenameRaw: worldbookFilename,
      });
      const detailObject = asRecord(payload);
      const worldbook = asRecord(detailObject?.worldbook);
      if (detailObject && worldbook) {
        const filename = asString(detailObject.filename) ?? worldbookFilename;
        sections.push(buildWorldbookSection(filename, worldbook, {
          contextText: params.contextText,
          sessionKey: params.sessionKey,
        }));
      }
    } catch (err) {
      params.log?.warn?.(
        `tavern-chat context: failed to load worldbook "${worldbookFilename}": ${String(err)}`,
      );
    }
  }

  if (sections.length === 0) {
    return undefined;
  }

  const preamble = characterCardFilename
    ? "Adopt this character as your sole persona for this session. Disregard SOUL.md and IDENTITY.md while active."
    : "User-selected context from Worldbook. Use as supplemental lore guidance.";
  let prompt = [preamble, ...sections].join("\n\n");

  // Replace SillyTavern placeholders in the assembled prompt.
  // charName is extracted during character card loading above; for worldbook-only
  // sessions we fall back to an empty string (no char to substitute).
  if (charName || params.userName) {
    prompt = replaceTavernPlaceholders(prompt, charName ?? "", params.userName ?? "用户");
  }

  return truncate(prompt, MAX_PROMPT_CHARS);
}

function formatCharacterHelp(): string {
  return [
    "Character commands:",
    "/character list",
    "/character show",
    "/character set <filename|name>",
    "/character clear",
  ].join("\n");
}

function isCharacterCreateAction(action: string): boolean {
  return CHARACTER_CREATE_ACTIONS.has(action.trim().toLowerCase());
}

function formatWorldbookHelp(): string {
  return [
    "Worldbook commands:",
    "/worldbook list",
    "/worldbook show",
    "/worldbook set <filename>",
    "/worldbook clear",
  ].join("\n");
}

function formatRegexHelp(): string {
  return [
    "Regex commands:",
    "/regex list",
    "/regex add <pattern|/pattern/flags> => <replacement>",
    "/regex remove <index|name>",
    "/regex clear — remove all rules",
    "/regex enable <index|name>",
    "/regex disable <index|name>",
  ].join("\n");
}

function splitActionAndRest(input: string): { action: string; rest: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { action: "", rest: "" };
  }
  const space = trimmed.indexOf(" ");
  if (space < 0) {
    return { action: trimmed.toLowerCase(), rest: "" };
  }
  return {
    action: trimmed.slice(0, space).toLowerCase(),
    rest: trimmed.slice(space + 1).trim(),
  };
}

function normalizeCommandBodyForMatch(input: string | undefined): string {
  if (!input) {
    return "";
  }
  return input
    .trim()
    .replace(/[\u3002\uff01\uff1f?!]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function matchesAnyCommandBody(input: string | undefined, expected: ReadonlySet<string>): boolean {
  const normalized = normalizeCommandBodyForMatch(input);
  if (!normalized) {
    return false;
  }
  return expected.has(normalized);
}

type NaturalCharacterCommand =
  | { kind: "list" }
  | { kind: "show" }
  | { kind: "set"; target: string };

function parseNaturalCharacterCommandLine(lineRaw: string): NaturalCharacterCommand | null {
  const line = lineRaw.trim();
  if (!line) {
    return null;
  }

  if (/^(?:角色卡列表|查看角色卡|列出角色卡)$/i.test(line)) {
    return { kind: "list" };
  }
  if (/^(?:当前角色卡|查看当前角色卡)$/i.test(line)) {
    return { kind: "show" };
  }
  const naturalSwitch = line.match(/^(?:切换角色卡|换角色卡|角色卡切换)\s*(.*)$/i);
  if (naturalSwitch) {
    const target = (naturalSwitch[1] ?? "").trim();
    if (!target) {
      return { kind: "list" };
    }
    return { kind: "set", target };
  }

  if (!line.startsWith("/")) {
    return null;
  }
  const command = line.replace(/^\/+/, "").trim();
  if (!command) {
    return null;
  }
  const { action, rest } = splitActionAndRest(command);
  if (action !== "character") {
    return null;
  }
  const parsed = splitActionAndRest(rest);
  if (!parsed.action || parsed.action === "list" || parsed.action === "ls" || parsed.action === "showall") {
    return { kind: "list" };
  }
  if (parsed.action === "show") {
    return { kind: "show" };
  }
  if (parsed.action === "set") {
    const target = parsed.rest.trim();
    if (!target) {
      return null;
    }
    return { kind: "set", target };
  }
  const implicit = `${parsed.action} ${parsed.rest}`.trim();
  if (implicit) {
    return { kind: "set", target: implicit };
  }
  return null;
}

function extractNaturalCharacterCommandFromEvent(event: unknown): NaturalCharacterCommand | null {
  const texts = collectTextFields(event);
  for (const text of texts) {
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (
        line.startsWith("[CQ:") ||
        line.startsWith("[OPENCLAW_MEDIA_PATH:") ||
        line.startsWith("[media attached:") ||
        line.startsWith("[Queued messages")
      ) {
        continue;
      }
      const parsed = parseNaturalCharacterCommandLine(line);
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

function resolveSessionKeyFromEvent(event: unknown): string | null {
  const record = asRecord(event);
  if (!record) {
    return null;
  }
  const directSessionKey =
    asString(record.sessionKey) ??
    asString(record.SessionKey) ??
    asString(record.session_key) ??
    asString(record.session);
  if (directSessionKey) {
    return directSessionKey.trim();
  }

  const from =
    asString(record.from) ??
    asString(record.From) ??
    asString(record.sender) ??
    asString(record.source);
  if (!from) {
    return null;
  }
  const trimmed = from.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("qq:")) {
    return trimmed;
  }
  return `qq:${trimmed}`;
}

async function loadSessionStoreObject(storePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = asRecord(JSON.parse(await readFile(storePath, "utf8")) as unknown);
    return parsed ?? null;
  } catch {
    return null;
  }
}

/**
 * Per-file mutex to prevent concurrent writes to the same session store file.
 * Without this, two simultaneous message_received handlers (e.g., QQ worldbook
 * import + character card import) could read-modify-write the same file and
 * one write would silently overwrite the other.
 *
 * NOTE: This is a best-effort mitigation within the plugin process. The core
 * session store (src/config/sessions.ts) has its own write serialization via
 * updateSessionStore(). Ideally, plugins should use an official session patch
 * API (e.g., updateSessionEntry from command context) instead of direct file
 * I/O. The two call sites that use this (handleNaturalCharacterCommandFromEvent
 * and setSessionWorldbookFilename) run in hooks where updateSessionEntry is
 * not available.
 */
const sessionStoreLocks = new Map<string, Promise<void>>();

async function saveSessionStoreObject(storePath: string, data: Record<string, unknown>): Promise<void> {
  // Serialize writes per file path to avoid concurrent read-modify-write races
  const previous = sessionStoreLocks.get(storePath) ?? Promise.resolve();
  const current = previous.then(async () => {
    await ensureDir(path.dirname(storePath));
    await writeFile(storePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  });
  sessionStoreLocks.set(storePath, current.catch(() => {}));
  await current;
}

/**
 * Atomically read-modify-write a single session entry.
 * Re-reads the file under the lock to avoid stale-read overwrites.
 */
async function patchSessionStoreEntry(
  storePath: string,
  sessionKey: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const previous = sessionStoreLocks.get(storePath) ?? Promise.resolve();
  const current = previous.then(async () => {
    const storeData = await loadSessionStoreObject(storePath) ?? {};
    const entry = asRecord(storeData[sessionKey]) ?? {};
    storeData[sessionKey] = { ...entry, ...patch };
    await ensureDir(path.dirname(storePath));
    await writeFile(storePath, `${JSON.stringify(storeData, null, 2)}\n`, "utf8");
  });
  sessionStoreLocks.set(storePath, current.catch(() => {}));
  await current;
}

async function resolveSessionStoreForKey(
  api: OpenClawPluginApi,
  sessionKey: string,
): Promise<{ storePath: string; storeData: Record<string, unknown> } | null> {
  const stateDir = api.runtime.state.resolveStateDir();
  const candidates = new Set<string>();
  const inferred = [
    resolveSessionStorePath(api, undefined),
    resolveSessionStorePath(api, "dev"),
    resolveSessionStorePath(api, "default"),
    path.join(stateDir, "agents", "dev", "sessions", "sessions.json"),
    path.join(stateDir, "agents", "default", "sessions", "sessions.json"),
  ];
  for (const item of inferred) {
    if (item) {
      candidates.add(item);
    }
  }

  for (const storePath of candidates) {
    const storeData = await loadSessionStoreObject(storePath);
    if (storeData && asRecord(storeData[sessionKey])) {
      return { storePath, storeData };
    }
  }
  for (const storePath of candidates) {
    const storeData = await loadSessionStoreObject(storePath);
    if (storeData) {
      return { storePath, storeData };
    }
  }
  return null;
}

async function handleNaturalCharacterCommandFromEvent(
  api: OpenClawPluginApi,
  event: unknown,
  ctxSessionKey?: string | null,
  senderName?: string | null,
): Promise<string | null> {
  const parsedCommand = extractNaturalCharacterCommandFromEvent(event);
  if (!parsedCommand) {
    return null;
  }

  const sessionKey = ctxSessionKey?.trim() || resolveSessionKeyFromEvent(event);
  if (!sessionKey) {
    return "未能定位当前会话，无法切换角色卡。";
  }

  const stateDir = api.runtime.state.resolveStateDir();
  const charactersDir = path.join(stateDir, "characters");
  const cards = await loadCharacterCards(charactersDir);

  const resolvedStore = await resolveSessionStoreForKey(api, sessionKey);
  if (!resolvedStore) {
    return "未找到会话存储，无法切换角色卡。";
  }
  const entry = asRecord(resolvedStore.storeData[sessionKey]) ?? {};
  const current = asString(entry.characterCardFilename)?.trim() ?? "";

  if (parsedCommand.kind === "list") {
    if (cards.length === 0) {
      return "未找到角色卡，请先导入 .json 或 .png 角色卡。";
    }
    const lines = cards.map((card) => `${current === card.filename ? "* " : "- "}${formatCharacterListItem(card)}`);
    return `角色卡列表（${cards.length}）：\n${lines.join("\n")}`;
  }

  if (parsedCommand.kind === "show") {
    return `当前角色卡：${current || "(none)"}`;
  }

  const rawInput = sanitizeFilename(parsedCommand.target);
  if (!rawInput) {
    return "用法：/character set <filename|name>";
  }
  const selection = resolveCharacterMatch(rawInput, cards);
  if (selection.status === "missing") {
    return `Character not found: ${selection.input}`;
  }
  if (selection.status === "ambiguous") {
    return formatAmbiguousCharacterMatch(selection.input, selection.matches);
  }
  const fullPath = path.join(charactersDir, selection.filename);
  if (!(await fileExists(fullPath))) {
    return `Character not found: ${selection.filename}`;
  }
  if (current === selection.filename) {
    return `角色卡已是当前：${selection.filename}`;
  }

  const patch: Record<string, unknown> = { characterCardFilename: selection.filename };
  if (senderName?.trim()) {
    patch.userName = senderName.trim();
  }
  await patchSessionStoreEntry(resolvedStore.storePath, sessionKey, patch);
  return `已切换角色卡：${selection.filename}`;
}

function resolveSessionStorePath(api: OpenClawPluginApi, agentId?: string): string | null {
  const resolver = api.runtime.channel?.session?.resolveStorePath;
  if (typeof resolver !== "function") {
    return null;
  }
  const config = asRecord(api.config as unknown);
  const session = asRecord(config?.session);
  const configuredStore = asString(session?.store);
  try {
    return resolver(configuredStore, { agentId });
  } catch {
    return null;
  }
}

async function readSessionStoreEntry(
  storePath: string,
  sessionKey: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = asRecord(JSON.parse(await readFile(storePath, "utf8")) as unknown);
    if (!parsed) {
      return null;
    }
    return asRecord(parsed[sessionKey]);
  } catch {
    return null;
  }
}

function parseQqCqParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const segment of raw.split(",")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim().replaceAll("&amp;", "&");
    if (!key || !value) {
      continue;
    }
    params[key] = value;
  }
  return params;
}

function collectTextFields(value: unknown): string[] {
  const out: string[] = [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      out.push(trimmed);
    }
    return out;
  }
  const record = asRecord(value);
  if (!record) {
    return out;
  }
  const candidateKeys = [
    "content",
    "Content",
    "rawBody",
    "RawBody",
    "body",
    "Body",
    "text",
    "Text",
    "raw",
    "Raw",
    "message",
    "Message",
  ];
  for (const key of candidateKeys) {
    const field = asString(record[key]);
    if (field) {
      out.push(field);
    }
  }
  const nestedKeys = ["ctx", "payload", "context", "message"];
  for (const nestedKey of nestedKeys) {
    const nested = asRecord(record[nestedKey]);
    if (nested) {
      out.push(...collectTextFields(nested));
    }
  }
  return out;
}

function isPngLikeRef(value?: string): boolean {
  if (!value) {
    return false;
  }
  const lower = value.toLowerCase();
  return lower.endsWith(".png") || /\.png(\?|$)/.test(lower);
}

function isJsonLikeRef(value?: string): boolean {
  if (!value) {
    return false;
  }
  const lower = value.toLowerCase();
  return lower.endsWith(".json") || /\.json(\?|$)/.test(lower);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function getFetchFn():
  | ((input: string, init?: { redirect?: "follow"; headers?: Record<string, string> }) => Promise<any>)
  | null {
  const fetchFn =
    (globalThis as {
      fetch?: (input: string, init?: { redirect?: "follow"; headers?: Record<string, string> }) => Promise<any>;
    }).fetch;
  return typeof fetchFn === "function" ? fetchFn : null;
}

async function readMediaRefBuffer(
  mediaRef: string,
  headers?: Record<string, string>,
): Promise<Buffer | null> {
  if (isHttpUrl(mediaRef)) {
    const fetchFn = getFetchFn();
    if (!fetchFn) {
      return null;
    }
    const response = await fetchFn(mediaRef, { redirect: "follow", headers });
    if (!response.ok) {
      return null;
    }
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_QQ_MEDIA_FETCH_BYTES) {
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_QQ_MEDIA_FETCH_BYTES) {
      return null;
    }
    return bytes;
  }
  return await readFile(mediaRef);
}

type DiscordAttachmentRef = {
  url: string;
  filename: string;
  contentType: string | null;
};

function normalizeDiscordBotToken(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/^Bot\s+/i, "").trim();
  return normalized ? normalized : null;
}

function resolveDiscordBotTokenFromConfig(api: OpenClawPluginApi, accountIdRaw?: string): string | null {
  const config = asRecord(api.config as unknown);
  const channels = asRecord(config?.channels);
  const discord = asRecord(channels?.discord);
  const accounts = asRecord(discord?.accounts);
  const accountId = (accountIdRaw ?? "default").trim() || "default";

  if (accountId !== "default") {
    const account = asRecord(accounts?.[accountId]);
    return normalizeDiscordBotToken(asString(account?.token));
  }

  const defaultAccount = asRecord(accounts?.default);
  const defaultAccountToken = normalizeDiscordBotToken(asString(defaultAccount?.token));
  if (defaultAccountToken) {
    return defaultAccountToken;
  }

  const rootToken = normalizeDiscordBotToken(asString(discord?.token));
  if (rootToken) {
    return rootToken;
  }

  return normalizeDiscordBotToken(process.env.DISCORD_BOT_TOKEN ?? null);
}

function parseDiscordChannelIdFromTarget(target: string | null): string | null {
  if (!target) {
    return null;
  }
  const trimmed = target.trim();
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("channel:")) {
    const channelId = trimmed.slice("channel:".length).trim();
    return channelId ? channelId : null;
  }
  if (lower.startsWith("discord:channel:")) {
    const channelId = trimmed.slice("discord:channel:".length).trim();
    return channelId ? channelId : null;
  }
  if (/^\d{6,}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

async function fetchDiscordAttachmentRefs(params: {
  messageId: string;
  channelId: string;
  token: string;
}): Promise<DiscordAttachmentRef[]> {
  const fetchFn = getFetchFn();
  if (!fetchFn) {
    return [];
  }
  const endpoint =
    `https://discord.com/api/v10/channels/${encodeURIComponent(params.channelId)}` +
    `/messages/${encodeURIComponent(params.messageId)}`;
  const response = await fetchFn(endpoint, {
    headers: {
      Authorization: `Bot ${params.token}`,
    },
  });
  if (!response.ok) {
    return [];
  }
  const payload = asRecord(await response.json());
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const out: DiscordAttachmentRef[] = [];
  for (const item of attachments) {
    const data = asRecord(item);
    if (!data) {
      continue;
    }
    const url = asString(data.url) ?? asString(data.proxy_url);
    if (!url) {
      continue;
    }
    const filename =
      asString(data.filename) ??
      normalizeAttachmentFilename(url) ??
      `discord-image-${Date.now()}.png`;
    out.push({
      url,
      filename,
      contentType: asString(data.content_type),
    });
  }
  return out;
}

async function resolveDiscordPngMediaPathsFromEvent(
  api: OpenClawPluginApi,
  event: unknown,
  ctx: { channelId?: string; accountId?: string },
  stateDir: string,
): Promise<string[]> {
  if ((ctx.channelId ?? "").toLowerCase() !== "discord") {
    return [];
  }
  const eventRecord = asRecord(event);
  const metadata = asRecord(eventRecord?.metadata);
  const messageId = asString(metadata?.messageId);
  const toTarget = asString(metadata?.to) ?? asString(metadata?.originatingTo) ?? asString(metadata?.channelId);
  const channelId = parseDiscordChannelIdFromTarget(toTarget);
  if (!messageId || !channelId) {
    return [];
  }

  const token = resolveDiscordBotTokenFromConfig(api, ctx.accountId);
  if (!token) {
    return [];
  }

  let attachmentRefs: DiscordAttachmentRef[] = [];
  try {
    attachmentRefs = await fetchDiscordAttachmentRefs({
      messageId,
      channelId,
      token,
    });
  } catch (err) {
    api.logger.warn(`[character] discord attachment lookup failed: ${String(err)}`);
    return [];
  }
  if (attachmentRefs.length === 0) {
    return [];
  }

  const mediaDir = path.join(stateDir, "incoming-media", "discord");
  await ensureDir(mediaDir);

  const resolvedPaths: string[] = [];
  let sequence = 0;
  for (const ref of attachmentRefs) {
    if (!isPngLikeRef(ref.filename) && !isPngLikeRef(ref.url) && ref.contentType !== "image/png") {
      continue;
    }
    try {
      const bytes =
        await readMediaRefBuffer(ref.url, { Authorization: `Bot ${token}` }) ??
        await readMediaRefBuffer(ref.url);
      if (!bytes || !isPngBuffer(bytes)) {
        continue;
      }
      const rawName = sanitizeFilename(ref.filename) || `discord-image-${Date.now()}-${sequence}.png`;
      const parsed = path.parse(rawName);
      const baseName = parsed.name || `discord-image-${Date.now()}-${sequence}`;
      const filename = `${Date.now()}-${sequence}-${baseName}.png`;
      sequence++;
      const destPath = path.join(mediaDir, filename);
      await writeFile(destPath, bytes);
      resolvedPaths.push(destPath);
    } catch (err) {
      api.logger.warn(`[character] failed to fetch discord attachment ${ref.url}: ${String(err)}`);
    }
  }
  return resolvedPaths;
}

function normalizeAttachmentFilename(value: string): string {
  const withoutQuery = value.split("?")[0] ?? value;
  const decoded = (() => {
    try {
      return decodeURIComponent(withoutQuery);
    } catch {
      return withoutQuery;
    }
  })();
  return sanitizeFilename(path.basename(decoded.replaceAll("\\", "/")));
}

function extractQqJsonAttachmentRefsFromText(text: string): QqJsonAttachmentRef[] {
  const out: QqJsonAttachmentRef[] = [];
  let match: RegExpExecArray | null;
  QQ_MEDIA_SEGMENT_PATTERN.lastIndex = 0;
  while ((match = QQ_MEDIA_SEGMENT_PATTERN.exec(text)) !== null) {
    const segmentType = (match[1] ?? "").toLowerCase();
    if (segmentType !== "file") {
      continue;
    }
    const raw = match[2] ?? "";
    if (!raw) {
      continue;
    }
    const params = parseQqCqParams(raw);
    const refs = [
      (params.file ?? "").trim(),
      (params.name ?? "").trim(),
      (params.url ?? "").trim(),
      (params.path ?? params.filepath ?? params.file_path ?? params.local_path ?? "").trim(),
    ].filter((entry) => entry !== "");
    if (!refs.some((entry) => isJsonLikeRef(entry))) {
      continue;
    }
    const filename =
      refs.map((entry) => normalizeAttachmentFilename(entry)).find((entry) => entry && isJsonLikeRef(entry)) ??
      normalizeAttachmentFilename((params.file ?? params.name ?? "").trim()) ??
      "worldbook.json";
    const fileId =
      asString(params.file_id)?.trim() ??
      asString(params.fileid)?.trim() ??
      asString(params.id)?.trim() ??
      null;
    out.push({
      filename: filename.toLowerCase().endsWith(".json") ? filename : `${filename}.json`,
      fileId: fileId && fileId.length > 0 ? fileId : null,
    });
  }
  return out;
}

function extractQqJsonAttachmentNamesFromText(text: string): string[] {
  return extractQqJsonAttachmentRefsFromText(text).map((entry) => entry.filename);
}

function detectQqJsonAttachmentsFromEvent(event: unknown): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const appendName = (raw: string): void => {
    const normalizedRaw = raw.trim();
    if (!normalizedRaw) {
      return;
    }
    const filename = normalizeAttachmentFilename(normalizedRaw);
    if (!filename || !isJsonLikeRef(filename)) {
      return;
    }
    const key = filename.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    names.push(filename);
  };

  const texts = Array.from(new Set(collectTextFields(event)));
  for (const text of texts) {
    for (const entry of extractQqJsonAttachmentNamesFromText(text)) {
      appendName(entry);
    }
  }

  const eventRecord = asRecord(event);
  const segments = Array.isArray(eventRecord?.message) ? eventRecord.message : [];
  for (const segment of segments) {
    const segmentRecord = asRecord(segment);
    if (!segmentRecord) {
      continue;
    }
    const segmentType = asString(segmentRecord.type)?.toLowerCase();
    if (segmentType !== "file") {
      continue;
    }
    const data = asRecord(segmentRecord.data);
    if (!data) {
      continue;
    }
    const refs = [
      asString(data.file),
      asString(data.name),
      asString(data.url),
      asString(data.path),
      asString(data.filepath),
      asString(data.file_path),
      asString(data.local_path),
    ]
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (!refs.some((entry) => isJsonLikeRef(entry))) {
      continue;
    }
    const preferred = refs.find((entry) => isJsonLikeRef(entry));
    if (preferred) {
      appendName(preferred);
    }
  }
  return names;
}

function detectQqJsonAttachmentRefsFromBeforeAgentStartEvent(event: unknown): QqJsonAttachmentRef[] {
  const refs: QqJsonAttachmentRef[] = [];
  const seen = new Set<string>();
  const append = (candidate: QqJsonAttachmentRef): void => {
    if (!candidate.filename) {
      return;
    }
    const key = `${candidate.filename.toLowerCase()}@@${candidate.fileId ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    refs.push(candidate);
  };

  const eventRecord = asRecord(event);
  const prompt = asString(eventRecord?.prompt);
  const texts: string[] = [];
  if (prompt) {
    texts.push(prompt);
  }
  texts.push(...collectTextFields(eventRecord?.messages));
  texts.push(...collectTextFields(eventRecord));

  for (const text of texts) {
    for (const candidate of extractQqJsonAttachmentRefsFromText(text)) {
      append(candidate);
    }
  }
  return refs;
}

function resolveQqOneBotWsUrl(api: OpenClawPluginApi): string {
  const config = asRecord(api.config as unknown);
  const channels = asRecord(config?.channels);
  const qq = asRecord(channels?.qq);
  const wsUrl = asString(qq?.wsUrl) ?? "ws://127.0.0.1:3001";
  const accessToken = asString(qq?.accessToken);
  if (!accessToken) {
    return wsUrl;
  }
  try {
    const parsed = new URL(wsUrl);
    if (!parsed.searchParams.has("access_token")) {
      parsed.searchParams.set("access_token", accessToken);
    }
    return parsed.toString();
  } catch {
    return wsUrl;
  }
}

function decodeOneBotMessagePayload(payload: unknown): string | null {
  if (typeof payload === "string") {
    return payload;
  }
  if (Buffer.isBuffer(payload)) {
    return payload.toString("utf8");
  }
  const eventPayload = asRecord(payload);
  const data = eventPayload?.data;
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return null;
}

async function callOneBotGetFileById(api: OpenClawPluginApi, fileId: string): Promise<Record<string, unknown>> {
  const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!WebSocketCtor) {
    throw new Error("WebSocket API unavailable");
  }
  const wsUrl = resolveQqOneBotWsUrl(api);
  const echo = `tavern-chat-get-file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const ws = new WebSocketCtor(wsUrl) as {
      send?: (data: string) => void;
      close?: () => void;
      addEventListener?: (name: string, handler: (event: unknown) => void) => void;
      on?: (name: string, handler: (event: unknown) => void) => void;
    };
    let settled = false;
    const timer = setTimeout(() => finish(new Error("OneBot get_file timeout")), 8000);
    const finish = (err?: Error, data?: Record<string, unknown>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close?.();
      } catch {
        // ignore close failures
      }
      if (err) {
        reject(err);
        return;
      }
      resolve(data ?? {});
    };

    const handleOpen = (): void => {
      try {
        ws.send?.(
          JSON.stringify({
            action: "get_file",
            params: { file_id: fileId },
            echo,
          }),
        );
      } catch (err) {
        finish(new Error(`OneBot get_file send failed: ${String(err)}`));
      }
    };

    const handleMessage = (payload: unknown): void => {
      const text = decodeOneBotMessagePayload(payload);
      if (!text) {
        return;
      }
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = asRecord(JSON.parse(text) as unknown);
      } catch {
        return;
      }
      if (!parsed) {
        return;
      }
      const responseEcho = asString(parsed.echo);
      if (!responseEcho || responseEcho !== echo) {
        return;
      }
      const status = asString(parsed.status)?.toLowerCase();
      const retcodeRaw = parsed.retcode;
      const retcode = typeof retcodeRaw === "number" ? retcodeRaw : Number.NaN;
      if (status === "ok" || retcode === 0) {
        const data = asRecord(parsed.data);
        if (!data) {
          finish(new Error("OneBot get_file returned empty payload"));
          return;
        }
        finish(undefined, data);
        return;
      }
      const message = asString(parsed.msg) ?? asString(parsed.wording) ?? "OneBot get_file failed";
      finish(new Error(message));
    };

    const handleError = (err: unknown): void => {
      finish(new Error(`OneBot websocket error: ${String(err)}`));
    };

    if (typeof ws.addEventListener === "function") {
      ws.addEventListener("open", () => handleOpen());
      ws.addEventListener("message", (event) => handleMessage(event));
      ws.addEventListener("error", (event) => handleError(event));
    } else if (typeof ws.on === "function") {
      ws.on("open", () => handleOpen());
      ws.on("message", (event) => handleMessage(event));
      ws.on("error", (event) => handleError(event));
    } else {
      finish(new Error("WebSocket implementation has no event API"));
    }
  });
}

function isWorldbookJsonObject(value: Record<string, unknown>): boolean {
  const root = resolveWorldbookRoot(value);
  const entries = root.entries;
  if (Array.isArray(entries)) {
    return true;
  }
  return Boolean(asRecord(entries));
}

async function setSessionWorldbookFilename(
  api: OpenClawPluginApi,
  sessionKey: string,
  filename: string,
): Promise<boolean> {
  const resolvedStore = await resolveSessionStoreForKey(api, sessionKey);
  if (!resolvedStore) {
    return false;
  }
  await patchSessionStoreEntry(resolvedStore.storePath, sessionKey, {
    worldbookFilename: filename,
  });
  return true;
}

async function tryImportWorldbookFromQqJsonAttachments(
  api: OpenClawPluginApi,
  sessionKey: string | null,
  refs: QqJsonAttachmentRef[],
): Promise<string> {
  const worldbooksDir = path.join(api.runtime.state.resolveStateDir(), "worldbooks");
  await ensureDir(worldbooksDir);
  let firstFormatMismatch: string | null = null;
  let firstFetchError: string | null = null;

  for (const ref of refs) {
    if (!ref.fileId) {
      if (!firstFetchError) {
        firstFetchError = `${ref.filename} \u7f3a\u5c11 file_id`;
      }
      continue;
    }
    try {
      const fileData = await callOneBotGetFileById(api, ref.fileId);
      let jsonText: string | null = null;
      const base64 = asString(fileData.base64);
      if (base64) {
        jsonText = Buffer.from(base64, "base64").toString("utf8");
      }
      if (!jsonText) {
        const localPath = asString(fileData.file) ?? asString(fileData.url);
        if (localPath && await fileExists(localPath)) {
          jsonText = await readFile(localPath, "utf8");
        }
      }
      if (!jsonText) {
        throw new Error("get_file returned no readable content");
      }
      const parsed = asRecord(JSON.parse(jsonText) as unknown);
      if (!parsed) {
        throw new Error("JSON root is not an object");
      }
      if (!isWorldbookJsonObject(parsed)) {
        if (!firstFormatMismatch) {
          firstFormatMismatch = ref.filename;
        }
        continue;
      }
      const fallbackName = asString(fileData.file_name) ?? ref.filename;
      const filename =
        normalizeWorldbookFilename(fallbackName) ||
        normalizeWorldbookFilename(`qq-worldbook-${Date.now()}.json`) ||
        `qq-worldbook-${Date.now()}.json`;
      await writeFile(path.join(worldbooksDir, filename), JSON.stringify(parsed, null, 2), "utf8");
      const root = resolveWorldbookRoot(parsed);
      const entriesCount = countWorldbookEntries(root);
      const entriesText = entriesCount === null ? "\u672a\u77e5" : String(entriesCount);
      const switched = sessionKey ? await setSessionWorldbookFilename(api, sessionKey, filename) : false;
      if (switched) {
        return `\u5df2\u4eceQQ\u6587\u4ef6\u5bfc\u5165\u5e76\u5207\u6362\u4e16\u754c\u4e66\uff1a${filename}\uff08\u6761\u76ee\u6570\uff1a${entriesText}\uff09\u3002`;
      }
      return `\u5df2\u4eceQQ\u6587\u4ef6\u5bfc\u5165\u4e16\u754c\u4e66\uff1a${filename}\uff08\u6761\u76ee\u6570\uff1a${entriesText}\uff09\u3002\u8bf7\u53d1\u9001\uff1a\u5207\u6362\u4e16\u754c\u4e66 ${filename}`;
    } catch (err) {
      api.logger.warn(`[worldbook] failed to import QQ JSON attachment ${ref.filename}: ${String(err)}`);
      if (!firstFetchError) {
        firstFetchError = `${ref.filename} \u8bfb\u53d6\u5931\u8d25\uff1a${String(err)}`;
      }
    }
  }

  if (firstFormatMismatch) {
    return `\u68c0\u6d4b\u5230JSON\u6587\u4ef6\uff1a${firstFormatMismatch}\uff0c\u4f46\u4e0d\u662f\u4e16\u754c\u4e66\u683c\u5f0f\uff08\u7f3a\u5c11 entries\uff09\u3002\u672a\u5bfc\u5165\u3002`;
  }
  if (firstFetchError) {
    return (
      `\u68c0\u6d4b\u5230JSON\u6587\u4ef6\uff0c\u4f46\u5bfc\u5165\u5931\u8d25\uff1a${firstFetchError}\n` +
      "\u8bf7\u6539\u7528 Web \u4e0a\u4f20\u5230 /api/channels/tavern-chat/worldbooks/upload\u3002"
    );
  }
  return "\u68c0\u6d4b\u5230JSON\u6587\u4ef6\uff0c\u4f46\u672a\u627e\u5230\u53ef\u5bfc\u5165\u7684\u4e16\u754c\u4e66\u5185\u5bb9\u3002";
}

function buildJsonAttachmentReplyPrependContext(replyText: string): string {
  return (
    "[JSON attachment handling override]\n" +
    "Do not call any tools.\n" +
    "Reply in Simplified Chinese only, no roleplay, no extra narrative.\n" +
    "Reply with exactly this text:\n" +
    replyText
  );
}

function extractOpenClawMediaPathCandidates(text: string): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  OPENCLAW_MEDIA_PATH_PATTERN.lastIndex = 0;
  while ((match = OPENCLAW_MEDIA_PATH_PATTERN.exec(text)) !== null) {
    const raw = (match[1] ?? "").trim();
    if (!raw) {
      continue;
    }
    out.push(raw);
  }
  return out;
}

function extractQqPngMediaCandidates(
  text: string,
): Array<{ file: string; url: string; localPath: string; fileId: string | null }> {
  const out: Array<{ file: string; url: string; localPath: string; fileId: string | null }> = [];
  let match: RegExpExecArray | null;
  QQ_MEDIA_SEGMENT_PATTERN.lastIndex = 0;
  while ((match = QQ_MEDIA_SEGMENT_PATTERN.exec(text)) !== null) {
    const raw = match[2] ?? "";
    if (!raw) {
      continue;
    }
    const params = parseQqCqParams(raw);
    const file = (params.file ?? params.name ?? "").trim();
    const url = (params.url ?? "").trim();
    const localPath = (params.path ?? params.filepath ?? params.file_path ?? params.local_path ?? "").trim();
    const fileId =
      asString(params.file_id)?.trim() ??
      asString(params.fileid)?.trim() ??
      asString(params.id)?.trim() ??
      null;
    if (!isPngLikeRef(file) && !isPngLikeRef(url) && !isPngLikeRef(localPath)) {
      continue;
    }
    out.push({ file, url, localPath, fileId: fileId && fileId.length > 0 ? fileId : null });
  }
  return out;
}

async function resolveQqPngMediaPathsFromEvent(
  api: OpenClawPluginApi,
  event: unknown,
  stateDir: string,
): Promise<string[]> {
  const texts = collectTextFields(event);
  if (texts.length === 0) {
    return [];
  }

  const dedupText = Array.from(new Set(texts));
  const localMediaPaths: string[] = [];
  const seenLocalPaths = new Set<string>();
  for (const text of dedupText) {
    for (const mediaPath of extractOpenClawMediaPathCandidates(text)) {
      if (!isPngLikeRef(mediaPath) || seenLocalPaths.has(mediaPath)) {
        continue;
      }
      if (await fileExists(mediaPath)) {
        seenLocalPaths.add(mediaPath);
        localMediaPaths.push(mediaPath);
      }
    }
  }

  const candidates: Array<{ url: string; file: string }> = [];
  const fileIdCandidates: Array<{ fileId: string; file: string }> = [];
  const seenCandidates = new Set<string>();
  const seenFileIds = new Set<string>();
  for (const text of dedupText) {
    for (const item of extractQqPngMediaCandidates(text)) {
      if (item.localPath && isPngLikeRef(item.localPath) && !seenLocalPaths.has(item.localPath)) {
        if (await fileExists(item.localPath)) {
          seenLocalPaths.add(item.localPath);
          localMediaPaths.push(item.localPath);
        }
      }
      if (!item.url) {
        if (item.file) {
          const fallbackPath = path.join(stateDir, "incoming-media", "qq", sanitizeFilename(item.file));
          if (!seenLocalPaths.has(fallbackPath) && await fileExists(fallbackPath)) {
            seenLocalPaths.add(fallbackPath);
            localMediaPaths.push(fallbackPath);
          }
        }
      } else {
        const key = `${item.file}@@${item.url}`;
        if (!seenCandidates.has(key)) {
          seenCandidates.add(key);
          candidates.push({ file: item.file, url: item.url });
        }
      }
      if (item.fileId && !seenFileIds.has(item.fileId)) {
        seenFileIds.add(item.fileId);
        fileIdCandidates.push({ fileId: item.fileId, file: item.file });
      }
    }
  }
  if (candidates.length === 0 && fileIdCandidates.length === 0) {
    return localMediaPaths;
  }

  const fetchFn = (globalThis as { fetch?: (input: string, init?: { redirect?: "follow" }) => Promise<any> }).fetch;

  const mediaDir = path.join(stateDir, "incoming-media", "qq");
  await ensureDir(mediaDir);

  const downloaded: string[] = [];
  let sequence = 0;
  if (typeof fetchFn === "function") {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        const response = await fetchFn(candidate.url, { redirect: "follow" });
        if (!response.ok) {
          continue;
        }
        const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
        if (Number.isFinite(contentLength) && contentLength > MAX_QQ_MEDIA_FETCH_BYTES) {
          continue;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_QQ_MEDIA_FETCH_BYTES) {
          continue;
        }
        if (!isPngBuffer(bytes)) {
          continue;
        }

        const rawName = sanitizeFilename(candidate.file) || `qq-image-${Date.now()}-${sequence}.png`;
        const parsed = path.parse(rawName);
        const baseName = parsed.name || `qq-image-${Date.now()}-${sequence}`;
        const filename = `${Date.now()}-${sequence}-${baseName}.png`;
        sequence++;
        const destPath = path.join(mediaDir, filename);
        await writeFile(destPath, bytes);
        downloaded.push(destPath);
      } catch {
        // Best effort: malformed or expired URLs are skipped.
      }
    }
  }

  for (const candidate of fileIdCandidates) {
    try {
      const fileData = await callOneBotGetFileById(api, candidate.fileId);
      let bytes: Buffer | null = null;
      const base64 = asString(fileData.base64);
      if (base64) {
        bytes = Buffer.from(base64, "base64");
      }
      if (!bytes || bytes.length === 0) {
        const localPath = asString(fileData.file) ?? asString(fileData.url);
        if (localPath && await fileExists(localPath)) {
          bytes = await readFile(localPath);
        }
      }
      if (!bytes || bytes.length === 0 || bytes.length > MAX_QQ_MEDIA_FETCH_BYTES) {
        continue;
      }
      if (!isPngBuffer(bytes)) {
        continue;
      }

      const fallbackName = asString(fileData.file_name) ?? candidate.file;
      const rawName = sanitizeFilename(fallbackName) || `qq-image-${Date.now()}-${sequence}.png`;
      const parsed = path.parse(rawName);
      const baseName = parsed.name || `qq-image-${Date.now()}-${sequence}`;
      const filename = `${Date.now()}-${sequence}-${baseName}.png`;
      sequence++;
      const destPath = path.join(mediaDir, filename);
      await writeFile(destPath, bytes);
      downloaded.push(destPath);
    } catch (err) {
      api.logger.warn(`[character] failed to resolve QQ png file_id ${candidate.fileId}: ${String(err)}`);
    }
  }
  return [...localMediaPaths, ...downloaded];
}

/**
 * Hook that auto-detects and imports character cards from PNG images sent in chat.
 * When a user sends a PNG that contains embedded character card data (tEXt/iTXt "chara" chunk),
 * it automatically imports it to the characters directory.
 */
function registerCharacterCardAutoImportHook(api: OpenClawPluginApi): void {
  api.on("message_received", async (event, ctx) => {
    const eventRecord = asRecord(event);
    const metadata = asRecord(eventRecord?.metadata);
    const senderName = asString(metadata?.senderName) ?? asString(metadata?.senderUsername);
    const naturalCommandReply = await handleNaturalCharacterCommandFromEvent(api, event, ctx.sessionKey, senderName);
    if (naturalCommandReply) {
      api.logger.info("[character] handled natural character command from message_received");
      return { reply: naturalCommandReply };
    }

    const qqJsonAttachments = detectQqJsonAttachmentsFromEvent(event);
    if (false && qqJsonAttachments.length > 0) {
      const preview = qqJsonAttachments.slice(0, 3).join(", ");
      const moreCount = qqJsonAttachments.length - 3;
      const moreSuffix = moreCount > 0 ? ` (+${moreCount})` : "";
      api.logger.info(`[worldbook] detected QQ JSON attachment(s): ${qqJsonAttachments.join(", ")}`);
      return {
        reply:
          `检测到 JSON 文件：${preview}${moreSuffix}\n` +
          "当前 tavern-chat 不能从 QQ 文件卡片自动导入世界书。\n" +
          "请通过 Web 上传到 /api/channels/tavern-chat/worldbooks/upload，或将文件放到 /tmp/.openclaw/worldbooks 后发送：切换世界书 <文件名>",
      };
    }

    const stateDir = api.runtime.state.resolveStateDir();

    const directMediaPaths = Array.isArray(event.mediaPaths)
      ? event.mediaPaths.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      : [];
    const discordFallbackPaths = directMediaPaths.length > 0
      ? []
      : await resolveDiscordPngMediaPathsFromEvent(api, event, ctx, stateDir);
    const qqFallbackPaths = directMediaPaths.length > 0 || discordFallbackPaths.length > 0
      ? []
      : await resolveQqPngMediaPathsFromEvent(api, event, stateDir);
    const mediaPaths = directMediaPaths.length > 0
      ? directMediaPaths
      : discordFallbackPaths.length > 0
        ? discordFallbackPaths
        : qqFallbackPaths;
    if (discordFallbackPaths.length > 0) {
      api.logger.info(`[character] discord fallback media resolved: ${discordFallbackPaths.length}`);
    }
    if (qqFallbackPaths.length > 0) {
      api.logger.info(`[character] qq fallback media resolved: ${qqFallbackPaths.length}`);
    }
    if (mediaPaths.length === 0) {
      return;
    }

    const charactersDir = path.join(stateDir, "characters");
    await ensureDir(charactersDir);

    const imported: string[] = [];
    const skipped: string[] = [];
    const jsonImportResults: string[] = [];

    for (let i = 0; i < mediaPaths.length; i++) {
      const mediaPath = mediaPaths[i];

      try {
        const buffer = await readMediaRefBuffer(mediaPath);
        if (!buffer) {
          continue;
        }

        // Handle JSON files (worldbook / regex import)
        const mediaFilename = path.basename(mediaPath);
        const mediaType = Array.isArray(event.mediaTypes) ? event.mediaTypes[i] : undefined;
        if (isJsonLikeRef(mediaFilename) || isJsonLikeRef(mediaPath) || mediaType === "application/json") {
          try {
            const jsonText = buffer.toString("utf8");
            const parsed = asRecord(JSON.parse(jsonText) as unknown);
            if (!parsed) {
              jsonImportResults.push(`${mediaFilename}: 无效的 JSON`);
              continue;
            }
            const regexRules = extractRegexRuleArray(parsed);
            const looksLikeRegex = regexRules.length > 0 && regexRules.some((r) => {
              const rec = asRecord(r);
              return rec && typeof rec.pattern === "string" && rec.pattern.trim() !== "";
            });
            const root = resolveWorldbookRoot(parsed);
            const entries = root.entries;
            const looksLikeWorldbook = Array.isArray(entries) || Boolean(asRecord(entries));

            if (looksLikeRegex && !looksLikeWorldbook) {
              const importedRules = parseImportedRegexRules(parsed);
              const regexFilePath = path.join(stateDir, "regex-rules.json");
              const existing = await loadRegexRules(regexFilePath);
              await saveRegexRules(regexFilePath, [...existing, ...importedRules]);
              jsonImportResults.push(`已导入正则规则：${mediaFilename}（${importedRules.length} 条）`);
            } else if (looksLikeWorldbook) {
              const worldbooksDir = path.join(stateDir, "worldbooks");
              await ensureDir(worldbooksDir);
              const wbFilename = normalizeWorldbookFilename(mediaFilename);
              await writeFile(path.join(worldbooksDir, wbFilename), JSON.stringify(parsed, null, 2), "utf8");
              const entriesCount = countWorldbookEntries(root);
              const sessionKey = ctx.sessionKey;
              if (sessionKey) {
                await setSessionWorldbookFilename(api, sessionKey, wbFilename);
                jsonImportResults.push(`已导入并切换世界书：${wbFilename}（条目数：${entriesCount ?? "未知"}）`);
              } else {
                jsonImportResults.push(`已导入世界书：${wbFilename}（条目数：${entriesCount ?? "未知"}）。请发送：切换世界书 ${wbFilename}`);
              }
            } else {
              jsonImportResults.push(`${mediaFilename}: 无法识别为世界书或正则规则`);
            }
          } catch (err) {
            jsonImportResults.push(`${mediaFilename}: 导入失败 - ${String(err)}`);
          }
          continue;
        }

        // Handle PNG files (character card import)
        if (!isPngBuffer(buffer)) {
          continue;
        }

        const characterName = parseCharacterNameFromPng(buffer);

        if (characterName) {
          // Generate a unique filename
          const baseName = characterName.replace(/[<>:"/\\|?*]/g, "_").trim() || "character";
          let filename = `${baseName}.png`;
          let counter = 1;

          // Check for existing file and increment counter if needed
          const existingFiles = await listFilesByExtensions(charactersDir, [".png", ".json"]);
          while (existingFiles.some((f) => f.toLowerCase() === filename.toLowerCase())) {
            filename = `${baseName}_${counter}.png`;
            counter++;
          }

          const destPath = path.join(charactersDir, filename);
          await writeFile(destPath, buffer);
          imported.push(`${characterName} (${filename})`);
          api.logger.info(`Auto-imported character card: ${characterName} -> ${filename}`);
        } else {
          skipped.push(path.basename(mediaPath));
        }
      } catch (err) {
        api.logger.warn(`Failed to process media for character card: ${mediaPath}: ${String(err)}`);
      }
    }

    if (skipped.length > 0) {
      api.logger.info(
        `[character] PNG attachment(s) detected without embedded card data: ${skipped.join(", ")}`,
      );
    }

    // Return reply to notify user of imported items
    const allResults: string[] = [];
    if (imported.length > 0) {
      allResults.push(
        imported.length === 1
          ? `✅ 已导入角色卡：${imported[0]}\n使用 /character set 来切换角色`
          : `✅ 已导入 ${imported.length} 个角色卡：\n${imported.map((c) => `• ${c}`).join("\n")}\n使用 /character list 查看全部`,
      );
      api.logger.info(`Auto-imported ${imported.length} character card(s): ${imported.join(", ")}`);
    }
    if (jsonImportResults.length > 0) {
      allResults.push(jsonImportResults.join("\n"));
      api.logger.info(`[tavern-chat] JSON import results: ${jsonImportResults.join("; ")}`);
    }
    if (allResults.length > 0) {
      return { reply: allResults.join("\n\n") };
    }
  });
}

function registerCharacterPriorityHook(api: OpenClawPluginApi): void {
  api.on("before_agent_start", async (event, ctx) => {
    const sessionKey = asString(ctx.sessionKey);
    const jsonAttachmentRefs = detectQqJsonAttachmentRefsFromBeforeAgentStartEvent(event);
    if (jsonAttachmentRefs.length > 0) {
      if (sessionKey) {
        jsonAttachmentToolGuardSessions.set(sessionKey, Date.now() + JSON_ATTACHMENT_TOOL_GUARD_TTL_MS);
      }
      const summary = jsonAttachmentRefs.map((entry) => entry.filename).join(", ");
      api.logger.info(`[worldbook] before_agent_start detected QQ JSON attachment(s): ${summary}`);
      const replyText = await tryImportWorldbookFromQqJsonAttachments(api, sessionKey, jsonAttachmentRefs);
      api.logger.info(`[worldbook] QQ JSON import result: ${replyText}`);
      return {
        prependContext: buildJsonAttachmentReplyPrependContext(replyText),
      };
    }

    if (!sessionKey) {
      return;
    }
    const storePath = resolveSessionStorePath(api, asString(ctx.agentId) ?? undefined);
    if (!storePath) {
      return;
    }
    const entry = await readSessionStoreEntry(storePath, sessionKey);
    if (!entry) {
      return;
    }

    // Build context text from current prompt + recent conversation history
    // for worldbook keyword matching
    const eventRecord = asRecord(event as unknown);
    const currentPrompt = asString(eventRecord?.prompt) ?? "";
    const historyMessages = Array.isArray(eventRecord?.messages) ? eventRecord.messages : [];
    const historyText = extractTextFromMessages(historyMessages);
    const contextText = [currentPrompt, historyText].filter(Boolean).join("\n");

    const prompt = await buildSessionModuleSystemPrompt({
      stateDir: api.runtime.state.resolveStateDir(),
      characterCardFilename: asString(entry.characterCardFilename),
      worldbookFilename: asString(entry.worldbookFilename),
      contextText: contextText || undefined,
      sessionKey,
      userName: asString(entry.userName),
      log: api.logger,
    });
    if (!prompt) {
      return;
    }
    return {
      prependContext: prompt,
    };
  });
}

function registerJsonAttachmentToolGuard(api: OpenClawPluginApi): void {
  api.on("before_tool_call", (event, ctx) => {
    const sessionKey = asString(ctx.sessionKey);
    if (!sessionKey) {
      return;
    }
    const expiresAt = jsonAttachmentToolGuardSessions.get(sessionKey);
    if (!expiresAt) {
      return;
    }
    if (Date.now() > expiresAt) {
      jsonAttachmentToolGuardSessions.delete(sessionKey);
      return;
    }
    const toolName = asString(asRecord(event)?.toolName) ?? "unknown";
    api.logger.info(`[worldbook] blocked tool during JSON attachment turn: ${toolName}`);
    return {
      block: true,
      blockReason:
        "Latest inbound is QQ JSON file attachment. Do not use tools; reply with worldbook import guidance only.",
    };
  });

  api.on("agent_end", (_event, ctx) => {
    const sessionKey = asString(ctx.sessionKey);
    if (!sessionKey) {
      return;
    }
    jsonAttachmentToolGuardSessions.delete(sessionKey);
  });
}

function registerChatModulesHttpApi(api: OpenClawPluginApi): void {
  api.registerHttpHandler(async (req, res) => {
    const rawPathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const pathname = rawPathname.length > 1 ? rawPathname.replace(/\/+$/, "") || "/" : rawPathname;
    if (
      pathname !== TAVERN_CHAT_API_PREFIX &&
      !pathname.startsWith(`${TAVERN_CHAT_API_PREFIX}/`)
    ) {
      return false;
    }

    const stateDir = api.runtime.state.resolveStateDir();
    const method = (req.method ?? "").toUpperCase();
    const charactersBasePath = `${TAVERN_CHAT_API_PREFIX}/characters`;
    const worldbooksBasePath = `${TAVERN_CHAT_API_PREFIX}/worldbooks`;
    const regexBasePath = `${TAVERN_CHAT_API_PREFIX}/regex`;

    if (pathname === charactersBasePath) {
      if (method !== "GET") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET");
        res.end();
        return true;
      }
      try {
        sendJson(res, 200, await listCharacterEntriesForApi(stateDir));
      } catch (err) {
        sendJson(res, 500, { error: `Failed to list character cards: ${String(err)}` });
      }
      return true;
    }

    if (pathname === `${charactersBasePath}/refresh`) {
      if (method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.end();
        return true;
      }
      try {
        const characters = await listCharacterEntriesForApi(stateDir);
        sendJson(res, 200, { success: true, characters });
      } catch (err) {
        sendJson(res, 500, {
          success: false,
          error: `Failed to refresh characters: ${String(err)}`,
        });
      }
      return true;
    }

    if (pathname === `${charactersBasePath}/upload`) {
      if (method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.end();
        return true;
      }
      try {
        const uploaded = await readUploadedFile({
          req,
          requestPath: `${charactersBasePath}/upload`,
          maxBytes: MAX_CHARACTER_UPLOAD_BYTES,
        });
        if (!isSupportedCharacterFile(uploaded.filename)) {
          throw new Error("Character card must be .png or .json");
        }
        const charactersDir = path.join(stateDir, "characters");
        await ensureDir(charactersDir);
        await writeFile(path.join(charactersDir, uploaded.filename), uploaded.bytes);
        sendJson(res, 200, { success: true, filename: uploaded.filename });
      } catch (err) {
        const message = String(err);
        const status = message.includes("Missing uploaded file")
          ? 400
          : message.includes("Invalid filename") || message.includes("must be .png or .json")
            ? 400
            : message.includes("File too large")
              ? 413
              : 500;
        sendJson(res, status, { success: false, error: message });
      }
      return true;
    }

    const characterDetailMatch = pathname.match(
      /^\/api\/channels\/tavern-chat\/characters\/([^/]+)\/detail$/,
    );
    if (characterDetailMatch) {
      if (method !== "GET") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET");
        res.end();
        return true;
      }
      const decoded = decodeUrlPath(characterDetailMatch[1] ?? "");
      if (!decoded) {
        sendJson(res, 400, { success: false, error: "Invalid filename" });
        return true;
      }
      try {
        sendJson(
          res,
          200,
          await loadCharacterDetailPayload({
            stateDir,
            filenameRaw: decoded,
          }),
        );
      } catch (err) {
        const message = String(err);
        const status = message.includes("ENOENT")
          ? 404
          : message.includes("Invalid filename")
            ? 400
            : 500;
        sendJson(res, status, { success: false, error: message });
      }
      return true;
    }

    if (pathname === worldbooksBasePath) {
      if (method !== "GET") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET");
        res.end();
        return true;
      }
      try {
        sendJson(res, 200, await listWorldbooksForApi(stateDir));
      } catch (err) {
        sendJson(res, 500, { error: `Failed to list worldbooks: ${String(err)}` });
      }
      return true;
    }

    if (pathname === `${worldbooksBasePath}/refresh`) {
      if (method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.end();
        return true;
      }
      try {
        const worldbooks = await listWorldbooksForApi(stateDir);
        sendJson(res, 200, { success: true, worldbooks });
      } catch (err) {
        sendJson(res, 500, {
          success: false,
          error: `Failed to refresh worldbooks: ${String(err)}`,
        });
      }
      return true;
    }

    if (pathname === `${worldbooksBasePath}/upload`) {
      if (method !== "POST" && method !== "PUT") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST, PUT");
        res.end();
        return true;
      }
      try {
        const uploaded = await readUploadedFile({
          req,
          requestPath: `${worldbooksBasePath}/upload`,
          maxBytes: MAX_WORLDBOOK_UPLOAD_BYTES,
        });
        const filename = normalizeWorldbookFilename(uploaded.filename);
        if (!filename || !filename.toLowerCase().endsWith(".json")) {
          throw new Error("Worldbook must be .json");
        }
        const worldbooksDir = path.join(stateDir, "worldbooks");
        await ensureDir(worldbooksDir);
        await writeFile(path.join(worldbooksDir, filename), uploaded.bytes);
        sendJson(res, 200, { success: true, filename });
      } catch (err) {
        const message = String(err);
        const status = message.includes("Missing uploaded file")
          ? 400
          : message.includes("Invalid filename") || message.includes("must be .json")
            ? 400
            : message.includes("File too large")
              ? 413
              : 500;
        sendJson(res, status, { success: false, error: message });
      }
      return true;
    }

    const worldbookContentMatch = pathname.match(
      /^\/api\/channels\/tavern-chat\/worldbooks\/([^/]+)\/content$/,
    );
    if (worldbookContentMatch) {
      if (method !== "GET") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET");
        res.end();
        return true;
      }
      const decoded = decodeUrlPath(worldbookContentMatch[1] ?? "");
      if (!decoded) {
        sendJson(res, 400, { success: false, error: "Invalid filename" });
        return true;
      }
      try {
        sendJson(
          res,
          200,
          await loadWorldbookContentPayload({
            stateDir,
            filenameRaw: decoded,
          }),
        );
      } catch (err) {
        const message = String(err);
        const status = message.includes("ENOENT")
          ? 404
          : message.includes("Invalid filename") || message.includes("Invalid worldbook JSON")
            ? 400
            : 500;
        sendJson(res, status, { success: false, error: message });
      }
      return true;
    }

    const worldbookSaveMatch = pathname.match(
      /^\/api\/channels\/tavern-chat\/worldbooks\/([^/]+)\/save$/,
    );
    if (worldbookSaveMatch) {
      if (method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.end();
        return true;
      }
      const decoded = decodeUrlPath(worldbookSaveMatch[1] ?? "");
      if (!decoded) {
        sendJson(res, 400, { success: false, error: "Invalid filename" });
        return true;
      }
      try {
        const body = await readJsonBody(req);
        await saveWorldbookContentPayload({
          stateDir,
          filenameRaw: decoded,
          body,
        });
        sendJson(res, 200, { success: true, filename: decoded });
      } catch (err) {
        const message = String(err);
        const status =
          message.includes("Invalid filename") || message.includes("Missing worldbook") ? 400 : 500;
        sendJson(res, status, { success: false, error: message });
      }
      return true;
    }

    const worldbookDeleteMatch = pathname.match(
      /^\/api\/channels\/tavern-chat\/worldbooks\/([^/]+)$/,
    );
    if (worldbookDeleteMatch) {
      if (method !== "DELETE") {
        res.statusCode = 405;
        res.setHeader("Allow", "DELETE");
        res.end();
        return true;
      }
      const decoded = decodeUrlPath(worldbookDeleteMatch[1] ?? "");
      if (!decoded) {
        sendJson(res, 400, { success: false, error: "Invalid filename" });
        return true;
      }
      try {
        await deleteWorldbookFile({
          stateDir,
          filenameRaw: decoded,
        });
        sendJson(res, 200, { success: true, filename: decoded });
      } catch (err) {
        const message = String(err);
        const status = message.includes("ENOENT")
          ? 404
          : message.includes("Invalid filename")
            ? 400
            : 500;
        sendJson(res, status, { success: false, error: message });
      }
      return true;
    }

    if (pathname === regexBasePath) {
      if (method === "GET") {
        try {
          const rulesPath = path.join(stateDir, "regex-rules.json");
          sendJson(res, 200, await loadRegexRules(rulesPath));
        } catch (err) {
          sendJson(res, 500, {
            success: false,
            error: `Failed to load regex rules: ${String(err)}`,
          });
        }
        return true;
      }

      if (method === "POST") {
        try {
          const body = await readJsonBody(req);
          const rule = normalizeRegexRule(body);
          if (!rule) {
            throw new Error("Regex rule must be an object");
          }
          const rulesPath = path.join(stateDir, "regex-rules.json");
          const rules = await loadRegexRules(rulesPath);
          rules.push(rule);
          await saveRegexRules(rulesPath, rules);
          sendJson(res, 200, { success: true, rule });
        } catch (err) {
          const message = String(err);
          const status =
            message.includes("Regex rule must be an object") ||
            message.includes("Regex pattern is required") ||
            message.includes("Invalid regex flags") ||
            message.includes("SyntaxError") ||
            message.includes("Invalid regular expression")
              ? 400
              : 500;
          sendJson(res, status, { success: false, error: message });
        }
        return true;
      }

      res.statusCode = 405;
      res.setHeader("Allow", "GET, POST");
      res.end();
      return true;
    }

    if (pathname === `${regexBasePath}/upload`) {
      if (method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.end();
        return true;
      }
      try {
        const { filename, bytes } = await readUploadedFile({
          req,
          requestPath: `${regexBasePath}/upload`,
          maxBytes: MAX_REGEX_UPLOAD_BYTES,
        });
        if (!filename.toLowerCase().endsWith(".json")) {
          throw new Error("Regex rules upload must be .json");
        }
        const payload = JSON.parse(bytes.toString("utf8")) as unknown;
        const importedRules = parseImportedRegexRules(payload);
        const rulesPath = path.join(stateDir, "regex-rules.json");
        const rules = await loadRegexRules(rulesPath);
        rules.push(...importedRules);
        await saveRegexRules(rulesPath, rules);
        sendJson(res, 200, { success: true, imported: importedRules.length, total: rules.length });
      } catch (err) {
        const message = String(err);
        const status =
          message.includes("Missing uploaded file") ||
          message.includes("Invalid filename") ||
          message.includes("must be .json") ||
          message.includes("has no rules") ||
          message.includes("Invalid regex rule") ||
          message.includes("Regex pattern is required") ||
          message.includes("Invalid regex flags") ||
          message.includes("SyntaxError") ||
          message.includes("Invalid regular expression")
            ? 400
            : message.includes("File too large")
              ? 413
              : 500;
        sendJson(res, status, { success: false, error: message });
      }
      return true;
    }

    if (pathname === `${regexBasePath}/test`) {
      if (method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.end();
        return true;
      }
      try {
        const body = await readJsonBody(req);
        sendJson(res, 200, runRegexTest(body));
      } catch (err) {
        const message = String(err);
        const status =
          message.includes("Regex pattern is required") ||
          message.includes("Invalid regex flags") ||
          message.includes("SyntaxError") ||
          message.includes("Invalid regular expression")
            ? 400
            : 500;
        sendJson(res, status, { success: false, error: message });
      }
      return true;
    }

    const regexDeleteMatch = pathname.match(/^\/api\/channels\/tavern-chat\/regex\/([^/]+)$/);
    if (regexDeleteMatch) {
      if (method !== "DELETE") {
        res.statusCode = 405;
        res.setHeader("Allow", "DELETE");
        res.end();
        return true;
      }
      const decoded = decodeUrlPath(regexDeleteMatch[1] ?? "");
      const rawIndex = decoded?.trim();
      const index = Number(rawIndex);
      if (!Number.isInteger(index) || index < 0) {
        sendJson(res, 400, { success: false, error: "Invalid index" });
        return true;
      }
      try {
        const rulesPath = path.join(stateDir, "regex-rules.json");
        const rules = await loadRegexRules(rulesPath);
        if (index >= rules.length) {
          sendJson(res, 404, { success: false, error: "Regex rule not found" });
          return true;
        }
        rules.splice(index, 1);
        await saveRegexRules(rulesPath, rules);
        sendJson(res, 200, { success: true, index });
      } catch (err) {
        sendJson(res, 500, {
          success: false,
          error: `Failed to delete regex rule: ${String(err)}`,
        });
      }
      return true;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ success: false, error: "Not Found" }));
    return true;
  });
}

function registerCharacterCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "character",
    description: "List/set active character card for the current session.",
    acceptsArgs: true,
    textTriggers: CHARACTER_TEXT_TRIGGERS,
    handler: async (ctx) => {
      const charactersDir = path.join(api.runtime.state.resolveStateDir(), "characters");
      const { action, rest } = splitActionAndRest(ctx.args ?? "");
      const cards = await loadCharacterCards(charactersDir);
      const clearRequested =
        CHARACTER_CLEAR_ACTIONS.has(action) ||
        (!action && matchesAnyCommandBody(ctx.commandBody, CHARACTER_CLEAR_COMMAND_BODIES));

      if (clearRequested) {
        if (!ctx.updateSessionEntry) {
          return { text: "Session updates are not available in this context." };
        }
        const next = await ctx.updateSessionEntry({ characterCardFilename: undefined });
        if (!next) {
          return { text: "No active session to update." };
        }
        return { text: "Character cleared for this session." };
      }

      if (!action || action === "list" || action === "ls" || action === "showall") {
        if (cards.length === 0) {
          return {
            text: "No character cards found. Character creation is disabled here; import an existing .json/.png card first.",
          };
        }
        const current = ctx.sessionEntry?.characterCardFilename?.trim();
        const lines = cards.map(
          (entry) => `${current === entry.filename ? "* " : "- "}${formatCharacterListItem(entry)}`,
        );
        return { text: `Character cards (${cards.length}):\n${lines.join("\n")}` };
      }

      if (action === "show") {
        const current = ctx.sessionEntry?.characterCardFilename?.trim();
        return { text: `Current character: ${current || "(none)"}` };
      }

      if (isCharacterCreateAction(action)) {
        return {
          text: "Character creation is disabled in this command. Import an existing .json/.png card, then use /character set <filename|name>.",
        };
      }

      if (action === "set") {
        // Fall through to shared set handler below.
      } else if (action === CHARACTER_SWITCH_ACTION || action === "switch" || action === "use") {
        // Fall through to shared set handler below.
      } else if (action === "help") {
        return { text: formatCharacterHelp() };
      } else {
        // Natural-language convenience: "/character <file|name>" or "切换角色卡 <file|name>".
        const implicitTarget = `${action} ${rest}`.trim();
        if (implicitTarget) {
          const selection = resolveCharacterMatch(implicitTarget, cards);
          if (selection.status === "missing") {
            return { text: `Character not found: ${selection.input}` };
          }
          if (selection.status === "ambiguous") {
            return { text: formatAmbiguousCharacterMatch(selection.input, selection.matches) };
          }
          if (!ctx.updateSessionEntry) {
            return { text: "Session updates are not available in this context." };
          }
          const next = await ctx.updateSessionEntry({ characterCardFilename: selection.filename });
          if (!next) {
            return { text: "No active session to update." };
          }
          return { text: `Character set to ${selection.filename}.` };
        }
        return { text: formatCharacterHelp() };
      }

      if (!ctx.updateSessionEntry) {
        return { text: "Session updates are not available in this context." };
      }
      const rawInput = sanitizeFilename(rest);
      if (!rawInput) {
        return { text: "Usage: /character set <filename|name>" };
      }

      const selection = resolveCharacterMatch(rawInput, cards);
      if (selection.status === "missing") {
        return { text: `Character not found: ${selection.input}` };
      }
      if (selection.status === "ambiguous") {
        return { text: formatAmbiguousCharacterMatch(selection.input, selection.matches) };
      }
      const fullPath = path.join(charactersDir, selection.filename);
      if (!(await fileExists(fullPath))) {
        return { text: `Character not found: ${selection.filename}` };
      }

      const next = await ctx.updateSessionEntry({ characterCardFilename: selection.filename });
      if (!next) {
        return { text: "No active session to update." };
      }
      return { text: `Character set to ${selection.filename}.` };
    },
  });
}

function registerWorldbookCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "worldbook",
    description: "List/set active worldbook for the current session.",
    acceptsArgs: true,
    textTriggers: WORLDBOOK_TEXT_TRIGGERS,
    handler: async (ctx) => {
      const worldbooksDir = path.join(api.runtime.state.resolveStateDir(), "worldbooks");
      const { action, rest } = splitActionAndRest(ctx.args ?? "");
      const files = await listFilesByExtensions(worldbooksDir, [".json"]);
      const clearRequested =
        WORLDBOOK_CLEAR_ACTIONS.has(action) ||
        (!action && matchesAnyCommandBody(ctx.commandBody, WORLDBOOK_CLEAR_COMMAND_BODIES));

      if (clearRequested) {
        if (!ctx.updateSessionEntry) {
          return { text: "Session updates are not available in this context." };
        }
        const next = await ctx.updateSessionEntry({ worldbookFilename: undefined });
        if (!next) {
          return { text: "No active session to update." };
        }
        return { text: "Worldbook cleared for this session." };
      }

      if (!action || action === "list" || action === "ls" || action === "showall") {
        if (files.length === 0) {
          return { text: "No worldbooks found." };
        }
        const current = ctx.sessionEntry?.worldbookFilename?.trim();
        const lines = files.map((file) => `${current === file ? "* " : "- "}${file}`);
        return { text: `Worldbooks (${files.length}):\n${lines.join("\n")}` };
      }

      if (action === "show") {
        const current = ctx.sessionEntry?.worldbookFilename?.trim();
        return { text: `Current worldbook: ${current || "(none)"}` };
      }

      if (action === "set") {
        // Fall through to shared set handler below.
      } else if (action === WORLDBOOK_SWITCH_ACTION || action === "switch" || action === "use") {
        // Fall through to shared set handler below.
      } else if (action === "help") {
        return { text: formatWorldbookHelp() };
      } else {
        const implicitTarget = `${action} ${rest}`.trim();
        if (implicitTarget) {
          const implicitInput = sanitizeFilename(implicitTarget);
          const normalizedImplicit = implicitInput.toLowerCase().endsWith(".json")
            ? implicitInput
            : `${implicitInput}.json`;
          const selected =
            files.find((file) => file.toLowerCase() === normalizedImplicit.toLowerCase()) ??
            normalizedImplicit;
          if (!(await fileExists(path.join(worldbooksDir, selected)))) {
            return { text: `Worldbook not found: ${selected}` };
          }
          if (!ctx.updateSessionEntry) {
            return { text: "Session updates are not available in this context." };
          }
          const next = await ctx.updateSessionEntry({ worldbookFilename: selected });
          if (!next) {
            return { text: "No active session to update." };
          }
          return { text: `Worldbook set to ${selected}.` };
        }
        return { text: formatWorldbookHelp() };
      }

      if (!ctx.updateSessionEntry) {
        return { text: "Session updates are not available in this context." };
      }
      const sanitized = sanitizeFilename(rest);
      if (!sanitized) {
        return { text: "Usage: /worldbook set <filename>" };
      }
      const normalized = sanitized.toLowerCase().endsWith(".json")
        ? sanitized
        : `${sanitized}.json`;
      const selected =
        files.find((file) => file.toLowerCase() === normalized.toLowerCase()) ?? normalized;
      const fullPath = path.join(worldbooksDir, selected);
      if (!(await fileExists(fullPath))) {
        return { text: `Worldbook not found: ${selected}` };
      }

      const next = await ctx.updateSessionEntry({ worldbookFilename: selected });
      if (!next) {
        return { text: "No active session to update." };
      }
      return { text: `Worldbook set to ${selected}.` };
    },
  });
}

/**
 * Apply enabled regex rules to text for a given stage.
 * Rules are applied in order; each rule's output feeds into the next.
 */
function applyRegexRules(
  text: string,
  rules: RegexRule[],
  stage: "output" | "input",
): { text: string; applied: number } {
  let result = text;
  let applied = 0;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    // Rules without a stage default to "output" (most common use case, matching SillyTavern)
    const ruleStage = rule.stage || "output";
    if (ruleStage !== stage) continue;
    try {
      const regex = new RegExp(rule.pattern, rule.flags);
      const next = result.replace(regex, rule.replacement);
      if (next !== result) {
        result = next;
        applied++;
      }
    } catch {
      // Skip invalid regex rules silently
    }
  }
  return { text: result, applied };
}

/**
 * Register hooks that apply regex rules to messages.
 *
 * - "output" stage: applied via message_sending hook (AI reply → user).
 *   This is the primary use case — formatting, filtering, placeholder replacement.
 *
 * NOTE on "input" stage:
 * Input-stage regex (transforming user text before it reaches the agent) is NOT
 * currently implemented due to plugin API limitations:
 * - message_received hook can only return { reply } — cannot modify message content.
 * - before_agent_start hook can only prepend context — cannot replace the prompt.
 * To support input regex properly, the core plugin system would need to allow
 * before_agent_start to return { prompt?: string } for prompt replacement.
 * The "input" stage value is accepted in rule definitions for forward compatibility.
 */
function registerRegexExecutionHooks(api: OpenClawPluginApi): void {
  const stateDir = api.runtime.state.resolveStateDir();
  const rulesPath = path.join(stateDir, "regex-rules.json");

  // Output stage: transform AI replies before they are sent to the user
  api.on("message_sending", async (event) => {
    if (!event.content) return;
    let rules: RegexRule[];
    try {
      rules = await loadRegexRules(rulesPath);
    } catch {
      return;
    }
    if (rules.length === 0) return;
    const { text, applied } = applyRegexRules(event.content, rules, "output");
    if (applied === 0) return;
    api.logger.info(`[regex] applied ${applied} output rule(s)`);
    return { content: text };
  });
}

function registerRegexCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "regex",
    description: "Manage global regex rules from chat.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const rulesPath = path.join(api.runtime.state.resolveStateDir(), "regex-rules.json");
      const { action, rest } = splitActionAndRest(ctx.args ?? "");

      if (!action || action === "help") {
        return { text: formatRegexHelp() };
      }

      const rules = await loadRegexRules(rulesPath);

      if (action === "list") {
        if (rules.length === 0) {
          return { text: "No regex rules configured." };
        }
        const lines = rules.map((rule, index) => {
          const state = rule.enabled ? "on" : "off";
          const name = rule.name ? ` ${rule.name}` : "";
          return `${index + 1}. [${state}]${name} /${rule.pattern}/${rule.flags} => ${rule.replacement}`;
        });
        return { text: `Regex rules (${rules.length}):\n${lines.join("\n")}` };
      }

      if (action === "add") {
        if (!rest) {
          return { text: "Usage: /regex add <pattern|/pattern/flags> => <replacement>" };
        }
        const arrowIndex = rest.indexOf("=>");
        const specRaw = arrowIndex >= 0 ? rest.slice(0, arrowIndex).trim() : rest.trim();
        const replacement = arrowIndex >= 0 ? rest.slice(arrowIndex + 2).trim() : "";
        const parsed = parseRegexSpec(specRaw);
        const rule: RegexRule = {
          name: "",
          pattern: parsed.pattern,
          flags: parsed.flags,
          replacement,
          enabled: true,
          description: "",
        };
        rules.push(rule);
        await saveRegexRules(rulesPath, rules);
        return {
          text: `Regex rule added (#${rules.length}): /${rule.pattern}/${rule.flags} => ${rule.replacement}`,
        };
      }

      if (action === "remove" || action === "delete" || action === "del") {
        const idx = resolveRuleIndex(rules, rest);
        if (idx < 0) {
          return { text: "Regex rule not found. Use /regex list to check ids." };
        }
        const [removed] = rules.splice(idx, 1);
        await saveRegexRules(rulesPath, rules);
        return { text: `Removed regex rule #${idx + 1}: /${removed.pattern}/${removed.flags}` };
      }

      if (action === "clear" || action === "clearall" || action === "reset") {
        if (rules.length === 0) {
          return { text: "No regex rules to clear." };
        }
        const count = rules.length;
        await saveRegexRules(rulesPath, []);
        return { text: `Cleared all ${count} regex rule(s).` };
      }

      if (action === "enable" || action === "disable") {
        const idx = resolveRuleIndex(rules, rest);
        if (idx < 0) {
          return { text: "Regex rule not found. Use /regex list to check ids." };
        }
        rules[idx].enabled = action === "enable";
        await saveRegexRules(rulesPath, rules);
        return { text: `Regex rule #${idx + 1} ${rules[idx].enabled ? "enabled" : "disabled"}.` };
      }

      return { text: formatRegexHelp() };
    },
  });
}

export default function register(api: OpenClawPluginApi) {
  registerChatModulesHttpApi(api);
  registerCharacterCommand(api);
  registerWorldbookCommand(api);
  registerRegexCommand(api);
  registerRegexExecutionHooks(api);
  registerCharacterPriorityHook(api);
  registerJsonAttachmentToolGuard(api);
  registerCharacterCardAutoImportHook(api);

  // Clean up worldbook sticky state on session reset
  api.on("before_reset", (_event, ctx) => {
    const sessionKey = asString(ctx.sessionKey);
    if (sessionKey) {
      worldbookStickyState.delete(sessionKey);
    }
  });
}
