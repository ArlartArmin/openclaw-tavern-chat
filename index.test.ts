import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import register from "./index.js";

type RegisteredCommand = {
  name: string;
  acceptsArgs?: boolean;
  description: string;
  handler: (ctx: {
    args?: string;
    commandBody?: string;
    sessionEntry?: { characterCardFilename?: string; worldbookFilename?: string };
    updateSessionEntry?: (patch: Record<string, unknown>) => Promise<unknown>;
  }) => Promise<{ text?: string }>;
};

type BeforeAgentStartHook = (
  event: { prompt: string; messages?: unknown[] },
  ctx: {
    sessionKey?: string;
    agentId?: string;
  },
) => Promise<{ prependContext?: string } | void>;

type PluginHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type MessageSendingHook = (
  event: { to: string; content: string; metadata?: Record<string, unknown> },
  ctx: { channelId: string; accountId?: string; conversationId?: string },
) => Promise<{ content?: string; cancel?: boolean } | void> | { content?: string; cancel?: boolean } | void;

type BeforeResetHook = (
  event: unknown,
  ctx: { sessionKey?: string },
) => Promise<void> | void;

const tempDirs: string[] = [];

function makeApi(stateDir: string) {
  const commands = new Map<string, RegisteredCommand>();
  const hooks = new Map<string, BeforeAgentStartHook>();
  const sendingHooks: MessageSendingHook[] = [];
  const resetHooks: BeforeResetHook[] = [];
  const httpHandlers: PluginHttpHandler[] = [];
  const sessionsStorePath = path.join(stateDir, "sessions.json");
  const api = {
    config: {},
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
      channel: {
        session: {
          resolveStorePath: () => sessionsStorePath,
        },
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      debug: () => {},
    },
    registerCommand: (command: RegisteredCommand) => {
      commands.set(command.name, command);
    },
    registerHttpHandler: (handler: PluginHttpHandler) => {
      httpHandlers.push(handler);
    },
    on: (hookName: string, handler: unknown) => {
      if (hookName === "before_agent_start") {
        hooks.set(hookName, handler as BeforeAgentStartHook);
      }
      if (hookName === "message_sending") {
        sendingHooks.push(handler as MessageSendingHook);
      }
      if (hookName === "before_reset") {
        resetHooks.push(handler as BeforeResetHook);
      }
    },
  } as unknown as OpenClawPluginApi;

  register(api);
  return { commands, hooks, sendingHooks, resetHooks, httpHandlers, sessionsStorePath };
}

