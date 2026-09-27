import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Assignment } from "./subagents.ts";
import type { RpcWorker } from "./rpc-worker.ts";

export interface TaskSession {
  taskId: string;
  runId: string;
  agent: Assignment["agent"];
  scope: string;
  signature: string;
  sessionDir: string;
  sessionFile?: string;
  busy: boolean;
  worker?: RpcWorker;
  closing?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  finish?: () => void;
}

/** Revision metadata only; credentials never enter task IDs, prompts or recordings. */
export function resourceRevision(cwd: string): string {
  return [
    ...["auth.json", "accounts.json", "models.json", "settings.json"].map(file => path.join(getAgentDir(), file)),
    path.join(cwd, ".pi", "settings.json"),
  ].map(file => {
    try { const stat = fs.statSync(file, { bigint: true }); return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw err; }
  }).join("|");
}

/** Parent-session-scoped task ownership, with bounded retention of idle processes. */
export class TaskSessions {
  private tasks = new Map<string, TaskSession>();
  private idle = new Set<TaskSession>();
  private operations = new Set<Promise<unknown>>();
  private epoch = 0;
  constructor(private readonly idleMs = 120_000, private readonly maxIdle = 4) {}

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => {});
    return operation;
  }

  validate(items: readonly Assignment[], scope: string): void {
    const seen = new Set<string>();
    for (const item of items) {
      if (item.taskId === undefined) continue;
      if (typeof item.taskId !== "string" || !item.taskId) throw new Error("Unknown taskId; provide a returned task ID or omit it");
      if (seen.has(item.taskId)) throw new Error("A task can only appear once in a batch");
      seen.add(item.taskId);
      const task = this.tasks.get(item.taskId);
      if (!task) throw new Error("Unknown taskId; use a task ID returned by this parent session");
      if (task.agent !== item.agent || task.scope !== scope) throw new Error("Task role, directory or trust scope changed; start a new task");
      if (task.busy) throw new Error("Task is still running; wait for its completion before continuing it");
      if (!task.worker?.alive && (!task.sessionFile || !fs.existsSync(task.sessionFile))) {
        throw new Error("Task has no saved session to resume; inspect partial work before starting a new task");
      }
    }
  }

  claim(item: Assignment, scope: string, signature: string): TaskSession {
    this.validate([item], scope);
    const taskId = item.taskId ?? randomUUID();
    let task = this.tasks.get(taskId);
    if (!task) {
      const sessionDir = path.join(getAgentDir(), "omp", "sessions", taskId);
      fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      task = { taskId, runId: "", agent: item.agent, scope, signature, sessionDir, busy: false };
      this.tasks.set(taskId, task);
    }
    if (task.idleTimer) clearTimeout(task.idleTimer);
    this.idle.delete(task);
    if (task.signature !== signature) this.retire(task);
    task.signature = signature;
    task.runId = randomUUID();
    task.busy = true;
    this.track(new Promise<void>(resolve => { task!.finish = resolve; }));
    return task;
  }

  async worker(task: TaskSession, create: (sessionDir: string, sessionFile?: string) => Promise<RpcWorker>): Promise<RpcWorker> {
    const epoch = this.epoch;
    if (task.closing) await task.closing;
    if (epoch !== this.epoch || this.tasks.get(task.taskId) !== task) throw new Error("Specialist tasks cancelled");
    if (task.worker?.alive) return task.worker;
    return this.track(create(task.sessionDir, task.sessionFile).then(async worker => {
      if (epoch !== this.epoch || this.tasks.get(task.taskId) !== task) {
        await worker.stop();
        throw new Error("Specialist tasks cancelled");
      }
      task.worker = worker;
      return worker;
    }));
  }

  release(task: TaskSession): void {
    task.busy = false;
    task.finish?.();
    task.finish = undefined;
    if (task.worker?.sessionFile) task.sessionFile = task.worker.sessionFile;
    if (this.tasks.get(task.taskId) !== task || !task.worker?.alive) return;
    // Council is a one-shot review group; its reviewers have no continuation tool.
    if (task.agent === "council") { this.retire(task); return; }
    this.idle.add(task);
    task.idleTimer = setTimeout(() => this.retire(task), this.idleMs);
    task.idleTimer.unref?.();
    while (this.idle.size > this.maxIdle) this.retire(this.idle.values().next().value!);
  }

  private retire(task: TaskSession): void {
    if (task.idleTimer) clearTimeout(task.idleTimer);
    task.idleTimer = undefined;
    this.idle.delete(task);
    if (task.worker) {
      task.sessionFile = task.worker.sessionFile ?? task.sessionFile;
      task.closing = this.track(task.worker.stop());
      task.worker = undefined;
    }
  }

  async clear(): Promise<void> {
    this.epoch++;
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of tasks) this.retire(task);
    // Repeated shutdown calls must also wait for earlier retirement/launch work.
    while (this.operations.size) await Promise.allSettled([...this.operations]);
  }
}
