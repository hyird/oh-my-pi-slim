import { randomUUID } from "node:crypto";
import { type AgentToolResult, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Container, Spacer } from "@earendil-works/pi-tui";
import { configPath, isThinkingLevel, parseModel, readConfig, updateConfig } from "./config.ts";
import { ROLES, ROLE_NAMES, isMainAgent, isRole, type MainAgent, type Role } from "./roles.ts";
import { showSettingsUi, INHERIT, INHERIT_THINKING, parseRoleSettingValue } from "./settings-ui.ts";
import { formatResults, queuedProgress, resolveModel, runAssignments, type AgentProgress, type Assignment, type OmpDetails, type Result } from "./subagents.ts";
import { OMP_SPINNER_FRAMES, renderPinnedOmpCall, renderPinnedOmpCard, renderPinnedOmpDetail, renderOmpToolCall, renderOmpToolResult, type OmpRenderState } from "./render.ts";
import { prepareAssignments } from "./language.ts";
import { installMcpPolicy } from "./mcp-policy.ts";
import { availableChildModels } from "./models.ts";
import { scrollablePinnedCard, type PinnedScrollState } from "./pinned-scroll.ts";

const COUNCIL_PERSPECTIVES = [
  "Find failure modes, safety issues, and counterexamples.",
  "Assess architecture, feasibility, and maintenance trade-offs.",
  "Find the simplest acceptable option and evaluate opportunity cost.",
];
const councilAssignments = (question: string): Assignment[] =>
  COUNCIL_PERSPECTIVES.map((perspective) => ({ agent: "council", task: `${perspective}\n\nDecision: ${question}` }));

type BackgroundJob = {
  id: string;
  callId: string;
  kind: "delegate" | "council";
  session: number;
  state: "running" | "done" | "failed" | "cancelled";
  progress: AgentProgress[];
  results?: Result[];
  controller: AbortController;
  invalidators: Map<string, () => void>;
  pinnedState: OmpRenderState;
  released: boolean;
  animationFrame: number;
  animationTimer?: ReturnType<typeof setInterval>;
};

type PendingCall = { tasks: Assignment[]; state: OmpRenderState };

type OmpRuntime = {
  session: number;
  jobs: Map<string, BackgroundJob>;
  calls: Map<string, PendingCall>;
  pi?: ExtensionAPI;
  ctx?: ExtensionContext;
  pending: Array<{ session: number; content: string; attempts: number }>;
  retryTimer?: ReturnType<typeof setTimeout>;
  scroll: PinnedScrollState;
};

