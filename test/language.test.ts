import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareAssignments } from "../extensions/omp/language.ts";
import { ROLES } from "../extensions/omp/roles.ts";
import { runAgent, type Assignment } from "../extensions/omp/subagents.ts";

const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content: string) => ({ type: "message", message: { role: "user", content } });
function fixture(latest: string, language: string, translated: string) {
  const calls: any[] = [];
  let response: any;
  const ctx: any = {
    cwd: os.tmpdir(), model: { provider: "test", id: "main" },
    isProjectTrusted: () => false,
    sessionManager: { getBranch: () => [message("old message"), { type: "compaction", summary: "English summary" }, message(latest), { type: "message", message: { role: "assistant", content: "English main task" } }, { type: "custom_message", content: "English injected task" }] },
    modelRegistry: {
      getAvailable: () => [{ provider: "test", id: "main" }],
      streamSimple: (...args: any[]) => { calls.push(args); return { result: async () => response }; },
    },
  };
  const setResponse = (items: Assignment[]) => {
    const roles = [...new Set(items.map((item) => item.agent))];
    response = { stopReason: "stop", usage, content: [{ type: "text", text: JSON.stringify({
      language, prompts: Object.fromEntries(roles.map((role) => [role, `${translated} ${role}: ${ROLES[role].prompt}\nRespond in ${language}.`] )),
      tasks: items.map((item, index) => `${translated} task ${index}: ${item.task}`),
    }) }] };
  };
  return { ctx, calls, setResponse, setRaw: (value: any) => { response = value; } };
}

