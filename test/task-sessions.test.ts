import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent, taskScope, type AgentProgress } from "../extensions/omp/subagents.ts";
import { TaskSessions } from "../extensions/omp/task-sessions.ts";
import { RpcWorker } from "../extensions/omp/rpc-worker.ts";

const keys = ["PI_CODING_AGENT_DIR", "OMP_TEST_CAPTURE", "OMP_TEST_WAIT_MS", "OMP_TEST_SETTLE_WAIT_MS", "OMP_TEST_EXIT_WAIT_MS", "OMP_TEST_RETRY", "OMP_TEST_DUPLICATE", "OMP_TEST_FAIL"] as const;
let saved: Array<string | undefined>;
let argv: string;
let root: string;
let ctx: any;
let sessions: TaskSessions;
const capture = () => JSON.parse(fs.readFileSync(process.env.OMP_TEST_CAPTURE!, "utf8"));
const run = (task: string, taskId?: string, signal?: AbortSignal, activity?: (row: AgentProgress) => void, launch = { model: "test/model", thinking: "low" as const }) =>
  runAgent(ctx, { agent: "fixer", task, taskId }, signal, launch, activity, sessions);

beforeEach(() => {
  saved = keys.map(key => process.env[key]);
  keys.forEach(key => delete process.env[key]);
  argv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-test-"));
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.OMP_TEST_CAPTURE = path.join(root, "capture.json");
  ctx = { cwd: root, isProjectTrusted: () => false };
  sessions = new TaskSessions();
});
afterEach(async () => {
  await sessions.clear();
  process.argv[1] = argv;
  keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  fs.rmSync(root, { recursive: true, force: true });
});

test("same task resumes in the same process, while independent tasks have separate context", async () => {
  const first = await run("first");
  const initial = capture();
  const second = await run("follow-up", first.taskId);
  expect(second.ok).toBe(true);
  expect(second.taskId).toBe(first.taskId);
  expect(second.runId).not.toBe(first.runId);
  expect(capture().pid).toBe(initial.pid);
  expect(capture().count).toBe(2);
  const independent = await run("unrelated");
  expect(independent.taskId).not.toBe(first.taskId);
  expect(capture().pid).not.toBe(initial.pid);
  expect(capture().count).toBe(1);
});

test("a completed result does not wait for process shutdown", async () => {
  process.env.OMP_TEST_EXIT_WAIT_MS = "700";
  const start = performance.now();
  const result = await run("finish promptly");
  expect(result.ok).toBe(true);
  expect(performance.now() - start).toBeLessThan(600);
  expect(result.timings?.totalMs).toBeGreaterThanOrEqual(result.timings!.startupMs);
  expect(result.timings?.firstEventMs).toBeGreaterThanOrEqual(result.timings!.startupMs);
});

test("message_end and retries do not complete a task before settlement", async () => {
  process.env.OMP_TEST_SETTLE_WAIT_MS = "250";
  process.env.OMP_TEST_RETRY = "1";
  process.env.OMP_TEST_DUPLICATE = "1";
  const snapshots: AgentProgress[] = [];
  let complete = false;
  const pending = run("retry", undefined, undefined, row => snapshots.push(row)).then(result => { complete = true; return result; });
  for (let i = 0; i < 100 && !snapshots.some(row => row.text === "Specialist read the task"); i++) await Bun.sleep(5);
  expect(complete).toBe(false);
  expect(snapshots.some(row => row.state === "done")).toBe(false);
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(result.output).not.toContain("secret");
  expect(snapshots.filter(row => row.state === "done")).toHaveLength(1);
});

test("idle eviction restores native session context without replaying the original task", async () => {
  sessions = new TaskSessions(10_000, 1);
  const first = await run("first");
  const initial = capture();
  await run("second independent task");
  const resumed = await run("continue first", first.taskId);
  expect(resumed.ok).toBe(true);
  expect(capture().pid).not.toBe(initial.pid);
  expect(capture().count).toBe(2);
  expect(capture().message).toBe("Assigned task:\ncontinue first");
  expect(capture().args).toContain("--session");
});

test("idle expiry retires the worker and leaves a resumable session", async () => {
  sessions = new TaskSessions(20, 4);
  const first = await run("first");
  const pid = capture().pid;
  await Bun.sleep(70);
  await run("continue", first.taskId);
  expect(capture().pid).not.toBe(pid);
  expect(capture().count).toBe(2);
});

