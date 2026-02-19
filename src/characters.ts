import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import {
  type CharacterCardEntry, type CharacterMatchResult,
  asRecord, asString, ensureDir, fileExists, listFilesByExtensions,
  normalizeWhitespace, pickPromptString, pickPromptStringList, sanitizeFilename,
  truncate, MAX_CHARACTER_VALUE_CHARS, PNG_SIGNATURE,
} from "./utils.js";
import { resolveWorldbookRoot } from "./worldbooks.js";

export function pickCharacterName(value: Record<string, unknown>): string | null {
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
    return parsed ? pickCharacterName(parsed) : null;
  } catch { return null; }
}

function readPngCharacterTextChunk(chunk: Buffer, type: "tEXt" | "iTXt"): string | null {
  const keywordEnd = chunk.indexOf(0);
  if (keywordEnd <= 0) return null;
  const keyword = chunk.toString("latin1", 0, keywordEnd);
  if (keyword !== "chara") return null;

  if (type === "tEXt") return chunk.toString("utf8", keywordEnd + 1).trim() || null;

  let cursor = keywordEnd + 1;
  if (cursor + 1 >= chunk.length) return null;
  const compressionFlag = chunk[cursor] ?? 0;
  cursor += 2;
  const languageTagEnd = chunk.indexOf(0, cursor);
  if (languageTagEnd < 0) return null;
  cursor = languageTagEnd + 1;
  const translatedKeywordEnd = chunk.indexOf(0, cursor);
  if (translatedKeywordEnd < 0) return null;
  cursor = translatedKeywordEnd + 1;
  const textBytes = chunk.subarray(cursor);
  if (textBytes.length === 0) return null;
  if (compressionFlag === 1) {
    try { return inflateSync(textBytes).toString("utf8").trim() || null; }
    catch { return null; }
  }
  return textBytes.toString("utf8").trim() || null;
}

function iterPngChunks(bytes: Buffer, cb: (type: string, data: Buffer) => boolean | void): void {
  if (bytes.length < PNG_SIGNATURE.length) return;
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return;
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (crcEnd > bytes.length) break;
    if (cb(type, bytes.subarray(dataStart, dataEnd)) === true) return;
    offset = crcEnd;
  }
}

function decodePngCharaChunk(type: string, data: Buffer): Record<string, unknown> | null {
  if (type !== "tEXt" && type !== "iTXt") return null;
  const encoded = readPngCharacterTextChunk(data, type as "tEXt" | "iTXt");
  if (!encoded) return null;
  try {
    const jsonString = Buffer.from(encoded, "base64").toString("utf8");
    return asRecord(JSON.parse(jsonString) as unknown);
  } catch { return null; }
}

export function parseCharacterNameFromPng(bytes: Buffer): string | null {
  let name: string | null = null;
  iterPngChunks(bytes, (type, data) => {
    const parsed = decodePngCharaChunk(type, data);
    if (parsed) { name = pickCharacterName(parsed); return true; }
  });
  return name;
}

export function parseCharacterPayloadFromPng(bytes: Buffer): Record<string, unknown> | null {
  let result: Record<string, unknown> | null = null;
  iterPngChunks(bytes, (type, data) => {
    const parsed = decodePngCharaChunk(type, data);
    if (parsed) { result = parsed; return true; }
  });
  return result;
}

export async function loadCharacterCards(charactersDir: string): Promise<CharacterCardEntry[]> {
  const files = await listFilesByExtensions(charactersDir, [".json", ".png"]);
  const entries: CharacterCardEntry[] = [];
  for (const filename of files) {
    let name = path.parse(filename).name;
    const fullPath = path.join(charactersDir, filename);
    try {
      if (filename.toLowerCase().endsWith(".json")) {
        const parsedName = parseCharacterNameFromJson(await readFile(fullPath, "utf8"));
        if (parsedName) name = parsedName;
      } else if (filename.toLowerCase().endsWith(".png")) {
        const parsedName = parseCharacterNameFromPng(await readFile(fullPath));
        if (parsedName) name = parsedName;
      }
    } catch { /* keep filename fallback */ }
    entries.push({ filename, name });
  }
  return entries;
}

export function formatCharacterListItem(entry: CharacterCardEntry): string {
  const baseName = path.parse(entry.filename).name;
  if (entry.name.trim().toLowerCase() === baseName.trim().toLowerCase()) return entry.filename;
  return `${entry.name} (${entry.filename})`;
}

export function resolveCharacterMatch(inputRaw: string, entries: CharacterCardEntry[]): CharacterMatchResult {
  const input = sanitizeFilename(inputRaw);
  if (!input) return { status: "missing", input };
  const lowered = input.toLowerCase();

  const exact = entries.find((e) => e.filename.toLowerCase() === lowered);
  if (exact) return { status: "matched", filename: exact.filename };

  if (!path.extname(input)) {
    const baseMatches = entries.filter((e) => path.parse(e.filename).name.toLowerCase() === lowered);
    if (baseMatches.length === 1) return { status: "matched", filename: baseMatches[0].filename };
    if (baseMatches.length > 1) return { status: "ambiguous", input, matches: baseMatches };
  }

  const nameMatches = entries.filter((e) => e.name.trim().toLowerCase() === lowered);
  if (nameMatches.length === 1) return { status: "matched", filename: nameMatches[0].filename };
  if (nameMatches.length > 1) return { status: "ambiguous", input, matches: nameMatches };
  return { status: "missing", input };
}

