import { randomUUID } from "node:crypto";
import { getAgentDir, type AgentToolResult, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container } from "@earendil-works/pi-tui";
import { configPath, isThinkingLevel, parseModel, readConfig, updateConfig } from "./config.ts";
import { ROLES, ROLE_NAMES, isMainAgent, isRole, type MainAgent, type Role } from "./roles.ts";
import { showSettingsUi, INHERIT, INHERIT_THINKING, parseRoleSettingValue } from "./settings-ui.ts";
import { formatResults, queuedProgress, resolveModel, runAssignments, type AgentProgress, type Assignment, type OmpDetails, type Result } from "./subagents.ts";
import { OMP_SPINNER_FRAMES, renderPinnedOmpCard, renderOmpToolCall, renderOmpToolResult, type OmpRenderState } from "./render.ts";
import { prepareAssignments } from "./language.ts";
import { installMcpPolicy } from "./mcp-policy.ts";
import { availableChildModels } from "./models.ts";

const COUNCIL_PERSPECTIVES = [
  "Find failure modes, safety issues, and counterexamples.",
  "Assess architecture, feasibility, and maintenance trade-offs.",
  "Find the simplest acceptable option and evaluate opportunity cost.",
];
const councilAssignments = (question: string): Assignment[] =>
  COUNCIL_PERSPECTIVES.map((perspective) => ({ agent: "council", task: `${perspective}\n\nDecision: ${question}` }));

type BackgroundJob = {
  id: string;
  kind: "delegate" | "council";
  session: number;
  state: "running" | "done" | "failed" | "cancelled";
  progress: AgentProgress[];
  results?: Result[];
  controller: AbortController;
  invalidators: Map<string, () => void>;
  pinnedState: OmpRenderState;
  animationFrame: number;
  animationTimer?: ReturnType<typeof setInterval>;
};

type OmpRuntime = {
  session: number;
  jobs: Map<string, BackgroundJob>;
  pi?: ExtensionAPI;
  ctx?: ExtensionContext;
  reloading: boolean;
  pending: Array<{ session: number; content: string; attempts: number }>;
  contextWaiters: Set<(ctx: ExtensionContext) => void>;
};

// Pi reloads extension modules in the same process. Keep live child jobs outside
// the old module instance so the new extension can adopt their cards and results.
const RUNTIME_KEY = Symbol.for("@hyird/oh-my-pi-slim/live-runtime");
const runtimeHost = globalThis as unknown as Record<symbol, Map<string, OmpRuntime> | undefined>;
const runtimes = runtimeHost[RUNTIME_KEY] ??= new Map<string, OmpRuntime>();

