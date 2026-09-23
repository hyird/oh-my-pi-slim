import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent } from "../extensions/omp/subagents.ts";
import { getConversation, listConversations, startConversation, subscribeConversations } from "../extensions/omp/transcript.ts";

const previousDir = process.env.PI_CODING_AGENT_DIR;
const previousArgv = process.argv[1];
let root: string;
const ctx: any = { cwd: process.cwd(), isProjectTrusted: () => false };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-conversation-"));
  process.env.PI_CODING_AGENT_DIR = root;
});
afterEach(() => {
  process.argv[1] = previousArgv;
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  fs.rmSync(root, { recursive: true, force: true });
});

function fake(events: any[], exit = 0) {
  const file = path.join(root, "fake.mjs");
  fs.writeFileSync(file, `for (const event of ${JSON.stringify(events)}) { console.log(JSON.stringify(event)); await new Promise(r => setTimeout(r, 30)); } process.exit(${exit});`);
  process.argv[1] = file;
}
const message = (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });

async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}

test("live notifications and complete persisted JSON events survive reads without seq deduplication", async () => {
  const long = "long output ".repeat(25_000);
  const events = [
    { type: "message_update", seq: 7, assistantMessageEvent: { type: "text_delta", delta: "first", contentIndex: 0 } },
    { type: "message_update", seq: 7, assistantMessageEvent: { type: "text_delta", delta: "second", contentIndex: 0 } },
    { type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "echo test" } },
    { type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: { content: [{ type: "text", text: long }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "done" }] } },
    message(long),
  ];
  fake(events);
  let notifications = 0;
  const unsubscribe = subscribeConversations(() => { notifications++; });
  try {
    const pending = runAgent(ctx, { agent: "explorer", task: "sample" }, undefined, "test/model");
    await waitUntil(() => listConversations().some((meta) => meta.state === "running" && !!getConversation(meta.id)?.events.length));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeLessThan(long.length);
    expect(result.output).toContain("[output truncated]");
    const [meta] = listConversations();
    expect(meta.state).toBe("done");
    expect(meta.task).toBe("sample");
    expect(meta.finishedAt).toBeNumber();
    expect(getConversation(meta.id)?.events).toEqual(events);
    expect(notifications).toBeGreaterThan(1);
    const file = path.join(root, "omp", "conversations", `${meta.id}.jsonl`);
    expect(fs.readFileSync(file, "utf8")).toContain(long);
    const sidecar = path.join(root, "omp", "conversations", `${meta.id}.meta.json`);
    expect(JSON.parse(fs.readFileSync(sidecar, "utf8"))).toEqual(meta);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") {
      expect(fs.statSync(sidecar).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    unsubscribe();
    const count = notifications;
    // A cached view still agrees with the persisted recording and listing.
    expect(getConversation(meta.id)?.events).toEqual(events);
    expect(listConversations()[0].id).toBe(meta.id);
    expect(notifications).toBe(count);
  } finally { unsubscribe(); }
});

test("delegation ID persists in both metadata formats; older recordings without it remain readable", () => {
  const delegationId = "11111111-1111-4111-8111-111111111111";
  const run = startConversation("explorer", "grouped", "test/model", delegationId);
  const grouped = listConversations().find((meta) => meta.task === "grouped")!;
  expect(grouped.delegationId).toBe(delegationId);
  run.finish("failed", "test failure");
  const file = path.join(root, "omp", "conversations", `${grouped.id}.jsonl`);
  const sidecar = path.join(root, "omp", "conversations", `${grouped.id}.meta.json`);
  expect(JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]).meta.delegationId).toBe(delegationId);
  expect(JSON.parse(fs.readFileSync(sidecar, "utf8")).delegationId).toBe(delegationId);
  expect(getConversation(grouped.id)?.meta.delegationId).toBe(delegationId);
  expect(getConversation(grouped.id)?.meta.state).toBe("failed");

  const legacy = startConversation("fixer", "legacy", "test/model");
  legacy.finish("done");
  const old = listConversations().find((meta) => meta.task === "legacy")!;
  expect(old.delegationId).toBeUndefined();
  expect(getConversation(old.id)?.meta.delegationId).toBeUndefined();
  fs.unlinkSync(path.join(root, "omp", "conversations", `${old.id}.meta.json`));
  expect(listConversations().find((meta) => meta.id === old.id)?.delegationId).toBeUndefined();
});

