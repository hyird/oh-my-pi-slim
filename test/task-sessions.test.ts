import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent, taskScope, type AgentProgress } from "../extensions/omp/subagents.ts";
import { TaskSessions } from "../extensions/omp/task-sessions.ts";
import { RpcWorker } from "../extensions/omp/rpc-worker.ts";

const keys = ["PI_CODING_AGENT_DIR", "OMP_TEST_CAPTURE", "OMP_TEST_WAIT_MS", "OMP_TEST_SETTLE_WAIT_MS", "OMP_TEST_EXIT_WAIT_MS", "OMP_TEST_RETRY", "OMP_TEST_DUPLICATE", "OMP_TEST_FAIL", "OMP_TEST_LENGTH"] as const;
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
  expect(snapshots.some(row => row.activity === "Retrying model request 1/3 after 40ms")).toBe(true);
  expect(snapshots.some(row => row.activity === "Model request recovered")).toBe(true);
  expect(snapshots.every(row => !row.activity.includes("secret"))).toBe(true);
  expect(snapshots.every(row => !row.replyText?.includes("failed provider draft"))).toBe(true);
  expect(snapshots.every(row => !row.text.includes("failed provider draft"))).toBe(true);
  expect(result.usage.cost.total).toBeCloseTo(0.6);
  expect(snapshots.filter(row => row.state === "done")).toHaveLength(1);
});

