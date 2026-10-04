import { createHash, randomUUID } from "node:crypto";
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
  discardRecordings: Set<() => void>;
}

export type SavedTaskSession = Pick<TaskSession, "taskId" | "agent" | "scope" | "sessionFile">;

function statRevision(file: string): string {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
}
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

// Pi reads the first context file in this order from the agent directory and
// each project ancestor. A warm RPC worker has already loaded its prompt.
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
function contextRevision(dir: string): string {
  for (const name of CONTEXT_FILES) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file, { bigint: true });
      if (stat.isFile()) return `${name}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
      /* Pi skips unreadable context candidates and tries the next name. */
    }
  }
  return "missing";
}

function projectContextRevision(cwd: string, agentDir: string): string {
  const revisions = [`${agentDir}:${contextRevision(agentDir)}`];
  let dir = path.resolve(cwd);
  while (true) {
    if (dir !== agentDir) revisions.push(`${dir}:${contextRevision(dir)}`);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return revisions.join("|");
}

let cachedAuth: { path: string; stamp: string; revision: string; readAt: number } | undefined;
function authRevision(file: string): string {
  const stamp = statRevision(file);
  if (stamp === "missing") return stamp;
  if (
    cachedAuth?.path === file &&
    cachedAuth.stamp === stamp &&
    performance.now() - cachedAuth.readAt < 60_000
  )
    return cachedAuth.revision;
  let revision = stamp;
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && typeof data === "object" && !Array.isArray(data))
      revision = createHash("sha256").update(stableJson(data)).digest("hex");
  } catch {
    /* Unreadable or invalid auth must restart the child. */
  }
  cachedAuth = { path: file, stamp, revision, readAt: performance.now() };
  return revision;
}

let cachedAccounts: { path: string; stamp: string; revision: string; readAt: number } | undefined;
function accountsRevision(file: string): string {
  const stamp = statRevision(file);
  if (stamp === "missing") return stamp;
  if (
    cachedAccounts?.path === file &&
    cachedAccounts.stamp === stamp &&
    performance.now() - cachedAccounts.readAt < 60_000
  )
    return cachedAccounts.revision;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
  let revision = stamp;
  try {
    const data: unknown = JSON.parse(raw);
    if (
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      (data as { version?: unknown }).version === 1 &&
      Array.isArray((data as { accounts?: unknown }).accounts)
    ) {
      const pool = data as { accounts: unknown[] };
      const accounts = pool.accounts.map((account) => {
        if (!account || typeof account !== "object" || Array.isArray(account))
          throw new Error("Invalid account");
        const item = account as Record<string, unknown>;
        if (
          typeof item.provider !== "string" ||
          typeof item.name !== "string" ||
          !item.credential ||
          typeof item.credential !== "object" ||
          Array.isArray(item.credential)
        )
          throw new Error("Invalid account");
        const { email: _email, name: _name, ...relevant } = item;
        return relevant;
      });
      // Display metadata and JSON key order do not change child authentication.
      // Restart only for semantic credential or account-pool changes.
      revision = createHash("sha256")
        .update(stableJson({ ...data, accounts }))
        .digest("hex");
    }
  } catch {
    /* Invalid pools use the file stamp so every replacement restarts the worker. */
  }
  cachedAccounts = { path: file, stamp, revision, readAt: performance.now() };
  return revision;
}

/** Revision metadata only; credentials never enter task IDs, prompts or recordings. */
export function resourceRevision(cwd: string): string {
  const agentDir = getAgentDir();
  const accountsPath = path.join(agentDir, "accounts.json");
  return [
    authRevision(path.join(agentDir, "auth.json")),
    ...["models.json", "settings.json"].map((file) => statRevision(path.join(agentDir, file))),
    statRevision(path.join(cwd, ".pi", "settings.json")),
    accountsRevision(accountsPath),
    projectContextRevision(cwd, agentDir),
  ].join("|");
}

/** Parent-session-scoped task ownership, with bounded retention of idle processes. */
export class TaskSessions {
  private tasks = new Map<string, TaskSession>();
  private idle = new Set<TaskSession>();
  private operations = new Set<Promise<unknown>>();
  private cleanups = new Set<Promise<void>>();
  private epoch = 0;
  constructor(
    private readonly idleMs = 120_000,
    private readonly maxIdle = 4,
  ) {}

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => {});
    return operation;
  }

  validate(items: readonly Assignment[], scope: string): void {
    const seen = new Set<string>();
    for (const item of items) {
      if (item.taskId === undefined) continue;
      if (typeof item.taskId !== "string" || !item.taskId)
        throw new Error("Unknown taskId; provide a returned task ID or omit it");
      if (seen.has(item.taskId)) throw new Error("A task can only appear once in a batch");
      seen.add(item.taskId);
      const task = this.tasks.get(item.taskId);
      if (!task) throw new Error("Unknown taskId; use a task ID returned by this parent session");
      if (task.agent !== item.agent || task.scope !== scope)
        throw new Error("Task role, directory or trust scope changed; start a new task");
      if (task.busy)
        throw new Error(
          "Task is still running; wait for its completion before continuing it. No new prompt was sent. Keep added requirements in the parent conversation; do not cancel or duplicate this task merely to add them.",
        );
      if (!task.worker?.alive && (!task.sessionFile || !fs.existsSync(task.sessionFile))) {
        throw new Error(
          "Task has no saved session to resume; inspect partial work before starting a new task",
        );
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
      task = {
        taskId, runId: "", agent: item.agent, scope, signature, sessionDir,
        busy: false, discardRecordings: new Set(),
      };
      this.tasks.set(taskId, task);
    }
    if (task.idleTimer) clearTimeout(task.idleTimer);
    this.idle.delete(task);
    if (task.signature !== signature) this.retire(task);
    task.signature = signature;
    task.runId = randomUUID();
    task.busy = true;
    this.track(
      new Promise<void>((resolve) => {
        task!.finish = resolve;
      }),
    );
    return task;
  }

  async worker(
    task: TaskSession,
    create: (sessionDir: string, sessionFile?: string) => Promise<RpcWorker>,
  ): Promise<RpcWorker> {
    const epoch = this.epoch;
    if (task.closing) await task.closing;
    if (epoch !== this.epoch || this.tasks.get(task.taskId) !== task)
      throw new Error("Specialist tasks cancelled");
    if (task.worker?.alive) return task.worker;
    return this.track(
      create(task.sessionDir, task.sessionFile).then(async (worker) => {
        if (epoch !== this.epoch || this.tasks.get(task.taskId) !== task) {
          await worker.stop();
          throw new Error("Specialist tasks cancelled");
        }
        task.worker = worker;
        return worker;
      }),
    );
  }

  release(task: TaskSession): void {
    task.busy = false;
    task.finish?.();
    task.finish = undefined;
    if (task.worker?.sessionFile) task.sessionFile = task.worker.sessionFile;
    if (this.tasks.get(task.taskId) !== task || !task.worker?.alive) return;
    // Council is a one-shot review group; its reviewers have no continuation tool.
    if (task.agent === "council") {
      this.retire(task);
      return;
    }
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

  clear({ discard = false }: { discard?: boolean } = {}): Promise<void> {
    this.epoch++;
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of tasks) this.retire(task);
    // Snapshot this generation: shutdown must wait for its launches, recordings
    // and prior cleanups, not for unrelated work started in a new session.
    const pending = [...this.operations, ...this.cleanups];
    const cleanup = Promise.allSettled(pending).then(async () => {
      if (!discard) return;
      // Workers/recorders have closed before removal, so they cannot recreate
      // these files. Remove only paths owned by this registry, never the shared
      // OMP root (other Pi instances and older recordings may live there).
      const results = await Promise.allSettled(tasks.flatMap((task) => [
        fs.promises.rm(task.sessionDir, { recursive: true, force: true }),
        ...[...task.discardRecordings].map(async (remove) => remove()),
      ]));
      const errors = results.filter((result) => result.status === "rejected");
      if (errors.length)
        throw new AggregateError(errors.map((result) => result.reason), "OMP session cleanup failed");
    });
    this.cleanups.add(cleanup);
    void cleanup.finally(() => this.cleanups.delete(cleanup)).catch(() => {});
    return cleanup;
  }
}