test("model and account revisions rebuild a worker while retaining its task context", async () => {
  const first = await run("first");
  let pid = capture().pid;
  await run("new model", first.taskId, undefined, undefined, { model: "test/other", thinking: "low" });
  expect(capture().pid).not.toBe(pid);
  expect(capture().count).toBe(2);
  pid = capture().pid;
  fs.writeFileSync(path.join(root, "accounts.json"), "{}");
  await run("new account", first.taskId, undefined, undefined, { model: "test/other", thinking: "low" });
  expect(capture().pid).not.toBe(pid);
  expect(capture().count).toBe(3);
});

test("running, duplicate, unknown and cross-scope continuations are rejected", async () => {
  process.env.OMP_TEST_WAIT_MS = "180";
  let id = "";
  const pending = run("first", undefined, undefined, row => { id = row.taskId!; });
  expect(() => sessions.validate([{ agent: "fixer", task: "duplicate", taskId: id }], taskScope(ctx))).toThrow("still running");
  const result = await pending;
  expect(result.ok).toBe(true);
  const item = { agent: "fixer" as const, task: "resume", taskId: id };
  expect(() => sessions.validate([item, item], taskScope(ctx))).toThrow("once");
  expect(() => sessions.validate([{ ...item, taskId: "unknown" }], taskScope(ctx))).toThrow("Unknown");
  expect(() => sessions.validate([{ ...item, agent: "explorer" }], taskScope(ctx))).toThrow("scope changed");
  ctx.isProjectTrusted = () => true;
  expect(() => sessions.validate([item], taskScope(ctx))).toThrow("scope changed");
});

test("cancellation waits for process exit and allows explicit recovery of partial context", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const result = await run("[delay=1000] partial", undefined, controller.signal, row => {
    if (!cancelled && row.text) { cancelled = true; controller.abort(); }
  });
  expect(result.cancelled).toBe(true);
  const pid = capture().pid;
  expect(() => process.kill(pid, 0)).toThrow();
  const recovered = await run("inspect partial work and continue", result.taskId);
  expect(recovered.ok).toBe(true);
  expect(capture().count).toBe(2);
});

test("shutdown covers in-flight launches and repeated cleanup calls", async () => {
  process.env.OMP_TEST_WAIT_MS = "1000";
  const pending = run("launch then reload");
  const first = sessions.clear();
  await sessions.clear();
  await first;
  expect((await pending).ok).toBe(false);
  const next = await run("[delay=0] fresh after reload");
  expect(next.ok).toBe(true);
});

test("unresponsive startup is bounded and interactive requests cannot be auto-approved", async () => {
  const quiet = path.join(root, "quiet.mjs");
  fs.writeFileSync(quiet, 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));');
  const worker = new RpcWorker(process.execPath, [quiet], root, process.env, async () => {}, 40);
  await expect(worker.ready).rejects.toThrow("timed out");
  await worker.stop();
  const ask = path.join(root, "ask.mjs");
  fs.writeFileSync(ask, 'console.log(JSON.stringify({type:"extension_ui_request",id:"permission",method:"confirm"})); process.stdin.resume();');
  const asking = new RpcWorker(process.execPath, [ask], root, process.env, async () => {}, 500);
  await expect(asking.ready).rejects.toThrow("interactive input");
  await asking.stop();
});

test("a later settlement is rechecked when it races an earlier busy-state response", async () => {
  const script = path.join(root, "racing-state.mjs");
  fs.writeFileSync(script, `
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin });
    const emit = event => console.log(JSON.stringify(event));
    let checks = 0;
    input.on("line", line => {
      const cmd = JSON.parse(line);
      if (cmd.type === "get_state") {
        checks++;
        if (checks === 2) emit({ type: "agent_settled" });
        emit({type:"response", id:cmd.id, command:cmd.type, success:true, data:{isStreaming:checks === 2,pendingMessageCount:0}});
      } else {
        emit({type:"response", id:cmd.id, command:cmd.type, success:true});
        if (cmd.type === "prompt") {
          emit({type:"agent_start"});
          emit({type:"agent_settled"});
        }
      }
    });
    input.on("close", () => process.exit(0));
  `);
  const worker = new RpcWorker(process.execPath, [script], root, process.env, async () => {}, 300);
  try { await worker.prompt("work", undefined, () => {}); }
  finally { await worker.stop(); }
});