test("unchanged reads hit the cache; append and completion invalidate it", () => {
  const run = startConversation("explorer", "live", "test/model");
  const id = listConversations()[0].id;
  const originalRead = fs.readFileSync;
  let reads = 0;
  const read = spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
    if (typeof file === "number") reads++;
    return (originalRead as any)(file, ...args);
  }) as typeof fs.readFileSync);
  try {
    expect(getConversation(id)?.events).toEqual([]);
    expect(getConversation(id)?.events).toEqual([]);
    expect(reads).toBe(1);
    run.record(message("new"));
    expect(getConversation(id)?.events).toEqual([message("new")]);
    expect(reads).toBe(2);
    // Caller mutations must not poison subsequent cache hits.
    getConversation(id)!.events.push(message("not persisted"));
    expect(getConversation(id)?.events).toEqual([message("new")]);
    expect(reads).toBe(2);
    run.finish("done");
    expect(getConversation(id)?.meta.state).toBe("done");
    expect(getConversation(id)?.meta.finishedAt).toBeNumber();
    expect(reads).toBe(3);
  } finally { read.mockRestore(); run.finish("done"); }
});

test("an incomplete live line does not hide its later completion", () => {
  const run = startConversation("explorer", "partial write", "test/model");
  const id = listConversations()[0].id;
  const file = path.join(root, "omp", "conversations", `${id}.jsonl`);
  const tail = JSON.stringify({ type: "event", event: message("completed line") }) + "\n";
  const cut = Math.floor(tail.length / 2);
  fs.appendFileSync(file, tail.slice(0, cut));
  expect(getConversation(id)?.events).toEqual([]);
  expect(getConversation(id)?.events).toEqual([]);
  fs.appendFileSync(file, tail.slice(cut));
  expect(getConversation(id)?.events).toEqual([message("completed line")]);
  run.finish("done");
});

