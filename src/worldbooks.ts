import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type NormalizedWorldbookEntry,
  asRecord, asString, ensureDir, listFilesByExtensions, normalizeWhitespace,
  sanitizeFilename, toBoolean, toNumber, toStringList, truncate,
  MAX_WORLD_ENTRIES, MAX_WORLD_ENTRY_CONTENT_CHARS, MAX_WORLD_SECTION_CHARS,
} from "./utils.js";
import { stat as fsStat } from "node:fs/promises";

// ── Worldbook Sticky State ──

export const worldbookStickyState = new Map<string, Map<string, number>>();

// ── Filename Helpers ──

export function normalizeWorldbookFilename(input: string): string {
  const safe = sanitizeFilename(input);
  if (!safe) return "";
  return safe.toLowerCase().endsWith(".json") ? safe : `${safe}.json`;
}

export function ensureWorldbookFilename(filenameRaw: string): string {
  const filename = normalizeWorldbookFilename(filenameRaw);
  if (!filename || filename !== filenameRaw || !filename.toLowerCase().endsWith(".json")) throw new Error("Invalid filename");
  return filename;
}

// ── Worldbook Root Resolution ──

export function resolveWorldbookRoot(worldbook: Record<string, unknown>): Record<string, unknown> {
  const nestedWorldbook = asRecord(worldbook.worldbook);
  const nestedData = asRecord(worldbook.data);
  const nestedDataWorldbook = asRecord(nestedData?.worldbook);
  const candidates = [worldbook, nestedWorldbook, nestedData, nestedDataWorldbook].filter(
    (e): e is Record<string, unknown> => Boolean(e),
  );
  for (const candidate of candidates) {
    const entries = candidate.entries;
    if (Array.isArray(entries) || Boolean(asRecord(entries))) return candidate;
  }
  return worldbook;
}

export function countWorldbookEntries(worldbook: Record<string, unknown>): number | null {
  const entries = worldbook.entries;
  if (Array.isArray(entries)) return entries.length;
  const objectEntries = asRecord(entries);
  if (objectEntries) return Object.keys(objectEntries).length;
  return null;
}

export function isWorldbookJsonObject(value: Record<string, unknown>): boolean {
  const root = resolveWorldbookRoot(value);
  const entries = root.entries;
  return Array.isArray(entries) || Boolean(asRecord(entries));
}

// ── Entry Normalization ──