export default function omp(pi: ExtensionAPI) {
  // Child sessions need personal provider extensions but must not register OMP again.
  if (process.env.PI_OMP_CHILD === "1") return;
  let role: MainAgent = "orchestrator";
  const runtimeKey = getAgentDir();
  const runtime: OmpRuntime = runtimes.get(runtimeKey) ?? {
    session: 0, jobs: new Map(), reloading: false, pending: [], contextWaiters: new Set(),
  };
  runtimes.set(runtimeKey, runtime);
  const jobs = runtime.jobs;
  const reconcileTools = installMcpPolicy(pi, () => role);

  const reconcileModels = async (ctx: ExtensionContext) => {
    const available = availableChildModels(ctx);
    const byName = new Map(available.map((model) => [`${model.provider}/${model.id}`, model]));
    const configured = readConfig().models;
    const stale = ROLE_NAMES.filter((name) => name !== "orchestrator" && name !== "council"
      && configured[name] && !byName.has(configured[name]));
    if (!stale.length) return;
    const currentName = ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
    const fallback = (currentName && byName.has(currentName) ? currentName : undefined)
      ?? ctx.scopedModels?.map(({ model }) => `${model.provider}/${model.id}`).find((name) => byName.has(name))
      ?? (available[0] && `${available[0].provider}/${available[0].id}`);
    if (!fallback) {
      ctx.ui.notify(`OMP: ${stale.join(", ")} has an unavailable model and no enabled model can replace it. Check /scoped-models or /omp.`, "warning");
      return;
    }
    const changed: string[] = [];
    await updateConfig((config) => {
      const models = { ...config.models };
      for (const name of stale) {
        const previous = models[name];
        if (previous && !byName.has(previous)) {
          models[name] = fallback;
          changed.push(`${name}: ${previous} → ${fallback}`);
        }
      }
      return { ...config, models };
    });
    if (changed.length) ctx.ui.notify(`OMP switched unavailable specialist models to enabled models: ${changed.join("; ")}`, "warning");
  };

  const repaint = (job: BackgroundJob) => {
    for (const invalidate of job.invalidators.values()) {
      try { invalidate(); } catch { /* A closed tool card must not affect the job. */ }
    }
    refreshPinned();
  };
  const refreshPinned = () => {
    const ctx = runtime.ctx;
    if (ctx?.mode !== "tui" || runtime.reloading || typeof ctx.ui.setWidget !== "function") return;
    const active = [...jobs.values()].filter((job) => job.session === runtime.session && job.state === "running");
    ctx.ui.setWidget("omp-active", active.length ? (_tui, theme) => {
      const view = new Container();
      for (const job of active) {
        view.addChild(renderPinnedOmpCard(job.progress, job.results, job.animationFrame, theme, job.pinnedState, refreshPinned));
      }
      return view;
    } : undefined, { placement: "aboveEditor" });
  };
  const stopAnimation = (job: BackgroundJob) => {
    if (job.animationTimer) clearInterval(job.animationTimer);
    job.animationTimer = undefined;
  };
  const cancelRunning = () => {
    for (const job of jobs.values()) if (job.state === "running") {
      job.controller.abort();
      stopAnimation(job);
    }
  };
  const bindContext = (ctx: ExtensionContext) => {
    runtime.pi = pi;
    runtime.ctx = ctx;
    for (const resolve of runtime.contextWaiters) resolve(ctx);
    runtime.contextWaiters.clear();
  };
  const waitForContext = (signal?: AbortSignal): ExtensionContext | Promise<ExtensionContext> => {
    if (signal?.aborted) return Promise.reject(new Error("Specialist tasks cancelled"));
    if (runtime.ctx) return runtime.ctx;
    return new Promise((resolve, reject) => {
      const onReady = (ctx: ExtensionContext) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(ctx);
      };
      const onAbort = () => {
        runtime.contextWaiters.delete(onReady);
        reject(new Error("Specialist tasks cancelled"));
      };
      runtime.contextWaiters.add(onReady);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
  const flushPending = () => {
    if (runtime.reloading || !runtime.pi) return;
    const pending = runtime.pending.splice(0);
    for (const item of pending) {
      if (item.session !== runtime.session) continue;
      try {
        runtime.pi.sendMessage({ customType: "omp-background-result", display: false, content: item.content },
          { triggerTurn: true, deliverAs: "steer" });
      } catch {
        if (item.attempts < 5) {
          runtime.pending.push({ ...item, attempts: item.attempts + 1 });
        } else {
          runtime.ctx?.ui.notify("OMP completed a background task, but could not deliver its result. Check the task card.", "warning");
        }
      }
    }
    if (runtime.pending.length) {
      const retry = setTimeout(flushPending, 100);
      retry.unref?.();
    }
  };
  const deliver = (job: BackgroundJob, content: string) => {
    if (job.session !== runtime.session) return;
    runtime.pending.push({ session: job.session, content, attempts: 0 });
    flushPending();
  };
  const visibleResult = (result: AgentToolResult<OmpDetails>, options: { expanded: boolean; isPartial: boolean }, theme: Parameters<typeof renderOmpToolResult>[2], context?: { state: OmpRenderState; invalidate: () => void; toolCallId: string }) => {
    const job = result.details?.jobId ? jobs.get(result.details.jobId) : undefined;
    if (job && context?.toolCallId) job.invalidators.set(context.toolCallId, context.invalidate ?? (() => {}));
    if (job && context?.state.card && job.pinnedState !== context.state) {
      job.pinnedState = context.state;
      refreshPinned();
    }
    return renderOmpToolResult(
      job ? { ...result, details: { ...result.details, progress: job.progress, results: job.results, animationFrame: job.animationFrame } } : result,
      job ? { ...options, isPartial: job.state === "running" } : options,
      theme, context?.state ?? {}, context?.invalidate,
      job?.state === "running" && runtime.ctx?.mode === "tui" && !!context?.state.card,
    );
  };

  const startJob = (
    ctx: ExtensionContext,
    prepared: Awaited<ReturnType<typeof prepareAssignments>>,
    kind: BackgroundJob["kind"],
    modelOverride?: string,
  ): AgentToolResult<OmpDetails> => {
    const id = randomUUID();
    const controller = new AbortController();
    const job: BackgroundJob = {
      id, kind, session: runtime.session, state: "running", progress: queuedProgress(prepared.items),
      controller, invalidators: new Map(), pinnedState: {}, animationFrame: 0,
    };
    bindContext(ctx);
    jobs.set(id, job);
    refreshPinned();
    job.animationTimer = setInterval(() => {
      job.animationFrame = (job.animationFrame + 1) % OMP_SPINNER_FRAMES.length;
      repaint(job);
    }, 80);
    job.animationTimer.unref?.();
    void runAssignments(ctx, prepared.items, controller.signal, (progress) => {
      job.progress = progress;
      repaint(job);
    }, modelOverride, id, waitForContext).then((results) => {
      stopAnimation(job);
      job.results = results;
      job.state = controller.signal.aborted ? "cancelled" : results.some((result) => !result.ok) ? "failed" : "done";
      repaint(job);
      const summary = formatResults(results);
      const councilHeader = job.state === "cancelled"
        ? "Some specialist tasks were cancelled. Review any completed results.\n\n"
        : kind === "council"
        ? `${results.filter((result) => result.ok).length}/${results.length} reviewers responded. These perspectives use the same inherited model, so do not claim cross-model agreement. Synthesize disagreements.\n\n`
        : "Verify and integrate these specialist results before finalizing.\n\n";
      deliver(job, `OMP background ${kind} ${job.state}. ${councilHeader}${summary}`);
    }).catch(() => {
      stopAnimation(job);
      job.state = controller.signal.aborted ? "cancelled" : "failed";
      repaint(job);
      deliver(job, `OMP background ${kind} ${job.state}. Inspect partial work before retrying.`);
    });
    return {
      content: [{ type: "text", text: `OMP background ${kind} started. Continue independent work. If nothing independent remains, end this turn with a brief status; completion will wake you. Never use shell sleep or polling to wait.` }],
      details: { jobId: id, progress: job.progress, animationFrame: job.animationFrame }, usage: prepared.usage,
    };
  };

  function status(ctx: ExtensionContext) {
    ctx.ui.setStatus("omp", `OMP:${role}`);
  }

  async function applySetting(id: string, value: string, ctx: ExtensionCommandContext): Promise<void> {
    if (id === "default" && isMainAgent(value)) {
      await updateConfig((current) => ({ ...current, defaultAgent: value }));
      role = value;
      if (role === "pi") cancelRunning();
      reconcileTools(role);
      status(ctx);
      return;
    }
    if (id.startsWith("role:") && isRole(id.slice(5)) && !["orchestrator", "council"].includes(id.slice(5))) {
      const name = id.slice(5) as Role;
      const selected = parseRoleSettingValue(value);
      if (!selected) throw new Error(`Invalid specialist model/thinking selection: ${value}`);
      const thinkingLevel = selected.thinking === INHERIT_THINKING ? undefined
        : isThinkingLevel(selected.thinking) ? selected.thinking : null;
      if (thinkingLevel === null) throw new Error(`Invalid specialist model/thinking selection: ${value}`);
      const model = selected.model === INHERIT ? undefined : selected.model;
      if (model) {
        const spec = parseModel(model);
        if (!spec || !availableChildModels(ctx).some((m) => m.provider === spec.provider && m.id === spec.id)) {
          throw new Error(`Model ${model} is not enabled or available; check /scoped-models and provider authentication`);
        }
      }
      await updateConfig((current) => {
        const models = { ...current.models };
        if (model) models[name] = model;
        else delete models[name];
        const thinking = { ...current.thinking };
        if (thinkingLevel === undefined) delete thinking[name];
        else thinking[name] = thinkingLevel;
        return { ...current, models, thinking };
      });
      return;
    }
    throw new Error(`Invalid setting ${id}: ${value}`);
  }

  pi.registerCommand("omp", {
    description: "Open default main agent, specialist model, and thinking settings",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Enter /omp without arguments to open settings", "warning");
        return;
      }
      try {
        await reconcileModels(ctx);
        await showSettingsUi(ctx, { apply: applySetting });
      } catch (err) {
        ctx.ui.notify(`OMP configuration failed (${configPath()}): ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const resumedReload = event.reason === "reload" && runtime.reloading;
    if (!resumedReload) {
      cancelRunning();
      jobs.clear();
      runtime.pending.length = 0;
      runtime.session++;
      runtime.reloading = false;
    }
    bindContext(ctx);
    refreshPinned();
    try {
      role = readConfig().defaultAgent;
    } catch (err) {
      role = "orchestrator";
      ctx.ui.notify(`OMP: failed to read ${configPath()}: ${err instanceof Error ? err.message : String(err)}`, "warning");
    }
    reconcileTools(role);
    status(ctx);
    try { await reconcileModels(ctx); }
    catch (err) { ctx.ui.notify(`OMP: could not update specialist models: ${err instanceof Error ? err.message : String(err)}`, "warning"); }
    if (resumedReload) {
      // Pi is still rebuilding its UI during session_start; deliver after reload returns.
      const resume = setTimeout(() => {
        runtime.reloading = false;
        refreshPinned();
        flushPending();
        for (const job of jobs.values()) repaint(job);
      }, 0);
      resume.unref?.();
    }
  });

  pi.on("session_shutdown", (event) => {
    runtime.ctx?.ui.setWidget?.("omp-active", undefined);
    runtime.pi = undefined;
    runtime.ctx = undefined;
    for (const job of jobs.values()) job.invalidators.clear();
    if (event.reason === "reload") {
      runtime.reloading = true;
      return;
    }
    runtime.session++;
    cancelRunning();
    jobs.clear();
    runtime.pending.length = 0;
    runtime.reloading = false;
    runtimes.delete(runtimeKey);
  });

  pi.on("before_agent_start", (event) => {
    reconcileTools(role);
    if (role === "pi") {
      delete event.systemPromptOptions.sections.omp_role;
      delete event.systemPromptOptions.sections.omp_roster;
      return;
    }
    event.systemPromptOptions.sections.omp_role = `Active OMP main agent: ${role}. ${ROLES[role].prompt}${role === "orchestrator" ? " For MCP access use only server-scoped gateway calls such as mcp({server:'gh_grep',tool:'search',args:{query:'example'}}). Never use unscoped gateway calls, gateway search/describe/instructions modes, mcpScript, or the context7 server (including its namespace). Direct MCP tools are unavailable; adapter tool descriptions may suggest calls that OMP blocks." : ""}`;
    event.systemPromptOptions.sections.omp_roster = `Specialists available with omp_delegate: ${ROLE_NAMES.filter((name) => name !== "orchestrator" && name !== "council").map((name) => `${name} (${ROLES[name].description})`).join("; ")}. All delegation and Council work runs in the background. Continue only independent work; if none remains, end your turn with a brief status, without claiming the task is finished. Completion steers an active turn at the next safe tool boundary or wakes an idle turn. Never use shell sleep or polling to wait for specialists. Use their findings only after the completion message arrives. Progress and assistant replies appear in the original OMP task card. Give one writer ownership of each file. For high-stakes choices use omp_council. Specialist results are evidence to verify, not a substitute for your own responsibility.`;
  });

  pi.registerTool({
    name: "omp_delegate", label: "OMP delegate",
    description: "Start background specialist work and receive an automatic completion message. One to four independent tasks run concurrently. Specialists: explorer, librarian, oracle, designer, fixer. Do not send secret credentials in tasks.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Specialist for a single task" })),
      task: Type.Optional(Type.String({ description: "Bounded task for the specialist" })),
      tasks: Type.Optional(Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }), { maxItems: 4 })),
    }),
    renderCall(args, theme, context) {
      const tasks = args.tasks ?? [{ agent: args.agent ?? "explorer", task: args.task ?? "" }];
      return renderOmpToolCall("OMP delegate", tasks as Assignment[], theme, context?.state ?? {}, context?.invalidate);
    },
    renderResult(result, options, theme, context) { return visibleResult(result as AgentToolResult<OmpDetails>, options, theme, context); },
    async execute(_id, params, signal, onUpdate, ctx) {
      if (role === "pi") throw new Error("OMP delegation is disabled while the default agent is pi");
      const single = params.agent !== undefined || params.task !== undefined;
      const list = params.tasks !== undefined;
      if (single === list || (list && (!params.tasks?.length || params.tasks.length > 4))) throw new Error("Provide either one agent + task or 1-4 tasks");
      const items = (list ? params.tasks! : [{ agent: params.agent!, task: params.task! }]);
      if (items.some((item) => !isRole(item.agent) || ["orchestrator", "council"].includes(item.agent) || !item.task?.trim() || item.task.length > 12_000)) {
        throw new Error("Only explorer/librarian/oracle/designer/fixer are supported; task must be 1-12000 characters");
      }
      const assignments = items as Assignment[];
      await reconcileModels(ctx);
      // Reject stale overrides before paying for translation or starting other children.
      for (const assignment of assignments) resolveModel(ctx, assignment.agent);
      onUpdate?.({ content: [{ type: "text", text: "OMP: preparing user-language prompts" }], details: { progress: queuedProgress(assignments) } });
      const prepared = await prepareAssignments(ctx, assignments, signal);
      return startJob(ctx, prepared, "delegate");
    },
  });

  pi.registerTool({
    name: "omp_council", label: "OMP council",
    description: "Consult three independent review sessions (failure modes, architecture, minimal alternative). Costs three model runs; synthesize the actual opinions and disclose disagreements. All reviewers inherit the current main session's model and thinking level.",
    parameters: Type.Object({ question: Type.String({ description: "A consequential technical decision to review" }) }),
    renderCall(args, theme, context) {
      return renderOmpToolCall("OMP council", councilAssignments(args.question), theme, context?.state ?? {}, context?.invalidate);
    },
    renderResult(result, options, theme, context) { return visibleResult(result as AgentToolResult<OmpDetails>, options, theme, context); },
    async execute(_id, { question }, signal, onUpdate, ctx) {
      if (role === "pi") throw new Error("OMP delegation is disabled while the default agent is pi");
      if (!question.trim() || question.length > 12_000) throw new Error("question must be 1-12000 characters");
      const model = resolveModel(ctx, "council");
      const assignments = councilAssignments(question);
      onUpdate?.({ content: [{ type: "text", text: "Council: preparing user-language prompts" }], details: { progress: queuedProgress(assignments) } });
      const prepared = await prepareAssignments(ctx, assignments, signal);
      return startJob(ctx, prepared, "council", model);
    },
  });
}