export default function omp(pi: ExtensionAPI) {
  // Child sessions need personal provider extensions but must not register OMP again.
  if (process.env.PI_OMP_CHILD === "1") return;
  let role: MainAgent = "orchestrator";
  // Each extension instance owns its jobs. Reloading disposes this instance and
  // cancels its children; no cross-version runtime state is shared.
  const runtime: OmpRuntime = {
    session: 0, jobs: new Map(), calls: new Map(), pending: [], scroll: { listTop: 0, detailTop: 0 },
  };
  const jobs = runtime.jobs;
  const calls = runtime.calls;
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
    if (ctx?.mode !== "tui" || typeof ctx.ui.setWidget !== "function") return;
    const pinned = [...jobs.values()].filter((job) => job.session === runtime.session && !job.released);
    const pending = [...calls.values()];
    if (!pinned.length && !pending.length) {
      runtime.scroll.listTop = 0;
      runtime.scroll.detailTop = 0;
      runtime.scroll.focusedListRow = undefined;
    }
    ctx.ui.setWidget("omp-active", pinned.length || pending.length ? (tui, theme) => {
      const list = new Container();
      const cardStarts = new Map<OmpRenderState, number>();
      let rowOffset = 0;
      const states = [...pending.map((call) => call.state), ...pinned.map((job) => job.pinnedState)];
      const toggle = (state: OmpRenderState, taskIndex: number) => {
        const wasExpanded = state.expanded?.has(taskIndex) ?? false;
        for (const other of states) other.expanded?.clear();
        if (!wasExpanded) state.expanded = new Set([taskIndex]);
        runtime.scroll.detailTop = 0;
        refreshPinned();
      };
      for (const [index, call] of pending.entries()) {
        if (index) { list.addChild(new Spacer(1)); rowOffset++; }
        cardStarts.set(call.state, rowOffset);
        const card = new Box(1, 1, (text) => theme.bg("toolPendingBg", text));
        card.addChild(renderPinnedOmpCall(call.tasks, theme, call.state, refreshPinned, (taskIndex) => toggle(call.state, taskIndex)));
        list.addChild(card);
        rowOffset += call.tasks.length + 3;
      }
      for (const [index, job] of pinned.entries()) {
        if (index || pending.length) { list.addChild(new Spacer(1)); rowOffset++; }
        cardStarts.set(job.pinnedState, rowOffset);
        const card = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
        card.addChild(renderPinnedOmpCard(job.progress, job.results, job.animationFrame, theme, job.pinnedState, refreshPinned, job.state === "running", (taskIndex) => toggle(job.pinnedState, taskIndex)));
        list.addChild(card);
        rowOffset += Math.max(job.progress.length, job.results?.length ?? 0) + 3;
      }
      let detail: Box | undefined;
      let insertAfterRow: number | undefined;
      let expandedState: OmpRenderState | undefined;
      for (const call of pending) {
        const index = call.state.expanded?.values().next().value;
        if (index === undefined || !call.tasks[index]) continue;
        detail = new Box(1, 0, (text) => theme.bg("toolPendingBg", text));
        detail.addChild(renderPinnedOmpDetail(call.tasks[index].task, undefined, undefined, theme));
        insertAfterRow = cardStarts.get(call.state)! + 3 + index;
        expandedState = call.state;
        break;
      }
      if (!detail) for (const job of pinned) {
        const index = job.pinnedState.expanded?.values().next().value;
        if (index === undefined || !job.progress[index]) continue;
        detail = new Box(1, 0, (text) => theme.bg("toolSuccessBg", text));
        detail.addChild(renderPinnedOmpDetail(job.progress[index].task, job.progress[index], job.results?.[index], theme));
        insertAfterRow = cardStarts.get(job.pinnedState)! + 3 + index;
        expandedState = job.pinnedState;
        break;
      }
      return scrollablePinnedCard(list, detail, insertAfterRow, tui.terminal?.rows ?? 24, runtime.scroll,
        () => tui.requestRender(), (text) => theme.fg("muted", text), (label) => {
          if (!expandedState || expandedState.inlineRange === label) return false;
          expandedState.inlineRange = label;
          list.invalidate();
          return true;
        });
    } : undefined, { placement: "aboveEditor" });
  };
  const pinnedJob = (callId: string) => [...jobs.values()].find((job) => job.callId === callId && !job.released);
  const beginCall = (callId: string, tasks: Assignment[]) => {
    if (runtime.ctx?.mode !== "tui" || !callId || calls.has(callId) || pinnedJob(callId)) return;
    calls.set(callId, { tasks, state: {} });
    refreshPinned();
  };
  const renderChatCall = (label: string, tasks: Assignment[], theme: Parameters<typeof renderOmpToolCall>[2], context?: { state: OmpRenderState; invalidate: () => void; toolCallId: string; isPartial?: boolean; isError?: boolean }) => {
    if (context?.toolCallId) {
      const pending = calls.get(context.toolCallId);
      // Pi renders a call before tool_execution_start. Keep that first frame
      // empty; the start event creates the fixed card from the complete task list.
      if (runtime.ctx?.mode === "tui" && (context.isPartial !== false || pending || pinnedJob(context.toolCallId))) {
        context.state.card?.clear();
        return new Container();
      }
      const released = [...jobs.values()].find((job) => job.callId === context.toolCallId && job.released);
      if (released && context.state.expanded === undefined && released.pinnedState.expanded) {
        context.state.expanded = new Set(released.pinnedState.expanded);
      }
    }
    const shell = new Box(1, 1, (text) => theme.bg?.(context?.isPartial === false
      ? context.isError ? "toolErrorBg" : "toolSuccessBg" : "toolPendingBg", text) ?? text);
    shell.addChild(renderOmpToolCall(label, tasks, theme, context?.state ?? {}, context?.invalidate));
    return shell;
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
  };
  const flushPending = () => {
    if (!runtime.pi) return;
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
      runtime.retryTimer ??= setTimeout(() => {
        runtime.retryTimer = undefined;
        flushPending();
      }, 100);
      runtime.retryTimer.unref?.();
    }
  };
  const deliver = (job: BackgroundJob, content: string) => {
    if (job.session !== runtime.session) return;
    runtime.pending.push({ session: job.session, content, attempts: 0 });
    flushPending();
  };
  const visibleResult = (result: AgentToolResult<OmpDetails>, options: { expanded: boolean; isPartial: boolean }, theme: Parameters<typeof renderOmpToolResult>[2], context?: { state: OmpRenderState; invalidate: () => void; toolCallId: string }) => {
    const job = result.details?.jobId ? jobs.get(result.details.jobId) : undefined;
    if (job && context?.toolCallId) {
      job.callId = context.toolCallId;
      job.invalidators.set(context.toolCallId, context.invalidate ?? (() => {}));
    }
    const moved = runtime.ctx?.mode === "tui" && !!context &&
      (options.isPartial || !!(job && !job.released) || !!(context?.toolCallId && calls.has(context.toolCallId)));
    return renderOmpToolResult(
      job ? { ...result, details: { ...result.details, progress: job.progress, results: job.results, animationFrame: job.animationFrame } } : result,
      job ? { ...options, isPartial: job.state === "running" } : options,
      theme, context?.state ?? {}, context?.invalidate,
      moved,
    );
  };

  const startJob = (
    ctx: ExtensionContext,
    prepared: Awaited<ReturnType<typeof prepareAssignments>>,
    kind: BackgroundJob["kind"],
    callId: string,
    modelOverride?: string,
  ): AgentToolResult<OmpDetails> => {
    const id = randomUUID();
    const controller = new AbortController();
    const job: BackgroundJob = {
      id, callId, kind, session: runtime.session, state: "running", progress: queuedProgress(prepared.items),
      controller, invalidators: new Map(), pinnedState: calls.get(callId)?.state ?? {}, released: false, animationFrame: 0,
    };
    bindContext(ctx);
    calls.delete(callId);
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
    }, modelOverride).then((results) => {
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

  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "omp_delegate" && event.toolName !== "omp_council") return;
    bindContext(ctx);
    if (event.toolName === "omp_delegate") {
      const args = event.args ?? {};
      const tasks = Array.isArray(args.tasks)
        ? args.tasks.map((item: any) => ({ agent: typeof item?.agent === "string" ? item.agent : "explorer", task: typeof item?.task === "string" ? item.task : "" }))
        : [{ agent: typeof args.agent === "string" ? args.agent : "explorer", task: typeof args.task === "string" ? args.task : "" }];
      beginCall(event.toolCallId, tasks as Assignment[]);
    } else if (event.toolName === "omp_council") {
      beginCall(event.toolCallId, councilAssignments(String(event.args?.question ?? "")));
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (!calls.has(event.toolCallId)) return;
    calls.delete(event.toolCallId);
    refreshPinned();
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    for (const job of jobs.values()) {
      if (job.session !== runtime.session || job.state === "running" || job.released) continue;
      job.released = true;
      repaint(job);
    }
  });

  pi.on("session_start", async (event, ctx) => {
    cancelRunning();
    jobs.clear();
    calls.clear();
    runtime.pending.length = 0;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = undefined;
    runtime.session++;
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
  });

  pi.on("session_shutdown", () => {
    runtime.ctx?.ui.setWidget?.("omp-active", undefined);
    runtime.pi = undefined;
    runtime.ctx = undefined;
    for (const job of jobs.values()) job.invalidators.clear();
    runtime.session++;
    cancelRunning();
    jobs.clear();
    calls.clear();
    runtime.pending.length = 0;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = undefined;
  });

  pi.on("before_agent_start", (event) => {
    reconcileTools(role);
    if (role === "pi") {
      delete event.systemPromptOptions.sections.omp_role;
      delete event.systemPromptOptions.sections.omp_roster;
      return;
    }
    event.systemPromptOptions.sections.omp_role = `Active OMP main agent: ${role}. ${ROLES[role].prompt}${role === "orchestrator" ? " For MCP access use only server-scoped gateway calls such as mcp({server:'gh_grep',tool:'search',args:{query:'example'}}). Never use unscoped gateway calls, gateway search/describe/instructions modes, mcpScript, or the context7 server (including its namespace). Direct MCP tools are unavailable; adapter tool descriptions may suggest calls that OMP blocks." : ""}`;
    event.systemPromptOptions.sections.omp_roster = `Specialists available with omp_delegate: ${ROLE_NAMES.filter((name) => name !== "orchestrator" && name !== "council").map((name) => `${name} (${ROLES[name].description})`).join("; ")}. All delegation and Council work runs in the background. Continue only independent work; if none remains, end your turn with a brief status, without claiming the task is finished. Completion steers an active turn at the next safe tool boundary or wakes an idle turn. Never use shell sleep or polling to wait for specialists. Use their findings only after the completion message arrives. Progress and assistant replies remain in the fixed OMP task card until the next user input. Give one writer ownership of each file. For high-stakes choices use omp_council. Specialist results are evidence to verify, not a substitute for your own responsibility.`;
  });

  pi.registerTool({
    name: "omp_delegate", label: "OMP delegate",
    renderShell: "self",
    description: "Start background specialist work and receive an automatic completion message. Any number of independent tasks run concurrently. Specialists: explorer, librarian, oracle, designer, fixer. Do not send secret credentials in tasks.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Specialist for a single task" })),
      task: Type.Optional(Type.String({ description: "Bounded task for the specialist" })),
      tasks: Type.Optional(Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }))),
    }),
    renderCall(args, theme, context) {
      const tasks = args.tasks ?? [{ agent: args.agent ?? "explorer", task: args.task ?? "" }];
      return renderChatCall("OMP delegate", tasks as Assignment[], theme, context);
    },
    renderResult(result, options, theme, context) { return visibleResult(result as AgentToolResult<OmpDetails>, options, theme, context); },
    async execute(_id, params, signal, onUpdate, ctx) {
      bindContext(ctx);
      if (role === "pi") throw new Error("OMP delegation is disabled while the default agent is pi");
      const single = params.agent !== undefined || params.task !== undefined;
      const list = params.tasks !== undefined;
      if (single === list || (list && !params.tasks?.length)) throw new Error("Provide either one agent + task or a non-empty tasks array");
      const items = (list ? params.tasks! : [{ agent: params.agent!, task: params.task! }]);
      if (items.some((item) => !isRole(item.agent) || ["orchestrator", "council"].includes(item.agent) || !item.task?.trim() || item.task.length > 12_000)) {
        throw new Error("Only explorer/librarian/oracle/designer/fixer are supported; task must be 1-12000 characters");
      }
      const assignments = items as Assignment[];
      beginCall(_id, assignments);
      await reconcileModels(ctx);
      // Reject stale overrides before paying for translation or starting other children.
      for (const assignment of assignments) resolveModel(ctx, assignment.agent);
      onUpdate?.({ content: [{ type: "text", text: "OMP: preparing user-language prompts" }], details: { progress: queuedProgress(assignments) } });
      const prepared = await prepareAssignments(ctx, assignments, signal);
      return startJob(ctx, prepared, "delegate", _id);
    },
  });

  pi.registerTool({
    name: "omp_council", label: "OMP council",
    renderShell: "self",
    description: "Consult three independent review sessions (failure modes, architecture, minimal alternative). Costs three model runs; synthesize the actual opinions and disclose disagreements. All reviewers inherit the current main session's model and thinking level.",
    parameters: Type.Object({ question: Type.String({ description: "A consequential technical decision to review" }) }),
    renderCall(args, theme, context) {
      return renderChatCall("OMP council", councilAssignments(args.question), theme, context);
    },
    renderResult(result, options, theme, context) { return visibleResult(result as AgentToolResult<OmpDetails>, options, theme, context); },
    async execute(_id, { question }, signal, onUpdate, ctx) {
      bindContext(ctx);
      if (role === "pi") throw new Error("OMP delegation is disabled while the default agent is pi");
      if (!question.trim() || question.length > 12_000) throw new Error("question must be 1-12000 characters");
      const model = resolveModel(ctx, "council");
      const assignments = councilAssignments(question);
      beginCall(_id, assignments);
      onUpdate?.({ content: [{ type: "text", text: "Council: preparing user-language prompts" }], details: { progress: queuedProgress(assignments) } });
      const prepared = await prepareAssignments(ctx, assignments, signal);
      return startJob(ctx, prepared, "council", _id, model);
    },
  });
}