export function normalizeWorldbookEntries(worldbook: Record<string, unknown>): NormalizedWorldbookEntry[] {
  const worldbookRoot = resolveWorldbookRoot(worldbook);
  const rawEntries = worldbookRoot.entries;
  let entries: Record<string, unknown>[] = [];
  if (Array.isArray(rawEntries)) {
    entries = rawEntries.map((e) => asRecord(e)).filter((e): e is Record<string, unknown> => Boolean(e));
  } else {
    const objectEntries = asRecord(rawEntries);
    if (objectEntries) {
      entries = Object.values(objectEntries).map((e) => asRecord(e)).filter((e): e is Record<string, unknown> => Boolean(e));
    }
  }

  return entries.map((entry, index) => {
    const comment = normalizeWhitespace(
      asString(entry.comment) ?? asString(entry.title) ?? asString(entry.name) ?? `Entry ${index + 1}`,
    );
    const content = normalizeWhitespace(
      asString(entry.content) ?? asString(entry.text) ?? asString(entry.entry) ?? "",
    );
    const enabled = typeof entry.enabled === "boolean" ? entry.enabled
      : typeof entry.disable === "boolean" ? !entry.disable : true;
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

// ── Context Matching ──

export function extractTextFromMessages(messages: unknown[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const record = asRecord(msg);
    if (!record) continue;
    const content = record.content;
    if (typeof content === "string") { parts.push(content); continue; }
    if (Array.isArray(content)) {
      for (const block of content) {
        const br = asRecord(block);
        if (br && br.type === "text" && typeof br.text === "string") parts.push(br.text);
      }
    }
  }
  return parts.join("\n");
}

function entryMatchesContext(entry: NormalizedWorldbookEntry, contextLower: string): boolean {
  if (entry.keys.length === 0) return true;
  for (const key of entry.keys) {
    const keyLower = key.toLowerCase();
    if (keyLower && contextLower.includes(keyLower)) return true;
  }
  return false;
}

function worldbookEntryKey(entry: NormalizedWorldbookEntry): string {
  return `${entry.comment}::${entry.keys.join(",")}`;
}

export function selectWorldbookEntries(params: {
  allEntries: NormalizedWorldbookEntry[];
  contextText: string;
  sessionKey: string | null;
}): NormalizedWorldbookEntry[] {
  const { allEntries, contextText, sessionKey } = params;
  const contextLower = contextText.toLowerCase();
  const stickyMap = sessionKey
    ? (worldbookStickyState.get(sessionKey) ?? new Map<string, number>())
    : new Map<string, number>();

  const selected: NormalizedWorldbookEntry[] = [];
  const nextStickyMap = new Map<string, number>();

  for (const entry of allEntries) {
    if (!entry.enabled) continue;
    if (entry.constant) { selected.push(entry); continue; }

    const eKey = worldbookEntryKey(entry);
    const stickyRemaining = stickyMap.get(eKey) ?? 0;
    const matched = entryMatchesContext(entry, contextLower);

    if (matched) {
      selected.push(entry);
      if (entry.sticky > 0) nextStickyMap.set(eKey, entry.sticky);
    } else if (stickyRemaining > 0) {
      selected.push(entry);
      nextStickyMap.set(eKey, stickyRemaining - 1);
    }
  }

  if (sessionKey) {
    if (nextStickyMap.size > 0) worldbookStickyState.set(sessionKey, nextStickyMap);
    else worldbookStickyState.delete(sessionKey);
  }

  selected.sort((a, b) => {
    if (a.constant !== b.constant) return a.constant ? -1 : 1;
    return a.order - b.order;
  });
  return selected.slice(0, MAX_WORLD_ENTRIES);
}

// ── Section Building ──

export function buildWorldbookSection(
  filename: string,
  worldbook: Record<string, unknown>,
  options?: { contextText?: string; sessionKey?: string | null },
): string {
  const worldbookRoot = resolveWorldbookRoot(worldbook);
  const worldbookName = normalizeWhitespace(
    asString(worldbookRoot.name) ?? asString(worldbookRoot.title) ?? filename.replace(/\.json$/i, ""),
  );
  const allEntries = normalizeWorldbookEntries(worldbookRoot);
  const totalEnabled = allEntries.filter((e) => e.enabled).length;

  const contextText = options?.contextText;
  const selectedEntries = contextText
    ? selectWorldbookEntries({ allEntries, contextText, sessionKey: options?.sessionKey ?? null })
    : allEntries.filter((e) => e.enabled)
        .sort((a, b) => { if (a.constant !== b.constant) return a.constant ? -1 : 1; return a.order - b.order; })
        .slice(0, MAX_WORLD_ENTRIES);

  const lines: string[] = [
    "[Worldbook]", `filename: ${filename}`, `name: ${worldbookName}`,
    `total_enabled_entries: ${totalEnabled}`, `active_entries: ${selectedEntries.length}`,
  ];
  if (contextText && selectedEntries.length < totalEnabled) {
    lines.push(`note: ${totalEnabled - selectedEntries.length} entries filtered out (no keyword match in current context)`);
  }
  if (selectedEntries.length === 0) {
    lines.push("entries: none (no keywords matched current context)");
    return lines.join("\n");
  }

  lines.push("entries:");
  for (let i = 0; i < selectedEntries.length; i++) {
    const entry = selectedEntries[i];
    if (`${lines.join("\n")}\n`.length >= MAX_WORLD_SECTION_CHARS) { lines.push("- [truncated]"); break; }
    const flags: string[] = [];
    if (entry.constant) flags.push("constant");
    if (entry.sticky > 0) flags.push(`sticky=${entry.sticky}`);
    flags.push(`order=${entry.order}`);
    lines.push(`- ${i + 1}. ${entry.comment} (${flags.join(", ")})`);
    if (entry.keys.length > 0) lines.push(`  keys: ${truncate(entry.keys.join(", "), MAX_WORLD_ENTRY_CONTENT_CHARS)}`);
    if (entry.content) lines.push(`  content: ${truncate(entry.content, MAX_WORLD_ENTRY_CONTENT_CHARS)}`);
  }
  return truncate(lines.join("\n"), MAX_WORLD_SECTION_CHARS);
}

// ── CRUD ──

export async function listWorldbooksForApi(stateDir: string): Promise<
  Array<{ filename: string; name: string; entriesCount: number | null; updatedAt: string | null; sizeBytes: number | null }>
> {
  const worldbooksDir = path.join(stateDir, "worldbooks");
  const files = await listFilesByExtensions(worldbooksDir, [".json"]);
  const out: Array<{ filename: string; name: string; entriesCount: number | null; updatedAt: string | null; sizeBytes: number | null }> = [];
  for (const filename of files) {
    const fullPath = path.join(worldbooksDir, filename);
    let name = filename.replace(/\.json$/i, "");
    let entriesCount: number | null = null;
    let updatedAt: string | null = null;
    let sizeBytes: number | null = null;
    try {
      const [content, info] = await Promise.all([readFile(fullPath, "utf8"), fsStat(fullPath)]);
      const parsed = asRecord(JSON.parse(content) as unknown);
      if (parsed) {
        const fromName = asString(parsed.name);
        if (fromName) name = fromName;
        entriesCount = countWorldbookEntries(parsed);
      }
      updatedAt = Number.isFinite(info.mtimeMs) ? new Date(info.mtimeMs).toISOString() : null;
      sizeBytes = Number.isFinite(info.size) ? info.size : null;
    } catch { /* best-effort */ }
    out.push({ filename, name, entriesCount, updatedAt, sizeBytes });
  }
  return out;
}

export async function loadWorldbookContentPayload(params: {
  stateDir: string;
  filenameRaw: string;
}): Promise<Record<string, unknown>> {
  const filename = ensureWorldbookFilename(params.filenameRaw);
  const fullPath = path.join(params.stateDir, "worldbooks", filename);
  const content = await readFile(fullPath, "utf8");
  const parsed = asRecord(JSON.parse(content) as unknown);
  if (!parsed) throw new Error("Invalid worldbook JSON object");
  return { success: true, filename, worldbook: parsed };
}

export async function saveWorldbookContentPayload(params: {
  stateDir: string;
  filenameRaw: string;
  body: unknown;
}): Promise<void> {
  const filename = ensureWorldbookFilename(params.filenameRaw);
  const payload = asRecord(params.body);
  const worldbook = asRecord(payload?.worldbook);
  if (!worldbook) throw new Error("Missing worldbook payload");
  const worldbooksDir = path.join(params.stateDir, "worldbooks");
  await ensureDir(worldbooksDir);
  await writeFile(path.join(worldbooksDir, filename), JSON.stringify(worldbook, null, 2), "utf8");
}

export async function deleteWorldbookFile(params: {
  stateDir: string;
  filenameRaw: string;
}): Promise<void> {
  const filename = ensureWorldbookFilename(params.filenameRaw);
  const worldbooksDir = path.join(params.stateDir, "worldbooks");
  await ensureDir(worldbooksDir);
  await rm(path.join(worldbooksDir, filename));
}

export function formatWorldbookHelp(): string {
  return [
    "Worldbook commands:", "/worldbook list", "/worldbook show",
    "/worldbook set <filename>", "/worldbook clear",
  ].join("\n");
}