function createResponseRecorder() {
  let body = "";
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: number | string | readonly string[]) {
      headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
      return res;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") {
        body += chunk;
      } else if (Buffer.isBuffer(chunk)) {
        body += chunk.toString("utf8");
      }
      return res;
    },
  } as unknown as ServerResponse;
  return {
    res,
    getStatus: () => (res as unknown as { statusCode?: number }).statusCode ?? 0,
    getHeader: (name: string) => headers.get(name.toLowerCase()) ?? null,
    getBody: () => body,
  };
}

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-tavern-chat-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("tavern-chat plugin", () => {
  it("registers character/worldbook/regex commands", async () => {
    const stateDir = await makeStateDir();
    const { commands, httpHandlers } = makeApi(stateDir);
    expect(commands.has("character")).toBe(true);
    expect(commands.has("worldbook")).toBe(true);
    expect(commands.has("regex")).toBe(true);
    expect(httpHandlers.length).toBeGreaterThan(0);
  });

  it("serves character list via plugin HTTP API", async () => {
    const stateDir = await makeStateDir();
    const charactersDir = path.join(stateDir, "characters");
    await mkdir(charactersDir, { recursive: true });
    await writeFile(path.join(charactersDir, "hero.json"), '{"name":"Hero"}', "utf8");
    const { httpHandlers } = makeApi(stateDir);
    const handler = httpHandlers[0];
    expect(handler).toBeTruthy();

    const req = {
      url: "/api/channels/tavern-chat/characters",
      method: "GET",
      headers: {},
    } as IncomingMessage;
    const recorder = createResponseRecorder();
    const handled = await handler!(req, recorder.res);

    expect(handled).toBe(true);
    expect(recorder.getStatus()).toBe(200);
    expect(recorder.getHeader("content-type")).toContain("application/json");
    const payload = JSON.parse(recorder.getBody()) as Array<{ filename?: string }>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload[0]?.filename).toBe("hero.json");
  });

  it("sets character card for current session", async () => {
    const stateDir = await makeStateDir();
    const charactersDir = path.join(stateDir, "characters");
    await mkdir(charactersDir, { recursive: true });
    await writeFile(path.join(charactersDir, "hero.json"), '{"name":"Hero"}', "utf8");

    const { commands } = makeApi(stateDir);
    const character = commands.get("character");
    expect(character).toBeTruthy();

    const patches: Array<Record<string, unknown>> = [];
    const result = await character!.handler({
      args: "set hero.json",
      sessionEntry: {},
      updateSessionEntry: async (patch) => {
        patches.push(patch);
        return { sessionId: "s1", updatedAt: Date.now(), ...patch };
      },
    });

    expect(result.text).toContain("Character set to hero.json");
    expect(patches[0]?.characterCardFilename).toBe("hero.json");
  });

  it("sets character card by character name", async () => {
    const stateDir = await makeStateDir();
    const charactersDir = path.join(stateDir, "characters");
    await mkdir(charactersDir, { recursive: true });
    await writeFile(
      path.join(charactersDir, "decision-card.json"),
      '{"name":"\\u6289\\u62e9"}',
      "utf8",
    );

    const { commands } = makeApi(stateDir);
    const character = commands.get("character");
    expect(character).toBeTruthy();

    const patches: Array<Record<string, unknown>> = [];
    const result = await character!.handler({
      args: "set \u6289\u62e9",
      sessionEntry: {},
      updateSessionEntry: async (patch) => {
        patches.push(patch);
        return { sessionId: "s1", updatedAt: Date.now(), ...patch };
      },
    });

    expect(result.text).toContain("Character set to decision-card.json");
    expect(patches[0]?.characterCardFilename).toBe("decision-card.json");
  });

  it("rejects character self-creation actions", async () => {
    const stateDir = await makeStateDir();
    const { commands } = makeApi(stateDir);
    const character = commands.get("character");
    expect(character).toBeTruthy();

    const result = await character!.handler({ args: "create \u5c0f\u6696" });
    expect(result.text).toContain("Character creation is disabled");
  });

  it("shows import-only guidance when no character cards exist", async () => {
    const stateDir = await makeStateDir();
    const { commands } = makeApi(stateDir);
    const character = commands.get("character");
    expect(character).toBeTruthy();

    const result = await character!.handler({ args: "" });
    expect(result.text).toContain("No character cards found");
    expect(result.text).toContain("Character creation is disabled");
  });

  it("lists character cards when no action is provided", async () => {
    const stateDir = await makeStateDir();
    const charactersDir = path.join(stateDir, "characters");
    await mkdir(charactersDir, { recursive: true });
    await writeFile(path.join(charactersDir, "hero.json"), '{"name":"Hero"}', "utf8");

    const { commands } = makeApi(stateDir);
    const character = commands.get("character");
    expect(character).toBeTruthy();

    const result = await character!.handler({
      args: "",
      sessionEntry: { characterCardFilename: "hero.json" },
    });
    expect(result.text).toContain("Character cards (1):");
    expect(result.text).toContain("* hero.json");
  });

  it("clears current session character via chinese trigger without deleting card files", async () => {
    const stateDir = await makeStateDir();
    const charactersDir = path.join(stateDir, "characters");
    await mkdir(charactersDir, { recursive: true });
    const cardPath = path.join(charactersDir, "hero.json");
    await writeFile(cardPath, '{"name":"Hero"}', "utf8");

    const { commands } = makeApi(stateDir);
    const character = commands.get("character");
    expect(character).toBeTruthy();

    const patches: Array<Record<string, unknown>> = [];
    const result = await character!.handler({
      commandBody: "清空角色卡",
      sessionEntry: { characterCardFilename: "hero.json" },
      updateSessionEntry: async (patch) => {
        patches.push(patch);
        return { sessionId: "s1", updatedAt: Date.now(), ...patch };
      },
    });

    expect(result.text).toContain("Character cleared for this session");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.characterCardFilename).toBeUndefined();
    await expect(readFile(cardPath, "utf8")).resolves.toContain("Hero");
  });

  it("supports implicit worldbook set without explicit action", async () => {
    const stateDir = await makeStateDir();
    const worldbooksDir = path.join(stateDir, "worldbooks");
    await mkdir(worldbooksDir, { recursive: true });
    await writeFile(path.join(worldbooksDir, "lore.json"), '{"name":"Lore"}', "utf8");

    const { commands } = makeApi(stateDir);
    const worldbook = commands.get("worldbook");
    expect(worldbook).toBeTruthy();

    const patches: Array<Record<string, unknown>> = [];
    const result = await worldbook!.handler({
      args: "lore",
      sessionEntry: {},
      updateSessionEntry: async (patch) => {
        patches.push(patch);
        return { sessionId: "s2", updatedAt: Date.now(), ...patch };
      },
    });
    expect(result.text).toContain("Worldbook set to lore.json");
    expect(patches[0]?.worldbookFilename).toBe("lore.json");
  });

  it("clears current session worldbook via chinese trigger without deleting files", async () => {
    const stateDir = await makeStateDir();
    const worldbooksDir = path.join(stateDir, "worldbooks");
    await mkdir(worldbooksDir, { recursive: true });
    const worldbookPath = path.join(worldbooksDir, "lore.json");
    await writeFile(worldbookPath, '{"name":"Lore"}', "utf8");

    const { commands } = makeApi(stateDir);
    const worldbook = commands.get("worldbook");
    expect(worldbook).toBeTruthy();

    const patches: Array<Record<string, unknown>> = [];
    const result = await worldbook!.handler({
      commandBody: "清空世界书",
      sessionEntry: { worldbookFilename: "lore.json" },
      updateSessionEntry: async (patch) => {
        patches.push(patch);
        return { sessionId: "s2", updatedAt: Date.now(), ...patch };
      },
    });

    expect(result.text).toContain("Worldbook cleared for this session");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.worldbookFilename).toBeUndefined();
    await expect(readFile(worldbookPath, "utf8")).resolves.toContain("Lore");
  });

  it("injects persona-priority context when session has selected character card", async () => {
    const stateDir = await makeStateDir();
    const { hooks, sessionsStorePath } = makeApi(stateDir);
    const hook = hooks.get("before_agent_start");
    expect(hook).toBeTruthy();
    const charactersDir = path.join(stateDir, "characters");
    await mkdir(charactersDir, { recursive: true });
    await writeFile(path.join(charactersDir, "decision-card.json"), '{"name":"Decision"}', "utf8");

    await writeFile(
      sessionsStorePath,
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "s1",
            updatedAt: Date.now(),
            characterCardFilename: "decision-card.json",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await hook!(
      { prompt: "hello" },
      { sessionKey: "agent:main:main", agentId: "main" },
    );
    expect(result?.prependContext).toContain("sole persona");
    expect(result?.prependContext).toContain("decision-card.json");
    expect(result?.prependContext).toContain("[Character Card]");
  });

  it("adds regex rule to regex-rules.json", async () => {
    const stateDir = await makeStateDir();
    const { commands } = makeApi(stateDir);
    const regex = commands.get("regex");
    expect(regex).toBeTruthy();

    const add = await regex!.handler({ args: "add /foo/g => bar" });
    expect(add.text).toContain("Regex rule added");

    const rulesPath = path.join(stateDir, "regex-rules.json");
    const saved = JSON.parse(await readFile(rulesPath, "utf8")) as Array<{ pattern?: string }>;
    expect(saved).toHaveLength(1);
    expect(saved[0]?.pattern).toBe("foo");
  });

  it("worldbook keyword matching: only injects entries whose keys match context", async () => {
    const stateDir = await makeStateDir();
    const worldbooksDir = path.join(stateDir, "worldbooks");
    await mkdir(worldbooksDir, { recursive: true });
    await writeFile(
      path.join(worldbooksDir, "lore.json"),
      JSON.stringify({
        name: "Test Lore",
        entries: {
          "0": { comment: "Magic System", keys: ["magic", "spell"], content: "Magic is everywhere", enabled: true, constant: false, order: 0, sticky: 0 },
          "1": { comment: "Kingdom History", keys: ["kingdom", "history"], content: "The kingdom was founded long ago", enabled: true, constant: false, order: 1, sticky: 0 },
          "2": { comment: "World Rules", keys: [], content: "Always active (no keys)", enabled: true, constant: true, order: -1, sticky: 0 },
        },
      }),
      "utf8",
    );

    const { hooks, sessionsStorePath } = makeApi(stateDir);
    const hook = hooks.get("before_agent_start");
    expect(hook).toBeTruthy();

    await writeFile(
      sessionsStorePath,
      JSON.stringify({
        "agent:main:main": {
          sessionId: "s1",
          updatedAt: Date.now(),
          worldbookFilename: "lore.json",
        },
      }),
      "utf8",
    );

    // User mentions "magic" — should get World Rules (constant) + Magic System, but NOT Kingdom History
    const result = await hook!(
      { prompt: "Tell me about magic", messages: [] },
      { sessionKey: "agent:main:main", agentId: "main" },
    );
    expect(result?.prependContext).toContain("World Rules");
    expect(result?.prependContext).toContain("Magic System");
    expect(result?.prependContext).toContain("Magic is everywhere");
    expect(result?.prependContext).not.toContain("Kingdom History");
    expect(result?.prependContext).not.toContain("kingdom was founded");
  });

  it("worldbook keyword matching: constant entries always injected", async () => {
    const stateDir = await makeStateDir();
    const worldbooksDir = path.join(stateDir, "worldbooks");
    await mkdir(worldbooksDir, { recursive: true });
    await writeFile(
      path.join(worldbooksDir, "lore.json"),
      JSON.stringify({
        name: "Test Lore",
        entries: {
          "0": { comment: "Always On", keys: ["never-match-this-xyz"], content: "I am constant", enabled: true, constant: true, order: 0, sticky: 0 },
          "1": { comment: "Conditional", keys: ["rare-keyword"], content: "I am conditional", enabled: true, constant: false, order: 1, sticky: 0 },
        },
      }),
      "utf8",
    );

    const { hooks, sessionsStorePath } = makeApi(stateDir);
    const hook = hooks.get("before_agent_start");
    expect(hook).toBeTruthy();

    await writeFile(
      sessionsStorePath,
      JSON.stringify({
        "agent:main:main": {
          sessionId: "s1",
          updatedAt: Date.now(),
          worldbookFilename: "lore.json",
        },
      }),
      "utf8",
    );

    // Prompt has no matching keywords — only constant entry should appear
    const result = await hook!(
      { prompt: "Hello there", messages: [] },
      { sessionKey: "agent:main:main", agentId: "main" },
    );
    expect(result?.prependContext).toContain("Always On");
    expect(result?.prependContext).toContain("I am constant");
    expect(result?.prependContext).not.toContain("Conditional");
    expect(result?.prependContext).not.toContain("I am conditional");
  });

  it("worldbook keyword matching: matches keywords in conversation history", async () => {
    const stateDir = await makeStateDir();
    const worldbooksDir = path.join(stateDir, "worldbooks");
    await mkdir(worldbooksDir, { recursive: true });
    await writeFile(
      path.join(worldbooksDir, "lore.json"),
      JSON.stringify({
        name: "Test Lore",
        entries: {
          "0": { comment: "Dragon Lore", keys: ["dragon"], content: "Dragons are ancient", enabled: true, constant: false, order: 0, sticky: 0 },
        },
      }),
      "utf8",
    );

    const { hooks, sessionsStorePath } = makeApi(stateDir);
    const hook = hooks.get("before_agent_start");
    expect(hook).toBeTruthy();

    await writeFile(
      sessionsStorePath,
      JSON.stringify({
        "agent:main:hist": {
          sessionId: "s2",
          updatedAt: Date.now(),
          worldbookFilename: "lore.json",
        },
      }),
      "utf8",
    );

    // "dragon" is in history, not in current prompt
    const result = await hook!(
      {
        prompt: "Tell me more about that creature",
        messages: [
          { role: "user", content: "I saw a dragon yesterday" },
          { role: "assistant", content: "That sounds exciting!" },
        ],
      },
      { sessionKey: "agent:main:hist", agentId: "main" },
    );
    expect(result?.prependContext).toContain("Dragon Lore");
    expect(result?.prependContext).toContain("Dragons are ancient");
  });

  it("worldbook sticky: entry persists for N turns after keyword match disappears", async () => {
    const stateDir = await makeStateDir();
    const worldbooksDir = path.join(stateDir, "worldbooks");
    await mkdir(worldbooksDir, { recursive: true });
    await writeFile(
      path.join(worldbooksDir, "lore.json"),
      JSON.stringify({
        name: "Test Lore",
        entries: {
          "0": { comment: "Sticky Entry", keys: ["trigger"], content: "I am sticky", enabled: true, constant: false, order: 0, sticky: 2 },
        },
      }),
      "utf8",
    );

    const { hooks, sessionsStorePath } = makeApi(stateDir);
    const hook = hooks.get("before_agent_start");
    expect(hook).toBeTruthy();

    await writeFile(
      sessionsStorePath,
      JSON.stringify({
        "agent:main:sticky": {
          sessionId: "s3",
          updatedAt: Date.now(),
          worldbookFilename: "lore.json",
        },
      }),
      "utf8",
    );

    const sessionCtx = { sessionKey: "agent:main:sticky", agentId: "main" };

    // Turn 1: keyword matches — entry should appear
    const r1 = await hook!(
      { prompt: "trigger something", messages: [] },
      sessionCtx,
    );
    expect(r1?.prependContext).toContain("Sticky Entry");

    // Turn 2: no keyword — sticky=2, so still 2 turns remaining
    const r2 = await hook!(
      { prompt: "unrelated message", messages: [] },
      sessionCtx,
    );
    expect(r2?.prependContext).toContain("Sticky Entry");

    // Turn 3: no keyword — sticky decremented to 1, still present
    const r3 = await hook!(
      { prompt: "another unrelated message", messages: [] },
      sessionCtx,
    );
    expect(r3?.prependContext).toContain("Sticky Entry");

    // Turn 4: no keyword — sticky expired, entry should be gone
    const r4 = await hook!(
      { prompt: "yet another message", messages: [] },
      sessionCtx,
    );
    // With only the sticky entry gone and no constant entries, worldbook section
    // should show "no keywords matched" or not contain the entry
    const hasSticky = r4?.prependContext?.includes("Sticky Entry") ?? false;
    expect(hasSticky).toBe(false);
  });

  it("worldbook sticky state is cleared on session reset", async () => {
    const stateDir = await makeStateDir();
    const worldbooksDir = path.join(stateDir, "worldbooks");
    await mkdir(worldbooksDir, { recursive: true });
    await writeFile(
      path.join(worldbooksDir, "lore.json"),
      JSON.stringify({
        name: "Test Lore",
        entries: {
          "0": { comment: "Sticky Entry", keys: ["trigger"], content: "I am sticky", enabled: true, constant: false, order: 0, sticky: 5 },
        },
      }),
      "utf8",
    );

    const { hooks, resetHooks, sessionsStorePath } = makeApi(stateDir);
    const hook = hooks.get("before_agent_start");
    expect(hook).toBeTruthy();
    expect(resetHooks.length).toBeGreaterThan(0);

    await writeFile(
      sessionsStorePath,
      JSON.stringify({
        "agent:main:reset": {
          sessionId: "s4",
          updatedAt: Date.now(),
          worldbookFilename: "lore.json",
        },
      }),
      "utf8",
    );

    const sessionCtx = { sessionKey: "agent:main:reset", agentId: "main" };

    // Trigger sticky
    await hook!({ prompt: "trigger something", messages: [] }, sessionCtx);

    // Verify sticky is active
    const r1 = await hook!({ prompt: "unrelated", messages: [] }, sessionCtx);
    expect(r1?.prependContext).toContain("Sticky Entry");

    // Reset session
    for (const resetHook of resetHooks) {
      await resetHook({}, { sessionKey: "agent:main:reset" });
    }

    // After reset, sticky should be cleared — entry should not appear without keyword
    const r2 = await hook!({ prompt: "unrelated", messages: [] }, sessionCtx);
    const hasSticky = r2?.prependContext?.includes("Sticky Entry") ?? false;
    expect(hasSticky).toBe(false);
  });

  it("injects system_prompt from character card V2 spec", async () => {
    const stateDir = await makeStateDir();
    const { hooks, sessionsStorePath } = makeApi(stateDir);
    const hook = hooks.get("before_agent_start");
    expect(hook).toBeTruthy();
    const charactersDir = path.join(stateDir, "characters");
    await mkdir(charactersDir, { recursive: true });
    await writeFile(
      path.join(charactersDir, "v2card.json"),
      JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: "TestBot",
          description: "A test character",
          system_prompt: "You must always respond in rhyming couplets.",
          personality: "Cheerful",
          scenario: "",
          first_mes: "Hello!",
          mes_example: "",
        },
      }),
      "utf8",
    );

    await writeFile(
      sessionsStorePath,
      JSON.stringify({
        "agent:main:v2": {
          sessionId: "sv2",
          updatedAt: Date.now(),
          characterCardFilename: "v2card.json",
        },
      }),
      "utf8",
    );

    const result = await hook!(
      { prompt: "hi", messages: [] },
      { sessionKey: "agent:main:v2", agentId: "main" },
    );
    expect(result?.prependContext).toContain("[Character System Prompt]");
    expect(result?.prependContext).toContain("rhyming couplets");
    expect(result?.prependContext).toContain("[Character Card]");
    expect(result?.prependContext).toContain("TestBot");
    // system_prompt should appear before the character card section
    const sysIdx = result!.prependContext!.indexOf("[Character System Prompt]");
    const cardIdx = result!.prependContext!.indexOf("[Character Card]");
    expect(sysIdx).toBeLessThan(cardIdx);
  });

  it("extracts and injects embedded character_book from character card", async () => {
    const stateDir = await makeStateDir();
    const { hooks, sessionsStorePath } = makeApi(stateDir);
    const hook = hooks.get("before_agent_start");
    expect(hook).toBeTruthy();
    const charactersDir = path.join(stateDir, "characters");
    await mkdir(charactersDir, { recursive: true });
    await writeFile(
      path.join(charactersDir, "with-book.json"),
      JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: "Lorekeeper",
          description: "A keeper of ancient lore",
          system_prompt: "",
          personality: "",
          scenario: "",
          first_mes: "Greetings, traveler.",
          mes_example: "",
          character_book: {
            name: "Ancient Lore",
            entries: {
              "0": {
                comment: "Dragon History",
                keys: ["dragon", "wyrm"],
                content: "Dragons ruled the skies for millennia",
                enabled: true,
                constant: false,
                order: 0,
                sticky: 0,
              },
              "1": {
                comment: "Magic Origins",
                keys: ["magic", "arcane"],
                content: "Magic flows from the World Tree",
                enabled: true,
                constant: false,
                order: 1,
                sticky: 0,
              },
              "2": {
                comment: "World Constants",
                keys: [],
                content: "The world has two moons",
                enabled: true,
                constant: true,
                order: -1,
                sticky: 0,
              },
            },
          },
        },
      }),
      "utf8",
    );

    await writeFile(
      sessionsStorePath,
      JSON.stringify({
        "agent:main:book": {
          sessionId: "sbook",
          updatedAt: Date.now(),
          characterCardFilename: "with-book.json",
        },
      }),
      "utf8",
    );

    // Mention "dragon" — should get World Constants (constant) + Dragon History, but NOT Magic Origins
    const result = await hook!(
      { prompt: "Tell me about the dragon", messages: [] },
      { sessionKey: "agent:main:book", agentId: "main" },
    );
    expect(result?.prependContext).toContain("Lorekeeper");
    expect(result?.prependContext).toContain("World Constants");
    expect(result?.prependContext).toContain("two moons");
    expect(result?.prependContext).toContain("Dragon History");
    expect(result?.prependContext).toContain("Dragons ruled");
    expect(result?.prependContext).not.toContain("Magic Origins");
    expect(result?.prependContext).not.toContain("World Tree");
  });

  it("character_book and global worldbook coexist with independent keyword matching", async () => {
    const stateDir = await makeStateDir();
    const { hooks, sessionsStorePath } = makeApi(stateDir);
    const hook = hooks.get("before_agent_start");
    expect(hook).toBeTruthy();

    const charactersDir = path.join(stateDir, "characters");
    await mkdir(charactersDir, { recursive: true });
    await writeFile(
      path.join(charactersDir, "char-with-book.json"),
      JSON.stringify({
        data: {
          name: "Wizard",
          description: "A wise wizard",
          character_book: {
            entries: {
              "0": {
                comment: "Wizard Staff",
                keys: ["staff"],
                content: "The staff glows blue",
                enabled: true,
                constant: false,
                order: 0,
                sticky: 0,
              },
            },
          },
        },
      }),
      "utf8",
    );

    const worldbooksDir = path.join(stateDir, "worldbooks");
    await mkdir(worldbooksDir, { recursive: true });
    await writeFile(
      path.join(worldbooksDir, "global.json"),
      JSON.stringify({
        name: "Global Lore",
        entries: {
          "0": {
            comment: "Kingdom Info",
            keys: ["kingdom"],
            content: "The kingdom spans three continents",
            enabled: true,
            constant: false,
            order: 0,
            sticky: 0,
          },
        },
      }),
      "utf8",
    );

    await writeFile(
      sessionsStorePath,
      JSON.stringify({
        "agent:main:both": {
          sessionId: "sboth",
          updatedAt: Date.now(),
          characterCardFilename: "char-with-book.json",
          worldbookFilename: "global.json",
        },
      }),
      "utf8",
    );

    // Mention "staff" — should get character_book entry but NOT global worldbook entry
    const r1 = await hook!(
      { prompt: "Show me the staff", messages: [] },
      { sessionKey: "agent:main:both", agentId: "main" },
    );
    expect(r1?.prependContext).toContain("Wizard Staff");
    expect(r1?.prependContext).toContain("staff glows blue");
    expect(r1?.prependContext).not.toContain("Kingdom Info");

    // Mention "kingdom" — should get global worldbook entry but NOT character_book entry
    const r2 = await hook!(
      { prompt: "Tell me about the kingdom", messages: [] },
      { sessionKey: "agent:main:both", agentId: "main" },
    );
    expect(r2?.prependContext).toContain("Kingdom Info");
    expect(r2?.prependContext).toContain("three continents");
    expect(r2?.prependContext).not.toContain("Wizard Staff");
  });

  it("character card with longer description is not truncated at 900 chars", async () => {
    const stateDir = await makeStateDir();
    const { hooks, sessionsStorePath } = makeApi(stateDir);
    const hook = hooks.get("before_agent_start");
    expect(hook).toBeTruthy();
    const charactersDir = path.join(stateDir, "characters");
    await mkdir(charactersDir, { recursive: true });

    const longDesc = "A".repeat(2000);
    await writeFile(
      path.join(charactersDir, "long.json"),
      JSON.stringify({ name: "LongChar", description: longDesc }),
      "utf8",
    );

    await writeFile(
      sessionsStorePath,
      JSON.stringify({
        "agent:main:long": {
          sessionId: "slong",
          updatedAt: Date.now(),
          characterCardFilename: "long.json",
        },
      }),
      "utf8",
    );

    const result = await hook!(
      { prompt: "hi", messages: [] },
      { sessionKey: "agent:main:long", agentId: "main" },
    );
    // With the old 900 limit, description would be truncated.
    // With the new 3000 limit, 2000 chars should fit fully.
    const descLine = result?.prependContext
      ?.split("\n")
      .find((l) => l.startsWith("description:"));
    expect(descLine).toBeTruthy();
    // The full 2000 A's should be present (not truncated)
    expect(descLine!.includes("A".repeat(2000))).toBe(true);
  });

  it("regex output rules are applied to AI replies via message_sending", async () => {
    const stateDir = await makeStateDir();
    const { sendingHooks } = makeApi(stateDir);
    expect(sendingHooks.length).toBeGreaterThan(0);

    // Create regex rules
    const rulesPath = path.join(stateDir, "regex-rules.json");
    await writeFile(
      rulesPath,
      JSON.stringify([
        { name: "censor", pattern: "badword", flags: "gi", replacement: "[censored]", enabled: true, description: "", stage: "output" },
        { name: "format", pattern: "\\*\\*(.+?)\\*\\*", flags: "g", replacement: "[$1]", enabled: true, description: "", stage: "output" },
      ]),
      "utf8",
    );

    const event = {
      to: "user:123",
      content: "This has a BadWord and **bold text** in it.",
    };
    const ctx = { channelId: "test" };

    let result: { content?: string } | void;
    for (const hook of sendingHooks) {
      result = await hook(event, ctx);
    }

    expect(result).toBeTruthy();
    expect(result!.content).toBe("This has a [censored] and [bold text] in it.");
  });

  it("regex rules without stage default to output", async () => {
    const stateDir = await makeStateDir();
    const { sendingHooks } = makeApi(stateDir);

    const rulesPath = path.join(stateDir, "regex-rules.json");
    await writeFile(
      rulesPath,
      JSON.stringify([
        { name: "no-stage", pattern: "hello", flags: "gi", replacement: "hi", enabled: true, description: "" },
      ]),
      "utf8",
    );

    const event = { to: "user:1", content: "Hello world" };
    let result: { content?: string } | void;
    for (const hook of sendingHooks) {
      result = await hook(event, { channelId: "test" });
    }
    expect(result).toBeTruthy();
    expect(result!.content).toBe("hi world");
  });

  it("disabled regex rules are skipped", async () => {
    const stateDir = await makeStateDir();
    const { sendingHooks } = makeApi(stateDir);

    const rulesPath = path.join(stateDir, "regex-rules.json");
    await writeFile(
      rulesPath,
      JSON.stringify([
        { name: "disabled", pattern: "foo", flags: "g", replacement: "bar", enabled: false, description: "", stage: "output" },
      ]),
      "utf8",
    );

    const event = { to: "user:1", content: "foo baz foo" };
    let result: { content?: string } | void;
    for (const hook of sendingHooks) {
      result = await hook(event, { channelId: "test" });
    }
    // No rules applied, should return void/undefined
    expect(result).toBeUndefined();
  });

  it("input-stage regex rules are NOT applied to output", async () => {
    const stateDir = await makeStateDir();
    const { sendingHooks } = makeApi(stateDir);

    const rulesPath = path.join(stateDir, "regex-rules.json");
    await writeFile(
      rulesPath,
      JSON.stringify([
        { name: "input-only", pattern: "secret", flags: "g", replacement: "hidden", enabled: true, description: "", stage: "input" },
      ]),
      "utf8",
    );

    const event = { to: "user:1", content: "This is a secret message" };
    let result: { content?: string } | void;
    for (const hook of sendingHooks) {
      result = await hook(event, { channelId: "test" });
    }
    // Input rules should not affect output
    expect(result).toBeUndefined();
  });

  it("regex rules are applied in order (chaining)", async () => {
    const stateDir = await makeStateDir();
    const { sendingHooks } = makeApi(stateDir);

    const rulesPath = path.join(stateDir, "regex-rules.json");
    await writeFile(
      rulesPath,
      JSON.stringify([
        { name: "step1", pattern: "cat", flags: "g", replacement: "dog", enabled: true, description: "", stage: "output" },
        { name: "step2", pattern: "dog", flags: "g", replacement: "fish", enabled: true, description: "", stage: "output" },
      ]),
      "utf8",
    );

    const event = { to: "user:1", content: "I have a cat" };
    let result: { content?: string } | void;
    for (const hook of sendingHooks) {
      result = await hook(event, { channelId: "test" });
    }
    // cat → dog (step1), then dog → fish (step2)
    expect(result).toBeTruthy();
    expect(result!.content).toBe("I have a fish");
  });

  it("regex clear removes all rules", async () => {
    const stateDir = await makeStateDir();
    const { commands } = makeApi(stateDir);
    const regex = commands.get("regex");
    expect(regex).toBeTruthy();

    // Add two rules first
    await regex!.handler({ args: "add /foo/g => bar" });
    await regex!.handler({ args: "add /baz/g => qux" });

    // Verify they exist
    const listResult = await regex!.handler({ args: "list" });
    expect(listResult.text).toContain("Regex rules (2):");

    // Clear all
    const clearResult = await regex!.handler({ args: "clear" });
    expect(clearResult.text).toContain("Cleared all 2 regex rule(s).");

    // Verify empty
    const afterClear = await regex!.handler({ args: "list" });
    expect(afterClear.text).toContain("No regex rules configured.");
  });

  it("regex clear on empty rules", async () => {
    const stateDir = await makeStateDir();
    const { commands } = makeApi(stateDir);
    const regex = commands.get("regex");
    expect(regex).toBeTruthy();

    const result = await regex!.handler({ args: "clear" });
    expect(result.text).toContain("No regex rules to clear.");
  });
});
