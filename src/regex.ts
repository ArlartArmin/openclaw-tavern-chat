import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type RegexRule, asRecord, asString, ensureDir, normalizeRegexFlags } from "./utils.js";

export function parseRegexSpec(input: string): { pattern: string; flags: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Regex pattern is required");
  if (!trimmed.startsWith("/")) {
    const flags = normalizeRegexFlags("g");
    void new RegExp(trimmed, flags);
    return { pattern: trimmed, flags };
  }
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) throw new Error("Invalid regex literal");
  const pattern = trimmed.slice(1, lastSlash);
  const flags = normalizeRegexFlags(trimmed.slice(lastSlash + 1));
  void new RegExp(pattern, flags);
  return { pattern, flags };
}

export function normalizeRegexRule(value: unknown): RegexRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const pattern = typeof raw.pattern === "string" ? raw.pattern.trim() : "";
  if (!pattern) return null;
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

export function extractRegexRuleArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const raw = value as Record<string, unknown>;
  if (Array.isArray(raw.rules)) return raw.rules;
  if (Array.isArray(raw.regexRules)) return raw.regexRules;
  return [];
}

export async function loadRegexRules(filePath: string): Promise<RegexRule[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return extractRegexRuleArray(parsed)
      .map((e) => { try { return normalizeRegexRule(e); } catch { return null; } })
      .filter((e): e is RegexRule => e != null);
  } catch (err) {
    if (String(err).includes("ENOENT")) return [];
    throw err;
  }
}

export async function saveRegexRules(filePath: string, rules: RegexRule[]): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(rules, null, 2), "utf8");
}

export function resolveRuleIndex(rules: RegexRule[], idRaw: string): number {
  const id = idRaw.trim();
  if (!id) return -1;
  const asNumber = Number.parseInt(id, 10);
  if (Number.isFinite(asNumber) && String(asNumber) === id) {
    const idx = asNumber - 1;
    return idx >= 0 && idx < rules.length ? idx : -1;
  }
  return rules.findIndex((e) => e.name.trim().toLowerCase() === id.toLowerCase());
}

export function parseImportedRegexRules(value: unknown): RegexRule[] {
  const list = extractRegexRuleArray(value);
  if (list.length === 0) throw new Error("Regex upload JSON has no rules");
  const out: RegexRule[] = [];
  for (const [index, entry] of list.entries()) {
    const normalized = normalizeRegexRule(entry);
    if (!normalized) throw new Error(`Invalid regex rule at index ${index}`);
    out.push(normalized);
  }
  return out;
}

export function collectRegexMatches(pattern: string, flags: string, testText: string): string[] {
  const matchFlags = flags.includes("g") ? flags : `${flags}g`;
  const regex = new RegExp(pattern, matchFlags);
  const out: string[] = [];
  for (const match of testText.matchAll(regex)) {
    out.push(match[0] ?? "");
    if (out.length >= 200) break;
  }
  return out;
}

export function runRegexTest(payload: unknown): {
  success: true;
  matches: string[];
  result: string;
  changed: boolean;
} {
  const raw = asRecord(payload);
  const pattern = asString(raw?.pattern);
  if (!pattern) throw new Error("Regex pattern is required");
  const flags = normalizeRegexFlags(asString(raw?.flags) ?? "g");
  const replacement = typeof raw?.replacement === "string" ? raw.replacement : "";
  const testText = typeof raw?.testText === "string" ? raw.testText : "";
  const regex = new RegExp(pattern, flags);
  const result = testText.replace(regex, replacement);
  return { success: true, matches: collectRegexMatches(pattern, flags, testText), result, changed: result !== testText };
}

export function applyRegexRules(
  text: string,
  rules: RegexRule[],
  stage: "output" | "input",
): string {
  let result = text;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const ruleStage = rule.stage?.toLowerCase() ?? "output";
    if (ruleStage !== stage) continue;
    try {
      const regex = new RegExp(rule.pattern, rule.flags);
      result = result.replace(regex, rule.replacement);
    } catch { /* skip broken rules */ }
  }
  return result;
}

export function formatRegexHelp(): string {
  return [
    "Regex commands:", "/regex list",
    "/regex add <pattern|/pattern/flags> => <replacement>",
    "/regex remove <index|name>", "/regex clear — remove all rules",
    "/regex enable <index|name>", "/regex disable <index|name>",
  ].join("\n");
}