describe("runtime language preparation", () => {
  for (const [language, latest, translated] of [
    ["Chinese", "请修复这个问题", "修复"], ["English", "Please fix this", "Localized"],
    ["Japanese", "この問題を修正して", "修正"], ["Spanish", "Corrige este problema", "Arreglar"],
  ]) {
    test(`${language}: uses the latest user message and prepares every role and task in one call`, async () => {
      const f = fixture(latest, language, translated);
      const items: Assignment[] = [{ agent: "fixer", task: "English main-authored task at src/a.ts" }, { agent: "oracle", task: "English review" }];
      f.setResponse(items);
      const prepared = await prepareAssignments(f.ctx, items);
      expect(f.calls).toHaveLength(1);
      const [model, context, options] = f.calls[0];
      expect(model).toBe(f.ctx.model);
      expect(context.systemPrompt).toContain("latestUserMessage field only");
      expect(options.cacheRetention).toBe("none");
      const input = JSON.parse(context.messages[0].content[0].text);
      expect(input.latestUserMessage).toBe(latest);
      expect(input.prompts).toEqual({ fixer: ROLES.fixer.prompt, oracle: ROLES.oracle.prompt });
      expect(input.tasks).toEqual(items.map((item) => item.task));
      expect(prepared.language).toBe(language);
      expect(prepared.usage).toEqual(usage);
      expect(prepared.items[0].prompt).toContain(`Respond in ${language}`);
      expect(prepared.items[0].task).toContain(translated);
      expect(items[0].prompt).toBeUndefined();
    });
  }

  test("text parts and capped user sample, not a later tool or main-agent message", async () => {
    const f = fixture("ignored", "Japanese", "Localized");
    f.ctx.sessionManager.getBranch = () => [message("earlier"), { type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "x".repeat(5000) }] } }, { type: "message", message: { role: "toolResult", content: "English" } }];
    f.setResponse([{ agent: "explorer", task: "search" }]);
    await prepareAssignments(f.ctx, [{ agent: "explorer", task: "search" }]);
    expect(JSON.parse(f.calls[0][1].messages[0].content[0].text).latestUserMessage).toBe("x".repeat(4000));
  });

  test("three council perspectives share one call and one canonical council prompt", async () => {
    const f = fixture("Compare alternatives", "English", "Localized");
    const items: Assignment[] = ["security", "performance", "maintenance"].map((perspective) => ({ agent: "council", task: `Review ${perspective}` }));
    f.setResponse(items);
    const prepared = await prepareAssignments(f.ctx, items);
    expect(f.calls).toHaveLength(1);
    const input = JSON.parse(f.calls[0][1].messages[0].content[0].text);
    expect(Object.keys(input.prompts)).toEqual(["council"]);
    expect(prepared.items.map((item) => item.task)).toEqual(items.map((item, i) => `Localized task ${i}: ${item.task}`));
  });

  test("rejects malformed, failed and aborted responses before any child can run", async () => {
    const f = fixture("Fix this", "English", "Localized");
    const items: Assignment[] = [{ agent: "fixer", task: "Fix" }];
    for (const value of ["not json", JSON.stringify({ language: "English", prompts: {}, tasks: ["Fix"] }), JSON.stringify({ language: "", prompts: { fixer: "Prompt" }, tasks: ["Fix"] }), JSON.stringify({ language: "English", prompts: { fixer: "Prompt" }, tasks: [] })]) {
      f.setRaw({ stopReason: "stop", usage, content: [{ type: "text", text: value }] });
      await expect(prepareAssignments(f.ctx, items)).rejects.toThrow("Invalid language preparation response");
    }
    f.setRaw({ stopReason: "error", usage, content: [] });
    await expect(prepareAssignments(f.ctx, items)).rejects.toThrow("Language preparation failed");
    const controller = new AbortController();
    controller.abort();
    const count = f.calls.length;
    await expect(prepareAssignments(f.ctx, items, controller.signal)).rejects.toThrow("cancelled");
    expect(f.calls).toHaveLength(count);
    f.setRaw({ stopReason: "aborted", usage, content: [] });
    await expect(prepareAssignments(f.ctx, items)).rejects.toThrow("cancelled");
    f.setRaw({ stopReason: "length", usage, content: [{ type: "text", text: "{}" }] });
    await expect(prepareAssignments(f.ctx, items)).rejects.toThrow("Language preparation failed: length");
    const inFlight = new AbortController();
    f.setResponse(items);
    f.ctx.modelRegistry.streamSimple = () => ({ result: async () => { inFlight.abort(); return { stopReason: "stop", usage, content: [{ type: "text", text: "{}" }] }; } });
    await expect(prepareAssignments(f.ctx, items, inFlight.signal)).rejects.toThrow("cancelled");
  });

  test("CLI-safe task transport never interprets translated leading flags or file references", async () => {
    const f = fixture("Please inspect", "English", "Localized");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-argv-test-"));
    const oldArgv = process.argv[1];
    const oldCapture = process.env.OMP_TEST_CAPTURE;
    process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
    process.env.OMP_TEST_CAPTURE = path.join(dir, "capture.json");
    try {
      for (const task of ["--help", "@private/file.txt"]) {
        expect((await runAgent(f.ctx, { agent: "explorer", task }, undefined, "test/model")).ok).toBe(true);
        const argv: string[] = JSON.parse(fs.readFileSync(process.env.OMP_TEST_CAPTURE, "utf8")).args;
        expect(argv.at(-2)).toBe("--");
        expect(argv.at(-1)).toBe(task.startsWith("@") ? `\n${task}` : task);
      }
    } finally {
      process.argv[1] = oldArgv;
      if (oldCapture === undefined) delete process.env.OMP_TEST_CAPTURE;
      else process.env.OMP_TEST_CAPTURE = oldCapture;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the prepared prompt and task reach the child CLI unchanged", async () => {
    const f = fixture("Please review", "English", "Localized");
    const items: Assignment[] = [{ agent: "explorer", task: "Find files" }];
    f.setResponse(items);
    const prepared = await prepareAssignments(f.ctx, items);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-language-test-"));
    const oldArgv = process.argv[1];
    const oldCapture = process.env.OMP_TEST_CAPTURE;
    process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
    process.env.OMP_TEST_CAPTURE = path.join(dir, "capture.json");
    try {
      const result = await runAgent(f.ctx, prepared.items[0], undefined, "test/main");
      expect(result.ok).toBe(true);
      const recorded = JSON.parse(fs.readFileSync(process.env.OMP_TEST_CAPTURE, "utf8"));
      expect(recorded.prompt).toBe(prepared.items[0].prompt);
      expect(recorded.args.at(-1)).toBe(prepared.items[0].task);
    } finally {
      process.argv[1] = oldArgv;
      if (oldCapture === undefined) delete process.env.OMP_TEST_CAPTURE;
      else process.env.OMP_TEST_CAPTURE = oldCapture;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
