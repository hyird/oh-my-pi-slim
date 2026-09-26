import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRole, type Role } from "./roles.ts";

export interface ConversationMeta {
  id: string;
  agent: Role;
  task: string;
  model: string;
  state: "running" | "done" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}
export interface Conversation { meta: ConversationMeta; events: any[] }

function directory(): string {
  return path.join(getAgentDir(), "omp", "conversations");
}
function ensureDirectory(): string {
  const dir = directory();
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(parent).isDirectory()) throw new Error("Conversation parent is not a directory");
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  if (!fs.lstatSync(dir).isDirectory()) throw new Error("Conversation directory is not a directory");
  fs.chmodSync(dir, 0o700);
  return dir;
}
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

// Bound both the number of recordings and their estimated parsed size. Oversized logs
// remain readable, but are not retained by the task-card cache.
const cacheLimit = 8;
const cacheBudget = 64 * 1024 * 1024;
const conversationCache = new Map<string, { revision: fs.BigIntStats; value: Conversation; cost: number }>();
let cacheSize = 0;
function sameRevision(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function evict(file: string) {
  const old = conversationCache.get(file);
  if (old) { cacheSize -= old.cost; conversationCache.delete(file); }
}

function append(fd: number, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length;) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!written) throw new Error("Conversation write made no progress");
    offset += written;
  }
}

/** Record only parsed, child-visible JSON events; never copy the child environment or stderr. */
export function startConversation(agent: Role, task: string, model: string, onError?: () => void) {
  const meta: ConversationMeta = { id: randomUUID(), agent, task, model, state: "running", startedAt: Date.now() };
  const dir = ensureDirectory();
  const file = path.join(dir, `${meta.id}.jsonl`);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { append(fd, Buffer.from(JSON.stringify({ type: "meta", meta }) + "\n")); }
  catch (err) { fs.closeSync(fd); fs.unlinkSync(file); throw err; }
  let finished = false;
  let pending: string[] = [];
  let pendingBytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: unknown;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (failure) throw failure;
    if (!pending.length) return;
    const bytes = Buffer.from(pending.join(""));
    pending = [];
    pendingBytes = 0;
    try { append(fd, bytes); }
    catch (err) { failure = err; throw err; }
  };
  const enqueue = (value: unknown) => {
    const line = JSON.stringify(value) + "\n";
    pending.push(line);
    pendingBytes += Buffer.byteLength(line);
  };
  return {
    id: meta.id,
    flush,
    record(event: any) {
      if (finished) return;
      if (failure) throw failure;
      enqueue({ type: "event", event });
      // Bound both live-log latency and buffered memory. Keep complete JSONL
      // records, including tools and thinking, in their original order.
      if (pendingBytes >= 64 * 1024) flush();
      else {
        timer ??= setTimeout(() => {
          try { flush(); }
          catch {
            // Surface timer failures to the process supervisor, never as an
            // uncaught timer exception. record/finish also retain the failure.
            try { onError?.(); } catch { /* finish still reports the write failure */ }
          }
        }, 100);
        timer.unref?.();
      }
    },
    finish(state: "done" | "failed" | "cancelled", error?: string) {
      if (finished) return;
      finished = true;
      meta.state = state;
      meta.finishedAt = Date.now();
      if (error) meta.error = error;
      try {
        enqueue({ type: "completion", state, finishedAt: meta.finishedAt, ...(error ? { error } : {}) });
        flush();
      } finally { fs.closeSync(fd); }
    },
  };
}

export function getConversation(id: string): Conversation | undefined {
  if (!validId(id)) return undefined;
  const file = path.resolve(directory(), `${id}.jsonl`);
  try {
    // Open and verify even on a hit: neither a replaced file nor a symlink may
    // inherit a previous recording's cached value.
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile()) { evict(file); return undefined; }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let body: string;
    let revision: fs.BigIntStats;
    let stable: boolean;
    try {
      revision = fs.fstatSync(fd, { bigint: true });
      if (!revision.isFile() || !sameRevision(before, revision)) { evict(file); return undefined; }
      const cached = conversationCache.get(file);
      if (cached && sameRevision(cached.revision, revision) &&
          sameRevision(revision, fs.lstatSync(file, { bigint: true }))) {
        conversationCache.delete(file);
        conversationCache.set(file, cached); // LRU touch
        return structuredClone(cached.value);
      }
      evict(file);
      body = fs.readFileSync(fd, "utf8");
      stable = sameRevision(revision, fs.fstatSync(fd, { bigint: true }));
    } finally { fs.closeSync(fd); }
    // A rename or append during the read must never seed the cache.
    stable = stable && sameRevision(revision, fs.lstatSync(file, { bigint: true }));
    const lines = body.split("\n");
    const first = JSON.parse(lines.shift() ?? "");
    if (first.type !== "meta" || first.meta?.id !== id || !isRole(first.meta.agent)) return undefined;
    const meta = first.meta as ConversationMeta;
    const events: any[] = [];
    for (const line of lines) {
      if (!line) continue;
      let event: any;
      try { event = JSON.parse(line); } catch { continue; } // Incomplete last write during a live read.
      if (event.type === "completion") {
        meta.state = event.state;
        meta.finishedAt = event.finishedAt;
        if (event.error) meta.error = event.error;
      } else if (event.type === "event") events.push(event.event);
    }
    const result = { meta, events };
    const cost = Number(revision.size) * 4 + 4096;
    if (stable && cost <= cacheBudget) {
      while (conversationCache.size >= cacheLimit || cacheSize + cost > cacheBudget) {
        evict(conversationCache.keys().next().value!);
      }
      conversationCache.set(file, { revision, value: structuredClone(result), cost });
      cacheSize += cost;
    }
    return result;
  } catch { evict(file); return undefined; }
}