test("a final output-limit stop is not reported as completed work", async () => {
  process.env.OMP_TEST_LENGTH = "1";
  const limited = await run("large task");
  expect(limited.ok).toBe(false);
  expect(limited.output).toContain("output limit");
  expect(limited.taskId).toBeTruthy();
  delete process.env.OMP_TEST_LENGTH;
  const continued = await run("inspect partial work and finish", limited.taskId);
  expect(continued.ok).toBe(true);
  expect(capture().count).toBe(2);
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

test("account display metadata keeps a warm worker while credential changes restart it", async () => {
  const accountsPath = path.join(root, "accounts.json");
  const account = { provider: "test", name: "saved", credential: { type: "api_key", key: "first" }, email: "first@example.com" };
  fs.writeFileSync(accountsPath, JSON.stringify({ version: 1, accounts: [account] }));
  const first = await run("first");
  const pid = capture().pid;
  fs.writeFileSync(accountsPath, JSON.stringify({ version: 1, accounts: [{ ...account, email: "second@example.com" }] }));
  const continued = await run("after email update", first.taskId);
  expect(continued.ok).toBe(true);
  expect(capture().pid).toBe(pid);
  fs.writeFileSync(accountsPath, JSON.stringify({ version: 1, accounts: [{ ...account, name: "renamed", email: "second@example.com" }] }));
  await run("after label update", first.taskId);
  expect(capture().pid).toBe(pid);
  fs.writeFileSync(accountsPath, JSON.stringify({ accounts: [{
    email: "second@example.com", credential: { key: "first", type: "api_key" },
    name: "renamed", provider: "test",
  }], version: 1 }));
  await run("after field reorder", first.taskId);
  expect(capture().pid).toBe(pid);
  fs.writeFileSync(accountsPath, JSON.stringify({ version: 1, accounts: [{ ...account, credential: { type: "api_key", key: "second" } }] }));
  const refreshed = await run("after credential update", first.taskId);
  expect(refreshed.ok).toBe(true);
  expect(capture().pid).not.toBe(pid);
});

test("equivalent auth rewrites keep a warm worker while token changes restart it", async () => {
  const authPath = path.join(root, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify({ test: { type: "api_key", key: "first", env: { A: "1", B: "2" } } }));
  const first = await run("first");
  const pid = capture().pid;
  fs.writeFileSync(authPath, JSON.stringify({ test: { env: { B: "2", A: "1" }, key: "first", type: "api_key" } }));
  await run("after field reorder", first.taskId);
  expect(capture().pid).toBe(pid);
  fs.writeFileSync(authPath, JSON.stringify({ test: { env: { B: "2", A: "1" }, key: "second", type: "api_key" } }));
  await run("after token change", first.taskId);
  expect(capture().pid).not.toBe(pid);
});

test("project instruction changes restart a worker while unrelated files do not", async () => {
  const instructions = path.join(root, "AGENTS.md");
  fs.writeFileSync(instructions, "Initial instructions");
  const first = await run("first");
  let pid = capture().pid;
  fs.writeFileSync(path.join(root, "notes.txt"), "unrelated edit");
  await run("after unrelated edit", first.taskId);
  expect(capture().pid).toBe(pid);
  fs.writeFileSync(instructions, "Revised instructions");
  await run("after instruction edit", first.taskId);
  expect(capture().pid).not.toBe(pid);
  pid = capture().pid;
  const override = path.join(root, "AGENTS.override.md");
  fs.writeFileSync(override, "Higher priority instructions");
  await run("after override added", first.taskId);
  expect(capture().pid).not.toBe(pid);
  pid = capture().pid;
  fs.writeFileSync(instructions, "Shadowed edit");
  await run("after shadowed edit", first.taskId);
  expect(capture().pid).toBe(pid);
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

test("a synchronous RPC input failure rejects promptly and retires the worker", async () => {
  const script = path.resolve(import.meta.dir, "fake-pi.mjs");
  const worker = new RpcWorker(process.execPath, [script, "--session-dir", root], root,
    { ...process.env, OMP_TEST_CAPTURE: undefined }, async () => {}, 5000);
  await worker.ready;
  const input = (worker as any).proc.stdin;
  input.write = () => { throw new Error("secret transport error"); };
  const started = performance.now();
  await expect(worker.prompt("work", undefined, () => {})).rejects.toThrow("Specialist RPC input closed");
  await worker.closed;
  expect(performance.now() - started).toBeLessThan(1000);
  expect((worker as any).pending.size).toBe(0);
  expect(worker.alive).toBe(false);
});

test("an asynchronous RPC input error retires an idle worker", async () => {
  const script = path.resolve(import.meta.dir, "fake-pi.mjs");
  const worker = new RpcWorker(process.execPath, [script, "--session-dir", root], root,
    { ...process.env, OMP_TEST_CAPTURE: undefined }, async () => {}, 5000);
  await worker.ready;
  const started = performance.now();
  (worker as any).proc.stdin.destroy(new Error("secret transport error"));
  await worker.closed;
  expect(performance.now() - started).toBeLessThan(1000);
  expect(worker.alive).toBe(false);
  expect((worker as any).pending.size).toBe(0);
});

test("RPC output pipe failure retires the worker without an uncaught stream error", async () => {
  const script = path.resolve(import.meta.dir, "fake-pi.mjs");
  const worker = new RpcWorker(process.execPath, [script, "--session-dir", root], root,
    { ...process.env, OMP_TEST_CAPTURE: undefined }, async () => {}, 5000);
  try {
    await worker.ready;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const pending = worker.prompt("[delay=1000] work", undefined, event => {
      if (event.type === "agent_start") started();
    });
    await running;
    expect(() => (worker as any).proc.stdout.emit("error", new Error("secret output error"))).not.toThrow();
    await expect(pending).rejects.toThrow("Specialist RPC output closed");
    await worker.closed;
    expect(worker.alive).toBe(false);
    expect((worker as any).pending.size).toBe(0);
  } finally { await worker.stop(); }
});

test("an ended RPC output stream retires the worker before the next request times out", async () => {
  const script = path.resolve(import.meta.dir, "fake-pi.mjs");
  const worker = new RpcWorker(process.execPath, [script, "--session-dir", root], root,
    { ...process.env, OMP_TEST_CAPTURE: undefined }, async () => {}, 5000);
  try {
    await worker.ready;
    (worker as any).proc.stdout.emit("end");
    const closed = await Promise.race([worker.closed.then(() => true), Bun.sleep(500).then(() => false)]);
    expect(closed).toBe(true);
    expect(worker.alive).toBe(false);
  } finally { await worker.stop(); }
});

test("RPC diagnostic pipe failure cannot crash or stop healthy model work", async () => {
  const script = path.resolve(import.meta.dir, "fake-pi.mjs");
  const worker = new RpcWorker(process.execPath, [script, "--session-dir", root], root,
    { ...process.env, OMP_TEST_CAPTURE: undefined }, async () => {}, 5000);
  try {
    await worker.ready;
    expect(() => (worker as any).proc.stderr.emit("error", new Error("secret diagnostic error"))).not.toThrow();
    expect(worker.alive).toBe(true);
    await worker.prompt("work", undefined, () => {});
  } finally { await worker.stop(); }
});

test("malformed but valid JSON on child stdout cannot crash or close a healthy RPC worker", async () => {
  const script = path.resolve(import.meta.dir, "fake-pi.mjs");
  const worker = new RpcWorker(process.execPath, [script, "--session-dir", root], root,
    { ...process.env, OMP_TEST_CAPTURE: undefined }, async () => {}, 5000);
  try {
    await worker.ready;
    expect(() => (worker as any).proc.stdout.emit("data", Buffer.from('null\n[]\n{"type":"response"}\n'))).not.toThrow();
    expect(worker.alive).toBe(true);
    await worker.prompt("work", undefined, () => {});
  } finally { await worker.stop(); }
});

test("an unterminated RPC response cannot satisfy readiness after the child exits", async () => {
  const script = path.join(root, "unterminated-rpc.mjs");
  fs.writeFileSync(script, `
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin });
    input.on("line", line => {
      const command = JSON.parse(line);
      process.stdout.write(JSON.stringify({ type: "response", id: command.id,
        command: command.type, success: true, data: { sessionFile: "uncommitted" } }));
      process.exit(0);
    });
  `);
  const worker = new RpcWorker(process.execPath, [script], root, process.env, async () => {}, 500);
  await expect(worker.ready).rejects.toThrow("Specialist process closed before settlement");
  await worker.closed;
  expect(worker.alive).toBe(false);
});

test("an oversized unterminated RPC line fails promptly without retaining the worker", async () => {
  const script = path.resolve(import.meta.dir, "fake-pi.mjs");
  const worker = new RpcWorker(process.execPath, [script, "--session-dir", root], root,
    { ...process.env, OMP_TEST_CAPTURE: undefined }, async () => {}, 5000);
  try {
    await worker.ready;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const pending = worker.prompt("[delay=1000] work", undefined, event => {
      if (event.type === "agent_start") started();
    });
    await running;
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61);
    (worker as any).proc.stdout.emit("data", oversized);
    await expect(Promise.race([
      pending,
      Bun.sleep(1500).then(() => { throw new Error("RPC line was not rejected"); }),
    ])).rejects.toThrow("Specialist RPC output exceeded the line limit");
    await worker.closed;
    expect(worker.alive).toBe(false);
    expect((worker as any).pending.size).toBe(0);
  } finally { await worker.stop(); }
});

test("fragmented UTF-8 RPC events reach the active task once", async () => {
  const script = path.resolve(import.meta.dir, "fake-pi.mjs");
  const worker = new RpcWorker(process.execPath, [script, "--session-dir", root], root,
    { ...process.env, OMP_TEST_CAPTURE: undefined }, async () => {}, 5000);
  try {
    await worker.ready;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const markers: string[] = [];
    const pending = worker.prompt("[delay=80] work", undefined, event => {
      if (event.type === "agent_start") started();
      if (event.marker) markers.push(event.marker);
    });
    await running;
    const frame = Buffer.from(JSON.stringify({ type: "message_update", marker: "🌕" }) + "\n");
    const split = frame.indexOf(Buffer.from("🌕")) + 1;
    (worker as any).proc.stdout.emit("data", frame.subarray(0, split));
    (worker as any).proc.stdout.emit("data", frame.subarray(split, split + 1));
    (worker as any).proc.stdout.emit("data", frame.subarray(split + 1));
    await pending;
    expect(markers).toEqual(["🌕"]);
  } finally { await worker.stop(); }
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

test("settlement rechecks a transient busy state without another event", async () => {
  const script = path.join(root, "transient-state.mjs");
  fs.writeFileSync(script, `
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin });
    const emit = event => console.log(JSON.stringify(event));
    let checks = 0;
    input.on("line", line => {
      const cmd = JSON.parse(line);
      if (cmd.type === "get_state") {
        checks++;
        emit({ type:"response", id:cmd.id, command:cmd.type, success:true,
          data:{isStreaming:checks === 2, pendingMessageCount:0} });
      } else {
        emit({ type:"response", id:cmd.id, command:cmd.type, success:true });
        if (cmd.type === "prompt") {
          emit({ type:"agent_start" });
          emit({ type:"agent_settled" });
        }
      }
    });
    input.on("close", () => process.exit(0));
  `);
  const worker = new RpcWorker(process.execPath, [script], root, process.env, async () => {}, 300);
  try { await worker.prompt("work", undefined, () => {}); }
  finally { await worker.stop(); }
});

test("a permanently busy state after settlement has a bounded wait", async () => {
  const script = path.join(root, "stuck-state.mjs");
  fs.writeFileSync(script, `
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin });
    const emit = event => console.log(JSON.stringify(event));
    let checks = 0;
    input.on("line", line => {
      const cmd = JSON.parse(line);
      if (cmd.type === "get_state") {
        checks++;
        emit({ type:"response", id:cmd.id, command:cmd.type, success:true,
          data:{isStreaming:checks > 1, pendingMessageCount:0} });
      } else {
        emit({ type:"response", id:cmd.id, command:cmd.type, success:true });
        if (cmd.type === "prompt") {
          emit({ type:"agent_start" });
          emit({ type:"agent_settled" });
        }
      }
    });
    input.on("close", () => process.exit(0));
  `);
  const worker = new RpcWorker(process.execPath, [script], root, process.env, async () => {}, 500, 150);
  try {
    await expect(worker.prompt("work", undefined, () => {})).rejects.toThrow("did not become idle");
    expect(worker.alive).toBe(false);
  } finally { await worker.stop(); }
});