export function formatAmbiguousCharacterMatch(input: string, matches: CharacterCardEntry[]): string {
  const options = matches.map((e) => `${e.name} (${e.filename})`).join(", ");
  return `Character is ambiguous for "${input}". Use filename: ${options}`;
}

function isSupportedCharacterFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ext === ".png" || ext === ".json";
}

function ensureCharacterFilename(filenameRaw: string): string {
  const filename = sanitizeFilename(filenameRaw);
  if (!filename || filename !== filenameRaw || !isSupportedCharacterFile(filename)) throw new Error("Invalid filename");
  return filename;
}

export async function loadCharacterDetailPayload(params: {
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
    return { success: true, filename, character: parsed ?? { raw: content } };
  }

  const parsed = parseCharacterPayloadFromPng(await readFile(fullPath));
  return {
    success: true, filename,
    character: parsed ?? { name: path.parse(filename).name, filename, note: "No embedded character metadata found in PNG." },
  };
}

export async function listCharacterEntriesForApi(stateDir: string): Promise<Array<{ name: string; filename: string }>> {
  const charactersDir = path.join(stateDir, "characters");
  const cards = await loadCharacterCards(charactersDir);
  return cards.map((e) => ({ name: e.name, filename: e.filename }));
}

export function replaceTavernPlaceholders(text: string, charName: string, userName: string): string {
  return text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{<char>\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{<user>\}\}/gi, userName);
}

export function buildCharacterCardSection(filename: string, character: Record<string, unknown>, userName?: string): string {
  const lines: string[] = [];
  const append = (label: string, value: string | null) => {
    if (value) lines.push(`${label}: ${truncate(normalizeWhitespace(value), MAX_CHARACTER_VALUE_CHARS)}`);
  };

  const systemPrompt = pickPromptString(character, [
    ["system_prompt"], ["data", "system_prompt"], ["character", "system_prompt"], ["card", "system_prompt"],
  ]);
  if (systemPrompt) {
    lines.push(`[Character System Prompt]\n${truncate(normalizeWhitespace(systemPrompt), MAX_CHARACTER_VALUE_CHARS)}`);
    lines.push("");
  }

  lines.push(`[Character Card]`);
  lines.push(`filename: ${filename}`);
  append("name", pickPromptString(character, [["name"], ["data", "name"], ["character", "name"], ["card", "name"], ["char_name"]]));
  append("creator", pickPromptString(character, [["creator"], ["author"], ["data", "creator"], ["character", "creator"]]));
  append("description", pickPromptString(character, [["description"], ["desc"], ["data", "description"], ["character", "description"], ["card", "description"]]));
  append("personality", pickPromptString(character, [["personality"], ["data", "personality"], ["character", "personality"], ["card", "personality"]]));
  append("scenario", pickPromptString(character, [["scenario"], ["data", "scenario"], ["character", "scenario"], ["card", "scenario"]]));
  append("first_message", pickPromptString(character, [["first_mes"], ["firstMessage"], ["greeting"], ["data", "first_mes"], ["character", "first_mes"], ["card", "first_mes"]]));
  append("example_dialogue", pickPromptString(character, [["mes_example"], ["example_dialogue"], ["data", "mes_example"], ["character", "mes_example"], ["card", "mes_example"]]));
  const tags = pickPromptStringList(character, [["tags"], ["data", "tags"], ["character", "tags"], ["card", "tags"]]);
  if (tags.length > 0) lines.push(`tags: ${truncate(tags.join(", "), MAX_CHARACTER_VALUE_CHARS)}`);

  const charName = pickPromptString(character, [["name"], ["data", "name"], ["character", "name"], ["card", "name"], ["char_name"]]) ?? path.parse(filename).name;
  return replaceTavernPlaceholders(lines.join("\n"), charName, userName || "用户");
}

export function extractCharacterBook(character: Record<string, unknown>): Record<string, unknown> | null {
  const paths = [["character_book"], ["data", "character_book"], ["character", "character_book"], ["card", "character_book"]];
  for (const pathSegments of paths) {
    let cursor: unknown = character;
    for (const key of pathSegments) {
      const obj = asRecord(cursor);
      if (!obj) { cursor = null; break; }
      cursor = obj[key];
    }
    const result = asRecord(cursor);
    if (result) {
      const root = resolveWorldbookRoot(result);
      const entries = root.entries;
      if (Array.isArray(entries) || Boolean(asRecord(entries))) return result;
    }
  }
  return null;
}

export function isCharacterCreateAction(action: string): boolean {
  return new Set(["create", "new", "write", "generate", "make", "\u521b\u5efa", "\u65b0\u5efa", "\u65b0\u589e", "\u751f\u6210", "\u5199", "\u81ea\u521b"]).has(action.trim().toLowerCase());
}

export function formatCharacterHelp(): string {
  return ["Character commands:", "/character list", "/character show", "/character set <filename|name>", "/character clear"].join("\n");
}
