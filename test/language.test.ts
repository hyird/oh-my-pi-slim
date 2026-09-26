import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareAssignments } from "../extensions/omp/language.ts";
import { ROLES } from "../extensions/omp/roles.ts";
import { runAgent, type Assignment } from "../extensions/omp/subagents.ts";

let agentDir: string;
let savedDir: string | undefined;
beforeEach(() => {
  savedDir = process.env.PI_CODING_AGENT_DIR;
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-language-profile-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
  if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedDir;
  fs.rmSync(agentDir, { recursive: true, force: true });
});
const message = (content: unknown) => ({ type: "message", message: { role: "user", content } });
function fixture(latest: string) {
  const calls: unknown[] = [];
  const ctx: any = {
    cwd: os.tmpdir(), model: { provider: "test", id: "main" },
    isProjectTrusted: () => false,
    sessionManager: { getBranch: () => [message("old message"), message(latest), { type: "message", message: { role: "assistant", content: "English main task" } }] },
    modelRegistry: {
      getAvailable: () => [{ provider: "test", id: "main" }],
      streamSimple: (...args: unknown[]) => { calls.push(args); throw new Error("Unexpected model call"); },
    },
  };
  return { ctx, calls };
}

describe("language guidance without translation", () => {
  for (const latest of ["请修复这个问题", "Please fix this", "この問題を修正して", "Corrige este problema"]) {
    test(latest + ": preserves tasks without a model request", () => {
      const f = fixture(latest);
      const items: Assignment[] = [{ agent: "fixer", task: latest + " src/a.ts" }, { agent: "oracle", task: "Review src/a.ts" }];
      const prepared = prepareAssignments(f.ctx, items);
      expect(f.calls).toEqual([]);
      expect(prepared.items.map(item => item.task)).toEqual(items.map(item => item.task));
      expect(prepared.items[0].prompt).toContain(ROLES.fixer.prompt);
      expect(prepared.items[0].prompt).toContain(JSON.stringify(latest));
      expect(prepared.items[0].prompt).toContain("Use the language of the latest user message");
      expect(items[0].prompt).toBeUndefined();
    });
  }
  test("uses current branch user text, skips image-only messages, and bounds the reference", () => {
    const f = fixture("ignored");
    f.ctx.sessionManager.getBranch = () => [message("earlier"), message([{ type: "image" }, { type: "text", text: "x".repeat(5000) }]), message([{ type: "image" }]), { type: "custom_message", content: "English injected task" }];
    const prompt = prepareAssignments(f.ctx, [{ agent: "explorer", task: "search" }]).items[0].prompt!;
    expect(prompt).toContain(JSON.stringify("x".repeat(4000)));
    expect(prompt).not.toContain("x".repeat(4001));
    expect(prompt).not.toContain("English injected task");
  });
  test("Council keeps three perspective tasks and the current user language reference", () => {
    const f = fixture("请审查方案");
    const items: Assignment[] = ["security", "performance", "maintenance"].map(task => ({ agent: "council", task }));
    const prepared = prepareAssignments(f.ctx, items);
    expect(prepared.items.map(item => item.task)).toEqual(items.map(item => item.task));
    for (const item of prepared.items) {
      expect(item.prompt).toContain("请审查方案");
      expect(item.prompt).toContain("Council perspective headings");
    }
    expect(f.calls).toEqual([]);
  });
  test("falls back to task language without user text or a main model", () => {
    const f = fixture("");
    f.ctx.sessionManager.getBranch = () => [];
    f.ctx.model = undefined;
    expect(prepareAssignments(f.ctx, [{ agent: "fixer", task: "修复错误" }]).items[0].prompt).toContain("Use the language of the assigned task");
  });
  test("rejects invalid tasks and cancellation before dispatch", () => {
    const f = fixture("Fix this");
    expect(() => prepareAssignments(f.ctx, [{ agent: "fixer", task: " " }])).toThrow("Invalid assignment");
    const controller = new AbortController();
    controller.abort();
    expect(() => prepareAssignments(f.ctx, [{ agent: "fixer", task: "Fix" }], controller.signal)).toThrow("cancelled");
    expect(f.calls).toEqual([]);
  });

  test("CLI-safe task transport never interprets leading flags or file references", async () => {
    const f = fixture("Please inspect");
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
    const f = fixture("Please review");
    const items: Assignment[] = [{ agent: "explorer", task: "Find files" }];
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