test("LRU evicts old conversations and agent directory changes cannot reuse cached values", () => {
  const ids: string[] = [];
  for (let i = 0; i < 9; i++) {
    const run = startConversation("explorer", `cache ${i}`, "test/model");
    const id = listConversations().find((meta) => meta.task === `cache ${i}`)!.id;
    ids.push(id);
    run.finish("done");
    expect(getConversation(id)?.meta.task).toBe(`cache ${i}`);
  }
  const originalRead = fs.readFileSync;
  let reads = 0;
  const read = spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
    if (typeof file === "number") reads++;
    return (originalRead as any)(file, ...args);
  }) as typeof fs.readFileSync);
  try {
    expect(getConversation(ids[8])?.meta.task).toBe("cache 8");
    expect(reads).toBe(0);
    expect(getConversation(ids[0])?.meta.task).toBe("cache 0");
    expect(reads).toBe(1);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "omp-other-"));
    try {
      const dir = path.join(other, "omp", "conversations");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${ids[0]}.jsonl`), JSON.stringify({ type: "meta", meta: {
        id: ids[0], agent: "explorer", task: "other directory", model: "test/model", state: "done", startedAt: 1,
      } }) + "\n");
      process.env.PI_CODING_AGENT_DIR = other;
      expect(getConversation(ids[0])?.meta.task).toBe("other directory");
      expect(getConversation(ids[8])).toBeUndefined();
    } finally { process.env.PI_CODING_AGENT_DIR = root; fs.rmSync(other, { recursive: true, force: true }); }
    expect(getConversation(ids[0])?.meta.task).toBe("cache 0");
  } finally { read.mockRestore(); }
});

test("a cached recording replaced by a symlink is rejected", () => {
  const run = startConversation("explorer", "safe", "test/model");
  run.finish("done");
  const id = listConversations()[0].id;
  expect(getConversation(id)?.meta.task).toBe("safe");
  const file = path.join(root, "omp", "conversations", `${id}.jsonl`);
  const outside = path.join(root, "outside.jsonl");
  fs.copyFileSync(file, outside);
  fs.unlinkSync(file);
  try {
    fs.symlinkSync(outside, file);
    expect(getConversation(id)).toBeUndefined();
  } catch (err: any) { if (err.code !== "EPERM") throw err; }
});

test("failed and cancelled runs finish, and invalid IDs or symlink paths are rejected", async () => {
  fake([message("partial")], 2);
  const failed = await runAgent(ctx, { agent: "fixer", task: "failure" }, undefined, "test/model");
  expect(failed.ok).toBe(false);
  expect(listConversations()[0].state).toBe("failed");
  const id = listConversations()[0].id;
  expect(getConversation(id)?.events).toEqual([message("partial")]);
  expect(getConversation("../" + id)).toBeUndefined();
  expect(getConversation(id + "/../" + id)).toBeUndefined();
  expect(getConversation("..\\" + id)).toBeUndefined();
  const outside = path.join(root, "outside.jsonl");
  fs.writeFileSync(outside, "secret");
  const alias = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  try {
    fs.symlinkSync(outside, path.join(root, "omp", "conversations", `${alias}.jsonl`));
    expect(getConversation(alias)).toBeUndefined();
    const validAlias = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const validOutside = path.join(root, "valid-outside.jsonl");
    fs.writeFileSync(validOutside, JSON.stringify({ type: "meta", meta: { ...listConversations()[0], id: validAlias } }) + "\n");
    fs.symlinkSync(validOutside, path.join(root, "omp", "conversations", `${validAlias}.jsonl`));
    expect(getConversation(validAlias)).toBeUndefined();
  } catch (err: any) { if (err.code !== "EPERM") throw err; }

  fake(Array.from({ length: 30 }, (_, i) => ({ type: "message_update", seq: i, assistantMessageEvent: { type: "text_delta", delta: "x" } })));
  const controller = new AbortController();
  const pending = runAgent(ctx, { agent: "fixer", task: "cancel" }, controller.signal, "test/model");
  await waitUntil(() => listConversations().some((meta) => meta.task === "cancel" && getConversation(meta.id)!.events.length > 0));
  controller.abort();
  expect((await pending).ok).toBe(false);
  const cancelled = listConversations().find((meta) => meta.task === "cancel")!;
  expect(cancelled.state).toBe("failed");
  expect(cancelled.finishedAt).toBeNumber();
});

test("listing many large current runs reads sidecars, never JSONL bodies; old logs still work", () => {
  const dir = path.join(root, "omp", "conversations");
  const ids: string[] = [];
  for (let i = 0; i < 24; i++) {
    const run = startConversation("explorer", `large ${i}`, "test/model");
    const current = listConversations().find((meta) => meta.task === `large ${i}`)!;
    expect(current.state).toBe("running");
    const id = current.id;
    ids.push(id);
    run.record(message("x".repeat(1_000_000)));
    run.finish("done");
  }
  const originalRead = fs.readFileSync;
  const read = spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
    if (typeof file === "number" && fs.fstatSync(file).size > 100_000) throw new Error("JSONL body read during listing");
    return (originalRead as any)(file, ...args);
  }) as typeof fs.readFileSync);
  try {
    for (let i = 0; i < 3; i++) expect(listConversations().map((meta) => meta.id).sort()).toEqual([...ids].sort());
  } finally { read.mockRestore(); }
  const legacy = ids[0];
  fs.unlinkSync(path.join(dir, `${legacy}.meta.json`));
  expect(listConversations().find((meta) => meta.id === legacy)?.state).toBe("done");
  expect(getConversation(legacy)?.events[0]).toEqual(message("x".repeat(1_000_000)));
});
