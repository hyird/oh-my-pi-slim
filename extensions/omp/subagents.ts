import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readConfig, parseModel, type OmpConfig, type ThinkingLevel } from "./config.ts";
import { ROLES, isRole, type Role } from "./roles.ts";
import { startConversation } from "./transcript.ts";
import { ReplyAccumulator } from "./conversation-content.ts";
import { supportsServiceTier, type ServiceTier } from "./service-tier.ts";
import { availableChildModels } from "./models.ts";

export interface Assignment { agent: Role; task: string; prompt?: string }
export interface Result { agent: Role; model: string; ok: boolean; output: string; usage: Usage; cancelled?: boolean }
export interface AgentProgress {
  agent: Role;
  task: string;
  conversationId?: string;
  /** Incremental, bounded assistant-only preview; present even before the first reply. */
  replyText?: string;
  model?: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  activity: string;
  text: string;
  activities: readonly string[];
  /** Confirmed output token throughput across assistant messages; tool time is excluded. */
  tokensPerSecond?: number;
}
export interface OmpDetails { progress: AgentProgress[]; results?: Result[]; jobId?: string; animationFrame?: number }
const MAX_OUTPUT = 20_000;

export function queuedProgress(items: readonly Assignment[]): AgentProgress[] {
  return items.map(({ agent, task }) => Object.freeze({
    agent, task, state: "queued", activity: "Waiting to run", text: "", activities: Object.freeze([]),
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

export interface ModelSnapshot {
  config: OmpConfig;
  available: ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>;
}
export interface AgentLaunch { model: string; thinking?: ThinkingLevel; serviceTier?: ServiceTier; mcpAdapter?: boolean }

export function resolveLaunches(ctx: ExtensionContext, items: readonly Assignment[], snapshot: ModelSnapshot): ReadonlyMap<Role, AgentLaunch> {
  const launches = new Map<Role, AgentLaunch>();
  for (const { agent } of items) {
    if (launches.has(agent)) continue;
    launches.set(agent, {
      model: resolveModel(ctx, agent, snapshot),
      thinking: agent === "council" ? ctx.thinkingLevel : snapshot.config.thinking[agent] ?? ctx.thinkingLevel,
      serviceTier: snapshot.config.serviceTier?.[agent],
    });
  }
  return launches;
}

export function resolveModel(ctx: ExtensionContext, role: Role, snapshot: ModelSnapshot = { config: readConfig(), available: ctx.modelRegistry.getAvailable() }): string {
  const configured = role === "council" ? undefined : snapshot.config.models[role];
  const model = configured ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  if (!model) throw new Error(role === "council"
    ? "No main-session model to inherit; choose a model with Pi's /model"
    : "No model to inherit; use Pi's /model or configure a specialist model in /omp");
  const parsed = parseModel(model);
  const allowed = configured ? availableChildModels(ctx, snapshot.available) : snapshot.available;
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
  modelOverride?: string | AgentLaunch,
  onActivity?: (snapshot: AgentProgress) => void,
): Promise<Result> {
  const { agent, task } = assignment;
  if (!isRole(agent) || !task.trim()) throw new Error("A valid agent and nonempty task are required");
  if (signal?.aborted) throw new Error("Specialist tasks cancelled");
  const config = typeof modelOverride === "object" ? undefined : readConfig();
  const model = typeof modelOverride === "object" ? modelOverride.model : modelOverride ?? resolveModel(ctx, agent, {
    config: config!, available: ctx.modelRegistry.getAvailable(),
  });
  const thinking = typeof modelOverride === "object" ? modelOverride.thinking
    : agent === "council" ? ctx.thinkingLevel : config!.thinking[agent] ?? ctx.thinkingLevel;
  const tier = typeof modelOverride === "object" ? modelOverride.serviceTier : config?.serviceTier?.[agent];
  const serviceTier = agent !== "council" && supportsServiceTier(parseModel(model)?.provider) ? tier ?? "default" : undefined;
  const cwd = ctx.cwd;
  const projectTrusted = ctx.isProjectTrusted();
  const prompt = assignment.prompt ?? ROLES[agent].prompt;
  const progress: AgentProgress = { agent, task, model, state: "running", activity: "Starting specialist", text: "", replyText: "", activities: Object.freeze([]) };
  const publish = () => {
    // A renderer or UI subscriber must never prevent the child process from settling.
    try { onActivity?.(Object.freeze({ ...progress })); } catch { /* presentation is best-effort */ }
  };
  const report = (activity: string) => {
    progress.activity = activity;
    progress.activities = Object.freeze([...progress.activities.slice(-31), activity]);
    publish();
  };
  const replies = new ReplyAccumulator();
  let failRecording: (() => void) | undefined;
  const conversation = startConversation(agent, task, model, () => failRecording?.());
  progress.conversationId = conversation.id;
  publish();
  let settled = false;
  let tmpDir: string | undefined;
  try {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-omp-"));
    const promptPath = path.join(tmpDir, "role.md");
    await fs.promises.writeFile(promptPath, agent === "librarian" ? `${prompt}\nOnly mcp__context7 and mcp__gh_grep are permitted MCP tools. If either namespace is missing, report that the pi-mcp-adapter must be loaded and its eager metadata initialized; do not use mcp or mcpScript.\n` : prompt, { mode: 0o600 });
    let tools: string[] = [...ROLES[agent].tools];
    // The adapter flag is unavailable in installations without pi-mcp-adapter.
    const mcpPath = agent === "librarian" || (typeof modelOverride === "object" && modelOverride.mcpAdapter)
      ? path.join(tmpDir, "mcp.json") : undefined;
    if (mcpPath) {
      const mcpConfig = librarianMcpConfig();
      await fs.promises.writeFile(mcpPath, JSON.stringify(agent === "librarian" ? mcpConfig : { ...mcpConfig, mcpServers: {} }), { mode: 0o600, flag: "wx" });
    }
    if (agent === "librarian") {
      // Pi ignores unknown --tools names. Require the adapter, and never fall back
      // to the global mcp/mcpScript gateways if namespace metadata is unavailable.
      tools = [...tools, "mcp__context7", "mcp__gh_grep"];
    }
    const args = [
      "--mode", "json", "--print", "--no-session", "--no-themes", "--no-prompt-templates", projectTrusted ? "--approve" : "--no-approve",
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
      let messageStartedAt: number | undefined;
      let completedOutputTokens = 0;
      let completedGenerationMs = 0;
      const updateThroughput = (partialOutput = 0, partialMs = 0) => {
        const output = completedOutputTokens + partialOutput;
        const duration = completedGenerationMs + partialMs;
        progress.tokensPerSecond = output > 0 && duration > 0 ? output * 1000 / duration : undefined;
      };
      if (signal?.aborted) throw new Error("Specialist tasks cancelled");
      const proc = spawn(child.command, child.args, {
        cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_OMP_CHILD: "1", PI_OMP_SERVICE_TIER: serviceTier, PI_MCP_CONFIG_MODE: mcpPath ? "exclusive" : undefined, MCP_DIRECT_TOOLS: undefined },
      });
      const recordFailed = () => {
        error = "Failed to save specialist conversation";
        proc.kill();
      };
      failRecording = recordFailed;
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
        catch {
          recordFailed();
          return;
        }
        try {
          replies.record(event);
          progress.replyText = replies.text();
          if (event.type === "message_start" && event.message?.role === "assistant") {
            messageStartedAt = performance.now();
            return;
          }
          if (event.type === "message_update") {
            const update = event.assistantMessageEvent;
            messageStartedAt ??= performance.now();
            let changed = false;
            const partialOutput = event.usage?.output ?? update?.partial?.usage?.output;
            if (Number.isFinite(partialOutput) && partialOutput > 0) {
              updateThroughput(partialOutput, Math.max(1, performance.now() - messageStartedAt));
              changed = true;
            }
            if (update?.type === "text_delta" && typeof update.delta === "string") {
              streamingText = (streamingText + update.delta).slice(-2000);
              progress.text = streamingText;
              changed = true;
            } else if (update?.type === "text_end" && typeof update.content === "string") {
              progress.text = update.content.slice(-2000);
              changed = true;
            }
            if (changed) publish();
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
          }
          streamingText = "";
          const u = msg.usage;
          if (u) {
            for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += u[key] ?? 0;
            for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += u.cost?.[key] ?? 0;
            if (Number.isFinite(u.output) && u.output > 0 && messageStartedAt !== undefined) {
              completedOutputTokens += u.output;
              completedGenerationMs += Math.max(1, performance.now() - messageStartedAt);
              updateThroughput();
            }
          }
          messageStartedAt = undefined;
          publish();
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
        let ok = !aborted && code === 0 && !error && !!output;
        const failure = aborted ? "Specialist cancelled" : `Specialist run failed (exit code ${code ?? "unknown"})${agent === "librarian" ? "; if MCP namespaces are missing, load pi-mcp-adapter and initialize context7/gh_grep eager metadata (never enable the global gateway)" : ""}`;
        progress.state = ok ? "done" : aborted ? "cancelled" : "failed";
        // Raw stderr and provider errors may contain credentials. JSON events remain in the private recording.
        try { conversation.finish(ok ? "done" : aborted ? "cancelled" : "failed", ok ? undefined : failure); }
        catch { error = "Failed to save specialist conversation"; progress.state = aborted ? "cancelled" : "failed"; ok = false; }
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
  modelOverride?: string | ReadonlyMap<Role, AgentLaunch>,
): Promise<Result[]> {
  const launches = typeof modelOverride === "object" ? modelOverride : undefined;
  const config = launches || signal?.aborted ? undefined : readConfig();
  const snapshot = config && { config, available: modelOverride ? [] : ctx.modelRegistry.getAvailable() };
  const resolved = new Map<Role, AgentLaunch>();
  const launchFor = (agent: Role): AgentLaunch => {
    if (launches) {
      const launch = launches.get(agent);
      if (!launch) throw new Error("Missing launch settings for " + agent);
      return launch;
    }
    let launch = resolved.get(agent);
    if (!launch) {
      launch = { model: typeof modelOverride === "string" ? modelOverride : resolveModel(ctx, agent, snapshot!),
        thinking: agent === "council" ? ctx.thinkingLevel : config!.thinking[agent] ?? ctx.thinkingLevel,
        serviceTier: config!.serviceTier?.[agent] };
      resolved.set(agent, launch);
    }
    return launch;
  };
  const results = new Array<Result>(items.length);
  const progress = queuedProgress(items);
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
    // Rows and activity lists are immutable snapshots. Copy only the outer
    // ordering array; unchanged agents retain their existing row identities.
    try { onProgress(progress.slice()); }
    catch { /* presentation is best-effort; keep supervising children */ }
  };
  publish(true);
  try {
    await Promise.all(items.map(async (item, index) => {
      try {
        if (signal?.aborted) throw new Error("Specialist tasks cancelled");
        results[index] = await runAgent(ctx, item, signal, launchFor(item.agent), (snapshot) => {
          const important = snapshot.activities !== progress[index].activities || snapshot.state !== progress[index].state;
          progress[index] = snapshot;
          publish(important);
        });
      } catch (err) {
        results[index] = {
          agent: item.agent, model: launches?.get(item.agent)?.model ?? resolved.get(item.agent)?.model ?? (typeof modelOverride === "string" ? modelOverride : "inherit"), ok: false, cancelled: signal?.aborted,
          output: signal?.aborted ? "Specialist cancelled" : err instanceof Error ? err.message : String(err), usage: emptyUsage(),
        };
      }
      const completed: AgentProgress = {
        ...progress[index], model: results[index].model, state: results[index].ok ? "done" : results[index].cancelled ? "cancelled" : "failed",
        activity: results[index].ok ? "Work completed" : results[index].cancelled ? "Cancelled" : "Run failed",
        text: results[index].ok ? results[index].output.slice(-2000) : progress[index].text,
      };
      const previous = progress[index];
      if (completed.model !== previous.model || completed.state !== previous.state ||
          completed.activity !== previous.activity || completed.text !== previous.text) {
        progress[index] = Object.freeze(completed);
        publish(true);
      }
    }));
    return results;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function formatResults(results: Result[]): string {
  return results.map((result) => `${result.ok ? "OK" : result.cancelled ? "CANCELLED" : "FAILED"} ${result.agent} [${result.model}]\n${result.output}`).join("\n\n---\n\n");
}
