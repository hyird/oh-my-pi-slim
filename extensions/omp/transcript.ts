import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRole, type Role } from "./roles.ts";

export interface ConversationMeta {
  id: string;
  delegationId?: string;
  agent: Role;
  task: string;
  model: string;
  state: "running" | "done" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}
export interface Conversation { meta: ConversationMeta; events: any[] }

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let lastNotify = 0;
function notify(force = false) {
  if (!listeners.size) return;
  const delay = 100 - (Date.now() - lastNotify);
  if (!force && delay > 0) {
    timer ??= setTimeout(() => { timer = undefined; notify(true); }, delay);
    return;
  }
  if (timer) clearTimeout(timer);
  timer = undefined;
  lastNotify = Date.now();
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* Viewers cannot disrupt recording. */ }
  }
}

export function subscribeConversations(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) { clearTimeout(timer); timer = undefined; }
  };
}

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
// remain readable, but are not retained by the viewer cache.
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

function readRegularFile(file: string): string | undefined {
  const before = fs.lstatSync(file);
  if (!before.isFile()) return undefined;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    // Also guard platforms where O_NOFOLLOW is unavailable or ignored.
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return undefined;
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

function writeMeta(dir: string, meta: ConversationMeta) {
  const target = path.join(dir, `${meta.id}.meta.json`);
  const temp = path.join(dir, `${meta.id}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    try {
      fs.fchmodSync(fd, 0o600);
      append(fd, meta);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, target);
  } finally {
    try { fs.unlinkSync(temp); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
}

function append(fd: number, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  for (let offset = 0; offset < bytes.length;) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!written) throw new Error("Conversation write made no progress");
    offset += written;
  }
}

/** Record only parsed, child-visible JSON events; never copy the child environment or stderr. */
export function startConversation(agent: Role, task: string, model: string, delegationId?: string) {
  const meta: ConversationMeta = { id: randomUUID(), ...(delegationId !== undefined ? { delegationId } : {}), agent, task, model, state: "running", startedAt: Date.now() };
  const dir = ensureDirectory();
  const file = path.join(dir, `${meta.id}.jsonl`);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { append(fd, { type: "meta", meta }); writeMeta(dir, meta); }
  catch (err) { fs.closeSync(fd); fs.unlinkSync(file); throw err; }
  notify(true);
  let finished = false;
  return {
    id: meta.id,
    record(event: any) {
      if (finished) return;
      append(fd, { type: "event", event });
      notify();
    },
    finish(state: "done" | "failed" | "cancelled", error?: string) {
      if (finished) return;
      finished = true;
      meta.state = state;
      meta.finishedAt = Date.now();
      if (error) meta.error = error;
      try {
        append(fd, { type: "completion", state, finishedAt: meta.finishedAt, ...(error ? { error } : {}) });
        writeMeta(dir, meta);
      } finally { fs.closeSync(fd); notify(true); }
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

export function listConversations(): ConversationMeta[] {
  let names: string[];
  try { names = fs.readdirSync(directory()); } catch { return []; }
  const present = new Set(names);
  return names.filter((name) => name.endsWith(".jsonl") && validId(name.slice(0, -6)))
    .map((name) => {
      const id = name.slice(0, -6);
      const sidecar = `${id}.meta.json`;
      if (!present.has(sidecar)) return getConversation(id)?.meta; // Pre-sidecar recordings.
      try {
        const body = readRegularFile(path.join(directory(), sidecar));
        if (body === undefined) return undefined;
        const meta = JSON.parse(body) as ConversationMeta;
        return meta.id === id && isRole(meta.agent) &&
          (meta.state === "running" || meta.state === "done" || meta.state === "failed" || meta.state === "cancelled") &&
          typeof meta.startedAt === "number" ? meta : undefined;
      } catch { return undefined; }
    })
    .filter((meta): meta is ConversationMeta => !!meta)
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
}
