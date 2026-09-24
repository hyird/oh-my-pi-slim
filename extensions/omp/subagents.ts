import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readConfig, parseModel } from "./config.ts";
import { ROLES, isRole, type Role } from "./roles.ts";
import { startConversation } from "./transcript.ts";
import { availableChildModels } from "./models.ts";

export interface Assignment { agent: Role; task: string; prompt?: string }
export interface Result { agent: Role; model: string; ok: boolean; output: string; usage: Usage; cancelled?: boolean }
export interface AgentProgress {
  agent: Role;
  task: string;
  conversationId?: string;
  model?: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  activity: string;
  text: string;
  activities: string[];
}
export interface OmpDetails { progress: AgentProgress[]; results?: Result[]; jobId?: string; animationFrame?: number }
const MAX_OUTPUT = 20_000;
const MAX_CONCURRENT_CHILDREN = 3;
let activeChildren = 0;
const waitingChildren: Array<{
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}> = [];

function releaseChildSlot(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeChildren--;
    while (activeChildren < MAX_CONCURRENT_CHILDREN && waitingChildren.length) {
      const next = waitingChildren.shift()!;
      next.signal?.removeEventListener("abort", next.onAbort);
      if (next.signal?.aborted) {
        next.reject(new Error("Specialist tasks cancelled"));
        continue;
      }
      activeChildren++;
      next.resolve(releaseChildSlot());
    }
  };
}

function acquireChildSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(new Error("Specialist tasks cancelled"));
  if (activeChildren < MAX_CONCURRENT_CHILDREN && waitingChildren.length === 0) {
    activeChildren++;
    return Promise.resolve(releaseChildSlot());
  }
  return new Promise((resolve, reject) => {
    const entry = {
      signal, resolve, reject,
      onAbort: () => {
        const index = waitingChildren.indexOf(entry);
        if (index >= 0) waitingChildren.splice(index, 1);
        signal?.removeEventListener("abort", entry.onAbort);
        reject(new Error("Specialist tasks cancelled"));
      },
    };
    waitingChildren.push(entry);
    signal?.addEventListener("abort", entry.onAbort, { once: true });
  });
}

export function queuedProgress(items: readonly Assignment[]): AgentProgress[] {
  return items.map(({ agent, task }) => ({
    agent, task, state: "queued", activity: "Waiting to run", text: "", activities: [],
  }));
}

/** Only the two public upstream endpoints; no inherited imports or credentials. */
export function librarianMcpConfig() {
  return {
    mcpServers: {
      context7: { url: "https://mcp.context7.com/mcp", lifecycle: "eager" },
      gh_grep: { url: "https://mcp.grep.app", lifecycle: "eager" },
    },
    settings: {
      namespaceProxyTools: true, directTools: false, scriptMode: false,
      allowInstall: false, exposeResources: false,
    },
  };
}

const emptyUsage = (): Usage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function sumUsage(results: Result[], additional?: Usage): Usage {
  const usage = emptyUsage();
  for (const source of [...results.map((result) => result.usage), ...(additional ? [additional] : [])]) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += source[key];
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += source.cost[key];
  }
  return usage;
}

export function resolveModel(ctx: ExtensionContext, role: Role): string {
  const configured = role === "council" ? undefined : readConfig().models[role];
  const model = configured ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  if (!model) throw new Error(role === "council"
    ? "No main-session model to inherit; choose a model with Pi's /model"
    : "No model to inherit; use Pi's /model or configure a specialist model in /omp");
  const parsed = parseModel(model);
  const allowed = configured ? availableChildModels(ctx) : ctx.modelRegistry.getAvailable();
  if (!parsed || !allowed.some((item) => item.provider === parsed.provider && item.id === parsed.id)) {
    throw new Error(role === "council"
      ? `Main-session model ${model} is unavailable; check /model and authentication`
      : `Model ${model} is not enabled or available; check /scoped-models, authentication, and the ${role} model setting in /omp`);
  }
  return model;
}

function invocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  if (!/^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

// Keep each specialist in a separate process/context. Allow trusted personal extensions
// (including custom model providers), but suppress OMP recursively via PI_OMP_CHILD.
// Never grant project trust that the parent did not already have.
export async function runAgent(
  ctx: ExtensionContext, assignment: Assignment, signal?: AbortSignal,
  modelOverride?: string,
  onActivity?: (snapshot: AgentProgress) => void,
  delegationId?: string,
): Promise<Result> {
  const { agent, task } = assignment;
  if (!isRole(agent) || !task.trim()) throw new Error("A valid agent and nonempty task are required");
  const model = modelOverride ?? resolveModel(ctx, agent);
  const thinking = agent === "council" ? ctx.thinkingLevel : readConfig().thinking[agent] ?? ctx.thinkingLevel;
  const prompt = assignment.prompt ?? ROLES[agent].prompt;
  const progress: AgentProgress = { agent, task, model, state: "running", activity: "Starting specialist", text: "", activities: [] };
  const publish = () => {
    // A renderer or UI subscriber must never prevent the child process from settling.
    try { onActivity?.({ ...progress, activities: [...progress.activities] }); } catch { /* presentation is best-effort */ }
  };
  const report = (activity: string) => {
    progress.activity = activity;
    progress.activities.push(activity);
    if (progress.activities.length > 32) progress.activities.shift();
    publish();
  };
  publish();
  const conversation = startConversation(agent, task, model, delegationId);
  progress.conversationId = conversation.id;
  publish();
  let settled = false;
  let tmpDir: string | undefined;
  try {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-omp-"));
    const promptPath = path.join(tmpDir, "role.md");
    await fs.promises.writeFile(promptPath, agent === "librarian" ? `${prompt}\nOnly mcp__context7 and mcp__gh_grep are permitted MCP tools. If either namespace is missing, report that the pi-mcp-adapter must be loaded and its eager metadata initialized; do not use mcp or mcpScript.\n` : prompt, { mode: 0o600 });
    let tools: string[] = [...ROLES[agent].tools];
    let mcpPath: string | undefined;
    if (agent === "librarian") {
      // Pi ignores unknown --tools names. Require the adapter, and never fall back
      // to the global mcp/mcpScript gateways if namespace metadata is unavailable.
      mcpPath = path.join(tmpDir, "mcp.json");
      await fs.promises.writeFile(mcpPath, JSON.stringify(librarianMcpConfig()), { mode: 0o600, flag: "wx" });
      tools = [...tools, "mcp__context7", "mcp__gh_grep"];
    }
    const args = [
      "--mode", "json", "--print", "--no-session", ctx.isProjectTrusted() ? "--approve" : "--no-approve",
      "--model", model, ...(thinking ? ["--thinking", thinking] : []), "--tools", tools.join(","),
      ...(mcpPath ? ["--mcp-config", mcpPath] : []),
      // End flag parsing; a leading @ is treated as a file even after --, so add a newline.
      "--append-system-prompt", promptPath, "--", task.startsWith("@") ? `\n${task}` : task,
    ];
    const child = invocation(args);
    return await new Promise<Result>((resolve) => {
      let output = "";
      let error = "";
      let buffer = "";
      const decoder = new StringDecoder("utf8");
      let aborted = false;
      let exited = false;
      const usage = emptyUsage();
      let streamingText = "";
      const proc = spawn(child.command, child.args, {
        cwd: ctx.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_OMP_CHILD: "1", ...(mcpPath ? { PI_MCP_CONFIG_MODE: "exclusive" } : {}), MCP_DIRECT_TOOLS: undefined },
      });
      const onAbort = () => {
        aborted = true;
        proc.kill();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      const consume = (line: string) => {
        let event: any;
        try { event = JSON.parse(line); } catch { return; }
        try { conversation.record(event); }
        catch (err) {
          error = err instanceof Error ? err.message : String(err);
          proc.kill();
          return;
        }
        try {
          if (event.type === "message_update") {
            const update = event.assistantMessageEvent;
            if (update?.type === "text_delta" && typeof update.delta === "string") {
              streamingText = (streamingText + update.delta).slice(-2000);
              progress.text = streamingText;
              publish();
            } else if (update?.type === "text_end" && typeof update.content === "string") {
              progress.text = update.content.slice(-2000);
              publish();
            }
            return;
          }
          if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
            const tool = event.toolName.slice(0, 50);
            const args = event.args && typeof event.args === "object" ? event.args : {};
            const location = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
            // Shell commands can contain credentials; show tool use but never dump command arguments.
            report(location ? `${tool} ${location.slice(0, 100)}` : `${tool} running`);
            return;
          }
          if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
            report(`${event.toolName.slice(0, 50)} ${event.isError ? "failed" : "completed"}`);
            return;
          }
          if (event.type !== "message_end" || event.message?.role !== "assistant") return;
          const msg = event.message;
          if (msg.stopReason === "error" || msg.stopReason === "aborted") error = msg.errorMessage || msg.stopReason;
          const text = msg.content?.filter((part: { type: string }) => part.type === "text")
            .map((part: { text: string }) => part.text).join("\n");
          if (text) {
            output = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[output truncated]` : text;
            progress.text = text.slice(-2000);
            publish();
          }
          streamingText = "";
          const u = msg.usage;
          if (u) {
            for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += u[key] ?? 0;
            for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += u.cost?.[key] ?? 0;
          }
        } catch { /* Ignore non-JSON lines from unexpected provider output. */ }
      };
      proc.stdout?.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          consume(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
      });
      // Drain stderr but do not relay it: provider diagnostics can include credentials.
      proc.stderr?.resume();
      proc.on("error", () => { error = "Failed to launch specialist process"; });
      proc.on("close", (code) => {
        if (exited) return;
        exited = true;
        signal?.removeEventListener("abort", onAbort);
        buffer += decoder.end();
        if (buffer) consume(buffer);
        const ok = !aborted && code === 0 && !error && !!output;
        const failure = aborted ? "Specialist cancelled" : `Specialist run failed (exit code ${code ?? "unknown"}); inspect the local conversation viewer${agent === "librarian" ? "; if MCP namespaces are missing, load pi-mcp-adapter and initialize context7/gh_grep eager metadata (never enable the global gateway)" : ""}`;
        progress.state = ok ? "done" : aborted ? "cancelled" : "failed";
        // Raw stderr and provider errors may contain credentials. JSON events remain in the private recording.
        try { conversation.finish(ok ? "done" : aborted ? "cancelled" : "failed", ok ? undefined : failure); }
        catch { error = "Failed to save specialist conversation"; progress.state = "failed"; }
        settled = true;
        report(ok ? "Work completed" : aborted ? "Cancelled" : "Run failed");
        resolve({ agent, model, ok: ok && !error, cancelled: aborted, output: ok && !error ? output : (error === "Failed to save specialist conversation" ? error : failure), usage });
      });
    });
  } catch (err) {
    if (!settled) conversation.finish(signal?.aborted ? "cancelled" : "failed", err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function runAssignments(
  ctx: ExtensionContext, items: Assignment[], signal?: AbortSignal,
  onProgress?: (snapshot: AgentProgress[]) => void,
  modelOverride?: string,
  delegationId?: string,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  const progress = queuedProgress(items);
  let next = 0;
  let lastPublished = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastPublished < 120) {
      timer ??= setTimeout(() => { timer = undefined; publish(true); }, 120 - (now - lastPublished));
      return;
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    lastPublished = now;
    try { onProgress(progress.map((item) => ({ ...item, activities: [...item.activities] }))); }
    catch { /* presentation is best-effort; keep supervising children */ }
  };
  publish(true);
  try {
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
      while (next < items.length && !signal?.aborted) {
        const index = next++;
        let release: (() => void) | undefined;
        try {
          release = await acquireChildSlot(signal);
          progress[index] = { ...progress[index], state: "running", activity: "Starting" };
          publish(true);
          results[index] = await runAgent(ctx, items[index], signal, modelOverride, (snapshot) => {
            const important = snapshot.activities.length !== progress[index].activities.length || snapshot.state !== progress[index].state;
            progress[index] = snapshot;
            publish(important);
          }, delegationId);
        } catch (err) {
          results[index] = {
            agent: items[index].agent, model: modelOverride ?? "inherit", ok: false, cancelled: signal?.aborted,
            output: signal?.aborted ? "Specialist cancelled" : err instanceof Error ? err.message : String(err), usage: emptyUsage(),
          };
        } finally {
          release?.();
        }
        progress[index] = {
          ...progress[index], model: results[index].model, state: results[index].ok ? "done" : results[index].cancelled ? "cancelled" : "failed",
          activity: results[index].ok ? "Work completed" : results[index].cancelled ? "Cancelled" : "Run failed",
          text: results[index].ok ? results[index].output.slice(-2000) : progress[index].text,
        };
        publish(true);
      }
    }));
    if (signal?.aborted) {
      for (let index = 0; index < items.length; index++) {
        if (results[index]) continue;
        results[index] = {
          agent: items[index].agent, model: modelOverride ?? "inherit", ok: false,
          cancelled: true, output: "Specialist cancelled before starting", usage: emptyUsage(),
        };
        progress[index] = { ...progress[index], state: "cancelled", activity: "Cancelled" };
      }
      publish(true);
    }
    return results;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function formatResults(results: Result[]): string {
  return results.map((result) => `${result.ok ? "OK" : result.cancelled ? "CANCELLED" : "FAILED"} ${result.agent} [${result.model}]\n${result.output}`).join("\n\n---\n\n");
}
