import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import omp from "../extensions/omp/index.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { configPath, parseConfig, parseModel, readConfig, updateConfig } from "../extensions/omp/config.ts";
import { formatResults, resolveModel, runAgent, runAssignments, sumUsage, type AgentProgress, type Result } from "../extensions/omp/subagents.ts";
import { getChoices, getSettingsRows, INHERIT, INHERIT_THINKING } from "../extensions/omp/settings-ui.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderOmpCall, renderOmpResult } from "../extensions/omp/render.ts";
import { startConversation } from "../extensions/omp/transcript.ts";

const savedDir = process.env.PI_CODING_AGENT_DIR;
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-"));
  process.env.PI_CODING_AGENT_DIR = tmp;
});
afterEach(() => {
  if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const models = [
  { provider: "openai-codex", id: "gpt-5.5" },
  { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
] as any[];

function harness() {
  const commands: Record<string, any> = {};
  const shortcuts: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const handlers: Record<string, any> = {};
  const notifications: string[] = [];
  const sentMessages: Array<{ message: any; options: any }> = [];
  const selected: string[] = [];
  const translations: any[] = [];
  const branch: any[] = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "请用中文处理这个任务" }] } }];
  const translationUsage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0.05, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.15 } };
  const ctx: any = {
    cwd: tmp, model: models[0], mode: "tui", hasUI: true,
    modelRegistry: { getAvailable: () => models, streamSimple: (_model: any, request: any, options: any) => {
      const input = JSON.parse(request.messages[0].content[0].text);
      translations.push({ input, request, options });
      return { result: async () => ({ stopReason: "stop", usage: translationUsage, content: [{ type: "text", text: JSON.stringify({
        language: "Chinese", prompts: Object.fromEntries(Object.keys(input.prompts).map((role) => [role, `请用中文回答。${input.prompts[role]}`])),
        tasks: input.tasks.map((task: string, index: number) => `本地化任务 ${index + 1}: ${task}`),
      }) }] }) };
    } },
    sessionManager: { getBranch: () => branch },
    isProjectTrusted: () => false,
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus: () => {},
      select: async () => undefined,
      input: async () => undefined,
    },
  };
  const pi: any = {
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    registerShortcut: (key: string, shortcut: any) => { shortcuts[key] = shortcut; },
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    sendMessage: (message: any, options: any) => { sentMessages.push({ message, options }); },
    on: (name: string, handler: any) => { handlers[name] = handler; },
    setModel: async (model: any) => { selected.push(`${model.provider}/${model.id}`); ctx.model = model; return true; },
    appendEntry: () => { throw new Error("/omp must not modify session state"); },
  };
  omp(pi);
  return { ctx, commands, shortcuts, tools, handlers, notifications, sentMessages, selected, translations, branch, translationUsage };
}

async function waitFor(check: () => boolean | Promise<boolean>, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  expect(await check()).toBe(true);
}

describe("config safety", () => {
  test("parses defaults and model IDs; rejects invalid roles and models", () => {
    expect(parseConfig({})).toEqual({ defaultAgent: "orchestrator", models: {}, thinking: {} });
    expect(parseModel("openai-codex/gpt-5.5")).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
    expect(parseModel("--model/evil")).toBeUndefined();
    expect(() => parseConfig({ models: { unknown: "openai-codex/gpt-5.5" } })).toThrow();
    expect(() => parseConfig({ defaultAgent: "bad" })).toThrow();
    expect(parseConfig({ defaultAgent: "pi" }).defaultAgent).toBe("pi");
    expect(parseConfig({ defaultAgent: "explorer", models: { explorer: "openai-codex/gpt-5.5" } })).toEqual({
      defaultAgent: "orchestrator", models: { explorer: "openai-codex/gpt-5.5" }, thinking: {},
    });
    expect(() => parseConfig({ models: { fixer: "invalid" } })).toThrow("Invalid models.fixer: expected provider/model-id");
    expect(() => parseConfig([])).toThrow("Config must be a JSON object");
    expect(() => parseConfig({ defaultAgent: 1 })).toThrow("Invalid defaultAgent");
    expect(() => parseConfig({ defaultAgent: "bad" })).toThrow("defaultAgent must be a main agent");
    expect(() => parseConfig({ models: [] })).toThrow("models must be an object");
    expect(parseConfig({ thinking: { explorer: "high", council: "off" } }).thinking).toEqual({ explorer: "high" });
    expect(parseConfig({ models: { council: "openai-codex/gpt-5.5" } }).models).toEqual({});
    expect(() => parseConfig({ thinking: { explorer: "ultra" } })).toThrow("Invalid thinking.explorer");
    expect(() => parseConfig({ thinking: { unknown: "high" } })).toThrow("Invalid thinking.unknown");
    expect(() => parseConfig({ thinking: [] })).toThrow("thinking must be an object");
  });
  test("concurrent config writes remain intact", async () => {
    await Promise.all([
      updateConfig((c) => ({ ...c, models: { ...c.models, explorer: "openai-codex/gpt-5.3-codex-spark" } })),
      updateConfig((c) => ({ ...c, models: { ...c.models, fixer: "openai-codex/gpt-5.5" }, thinking: { ...c.thinking, fixer: "high" } })),
    ]);
    expect(readConfig().models).toEqual({ explorer: "openai-codex/gpt-5.3-codex-spark", fixer: "openai-codex/gpt-5.5" });
    expect(readConfig().thinking).toEqual({ fixer: "high" });
    expect(fs.readdirSync(tmp)).toEqual(["omp.json"]);
  });
  test("does not overwrite malformed config", async () => {
    fs.writeFileSync(configPath(), "broken {");
    await expect(updateConfig((c) => ({ ...c, defaultAgent: "pi" }))).rejects.toThrow();
    expect(fs.readFileSync(configPath(), "utf8")).toBe("broken {");
  });
});

describe("/omp settings entry point", () => {
  test("registers only /omp; rejects subcommands without creating a config file", async () => {
    const h = harness();
    expect(Object.keys(h.commands)).toEqual(["omp"]);
    expect(Object.keys(h.shortcuts)).toEqual([]);
    await h.commands.omp.handler("default oracle", h.ctx);
    expect(h.notifications.at(-1)).toContain("Enter /omp without arguments");
    expect(fs.existsSync(configPath())).toBe(false);
  });
  test("settings show one row per delegated role with model and thinking", () => {
    const rows = getSettingsRows();
    expect(rows.map((r) => r.id)).toEqual(["default", "role:explorer", "role:librarian", "role:oracle", "role:designer", "role:fixer"]);
    expect(rows[0].label).toBe("Default main agent");
    expect(rows[0].description).toContain("does not change Pi's current model");
    expect(rows.slice(1).map((row) => row.label)).toEqual(["explorer", "librarian", "oracle", "designer", "fixer"]);
    expect(rows[1].currentValue).toBe(`${INHERIT} · ${INHERIT_THINKING}`);
    expect(rows[1].description).toContain("Choose the model, then the thinking level");
    expect(getChoices("default", harness().ctx)).toEqual(["pi", "orchestrator", "council"]);
    expect(getChoices("model:explorer", harness().ctx)[0]).toBe(INHERIT);
    expect(getChoices("thinking:explorer", harness().ctx)).toEqual([INHERIT_THINKING, "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
  test("specialist model choices and saved overrides respect Pi's enabled models", async () => {
    const h = harness();
    h.ctx.scopedModels = [{ model: models[1] }];
    expect(getChoices("model:explorer", h.ctx)).toEqual([INHERIT, "openai-codex/gpt-5.3-codex-spark"]);
    await updateConfig((config) => ({ ...config, models: { explorer: "openai-codex/gpt-5.5" } }));
    expect(getChoices("model:explorer", h.ctx)).not.toContain("openai-codex/gpt-5.5");
    expect(() => resolveModel(h.ctx, "explorer")).toThrow("not enabled or available");
    h.ctx.mode = "rpc";
    let calls = 0;
    h.ctx.ui.select = async (_title: string, options: string[]) => {
      if (++calls === 1) return options[1];
      if (calls === 2) return "openai-codex/gpt-5.5"; // forged, now disabled
      if (calls === 3) return "high";
      return undefined;
    };
    await h.commands.omp.handler("", h.ctx);
    expect(h.notifications.at(-1)).toContain("not enabled or available");
    expect(readConfig().thinking.explorer).toBeUndefined();
  });
  test("TUI selects model then thinking in one role row and saves both together", async () => {
    const h = harness();
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    let component: any;
    h.ctx.ui.custom = (factory: any) => new Promise<void>((done) => {
      component = factory({ requestRender: () => {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {}, done);
    });
    const finished = h.commands.omp.handler("", h.ctx);
    expect(component.render(90).join("\n")).toContain("Main agent / specialist settings");
    expect(component.render(90).join("\n")).toContain("Default main agent");
    expect(component.render(90).join("\n")).toContain("explorer");
    expect(component.render(32).length).toBeGreaterThan(1);
    component.handleInput("\r"); // default main Agent picker
    component.handleInput("\x1b[A"); // pi native (only pi/orchestrator are primary)
    component.handleInput("\r");
    await waitFor(() => readConfig().defaultAgent === "pi");
    component.handleInput("\x1b[B"); // explorer row
    component.handleInput("\r");
    for (const char of "spark") component.handleInput(char);
    expect(component.render(90).join("\n")).toContain("Search models:");
    expect(component.render(90).join("\n")).toContain("gpt-5.3-codex-spark");
    component.handleInput("\r");
    expect(component.render(90).join("\n")).toContain("explorer thinking");
    expect(readConfig().models.explorer).toBeUndefined(); // save after thinking is chosen
    for (let i = 0; i < 5; i++) component.handleInput("\x1b[B"); // high
    component.handleInput("\r");
    await waitFor(() => readConfig().models.explorer === "openai-codex/gpt-5.3-codex-spark" && readConfig().thinking.explorer === "high");
    expect(h.selected).toEqual([]); // main model stays with Pi, regardless of specialist model
    component.handleInput("\r"); // reopen explorer role
    component.handleInput("\x1b[A"); // inherit
    component.handleInput("\r");
    for (let i = 0; i < 5; i++) component.handleInput("\x1b[A"); // inherit
    component.handleInput("\r");
    await waitFor(() => !readConfig().models.explorer && !readConfig().thinking.explorer);
    expect(h.selected).toEqual([]);
    component.handleInput("\x1b");
    await finished;
    const event: any = { systemPromptOptions: { sections: {} } };
    h.handlers.before_agent_start(event);
    expect(event.systemPromptOptions.sections.omp_role).toBeUndefined(); // native Pi has no OMP prompt
  });
  test("TUI follows the active theme and keeps thinking values readable at narrow widths", async () => {
    await updateConfig((c) => ({ ...c, models: { explorer: "openai-codex/gpt-5.3-codex-spark" }, thinking: { explorer: "high" } }));
    const h = harness();
    let component: any;
    let palette = 1;
    const colors: string[] = [];
    h.ctx.ui.custom = (factory: any) => new Promise<void>((done) => {
      component = factory({ requestRender: () => {} }, {
        fg: (color: string, text: string) => { colors.push(color); return `\x1b[3${palette}m${text}\x1b[39m`; },
        bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
      }, {}, done);
    });
    const finished = h.commands.omp.handler("", h.ctx);
    const wide = component.render(100).join("\n");
    expect(wide).toContain("Default main agent");
    expect(wide).toContain("explorer");
    expect(wide).toContain("high");
    expect(colors).toContain("accent");
    expect(colors).toContain("text");
    expect(colors).toContain("muted");
    palette = 2;
    const narrow = component.render(32);
    expect(narrow.every((line: string) => visibleWidth(line) <= 32)).toBe(true);
    expect(narrow.join("\n")).toContain("Main agent");
    expect(narrow.join("\n")).toContain("fixer");
    expect(narrow.join("\n")).toContain("Current: orchestrator");
    expect(narrow.join("\n")).toContain("\x1b[32m");
    expect(narrow.join("\n")).not.toContain("\x1b[31m");
    component.handleInput("\x1b[B");
    expect(component.render(32).join("\n").replace(/\x1b\[[\d;]*m/g, "").replace(/\s+/g, "")).toContain("openai-codex/gpt-5.3-codex-spark");
    component.handleInput("\r");
    const picker = component.render(24);
    expect(picker.every((line: string) => visibleWidth(line) <= 24)).toBe(true);
    component.handleInput("\x1b");
    component.handleInput("\x1b");
    await finished;
  });
  test("RPC cannot set a specialist as default even with a forged option", async () => {
    const h = harness();
    h.ctx.mode = "rpc";
    let calls = 0;
    h.ctx.ui.select = async (_title: string, options: string[]) => (++calls === 1 ? options[0] : "fixer");
    await h.commands.omp.handler("", h.ctx);
    expect(readConfig().defaultAgent).toBe("orchestrator");
    expect(fs.existsSync(configPath())).toBe(false);
    expect(h.notifications.at(-1)).toContain("Invalid setting");
  });
  test("RPC provides a hierarchical picker without a custom TUI", async () => {
    const h = harness();
    h.ctx.mode = "rpc";
    let calls = 0;
    h.ctx.ui.select = async (_title: string, options: string[]) => {
      if (++calls === 1) return options[0];
      if (calls === 2) return "orchestrator";
      return undefined;
    };
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    await h.commands.omp.handler("", h.ctx);
    expect(readConfig().defaultAgent).toBe("orchestrator");
    expect(h.selected).toEqual([]);
  });
  test("RPC selects a role's model then thinking before saving", async () => {
    const h = harness();
    h.ctx.mode = "rpc";
    const titles: string[] = [];
    let calls = 0;
    h.ctx.ui.select = async (title: string, options: string[]) => {
      titles.push(title);
      if (++calls === 1) return options[1]; // explorer role
      if (calls === 2) return "openai-codex/gpt-5.5";
      if (calls === 3) {
        expect(readConfig().models.explorer).toBeUndefined();
        return "high";
      }
      return undefined;
    };
    await h.commands.omp.handler("", h.ctx);
    expect(titles.slice(0, 3)).toEqual([
      "OMP · Main agent / specialist settings (cancel to close)",
      "explorer model",
      "explorer thinking",
    ]);
    expect(readConfig().models.explorer).toBe("openai-codex/gpt-5.5");
    expect(readConfig().thinking.explorer).toBe("high");
  });
  test("pi main agent cannot launch OMP children even through a stale tool call", async () => {
    await updateConfig((config) => ({ ...config, defaultAgent: "pi" }));
    const h = harness();
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    await expect(h.tools.omp_delegate.execute("id", { agent: "explorer", task: "inspect" }, undefined, undefined, h.ctx)).rejects.toThrow("disabled while the default agent is pi");
    await expect(h.tools.omp_council.execute("id", { question: "review" }, undefined, undefined, h.ctx)).rejects.toThrow("disabled while the default agent is pi");
    expect(h.translations).toEqual([]);
  });
  test("recovers legacy specialist defaults as orchestrator while retaining model overrides", async () => {
    fs.writeFileSync(configPath(), JSON.stringify({ defaultAgent: "fixer", models: { fixer: "openai-codex/gpt-5.5" } }));
    const h = harness();
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    expect(readConfig().defaultAgent).toBe("orchestrator");
    expect(readConfig().models.fixer).toBe("openai-codex/gpt-5.5");
    const event: any = { systemPromptOptions: { sections: {} } };
    h.handlers.before_agent_start(event);
    expect(event.systemPromptOptions.sections.omp_role).toContain("Active OMP main agent: orchestrator");
  });
  test("council can be the default main agent without a child model setting", async () => {
    await updateConfig((c) => ({ ...c, defaultAgent: "council" }));
    const h = harness();
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    const event: any = { systemPromptOptions: { sections: {} } };
    h.handlers.before_agent_start(event);
    expect(readConfig().defaultAgent).toBe("council");
    expect(event.systemPromptOptions.sections.omp_role).toContain("Active OMP main agent: council");
    expect(h.selected).toEqual([]);
  });
  test("session restart reads the main role without overriding Pi's main model with a specialist model", async () => {
    await updateConfig((c) => ({ ...c, defaultAgent: "orchestrator", models: { fixer: "openai-codex/gpt-5.3-codex-spark" } }));
    const h = harness();
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    expect(h.selected).toEqual([]);
    const event: any = { systemPromptOptions: { sections: {} } };
    h.handlers.before_agent_start(event);
    expect(event.systemPromptOptions.sections.omp_role).toContain("Active OMP main agent: orchestrator");
    expect(event.systemPromptOptions.sections.omp_role).toContain("not the default implementation worker");
    expect(event.systemPromptOptions.sections.omp_role).toContain("multi-file implementation");
    expect(event.systemPromptOptions.sections.omp_roster).toContain("Never use shell sleep or polling");
    expect(Object.keys(h.tools).sort()).toEqual(["omp_council", "omp_delegate"]);
    await expect(h.tools.omp_delegate.execute("id", { agent: "bad", task: "test" }, undefined, undefined, h.ctx)).rejects.toThrow();
  });
});

test("isolated child uses the configured specialist model and tool allowlist (offline fake Pi)", async () => {
  const h = harness();
  h.ctx.thinkingLevel = "low";
  await updateConfig((c) => ({ ...c, models: { explorer: "openai-codex/gpt-5.3-codex-spark" }, thinking: { explorer: "high" } }));
  const originalArgv = process.argv[1];
  const capture = path.join(tmp, "capture.json");
  process.env.OMP_TEST_CAPTURE = capture;
  process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
  try {
    const result = await runAgent(h.ctx, { agent: "explorer", task: "find files" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("Specialist read the task");
    expect(result.usage.cost.total).toBe(0.3);
    const recorded = JSON.parse(fs.readFileSync(capture, "utf8"));
    expect(recorded.args).not.toContain("--no-extensions");
    expect(recorded.childGuard).toBe("1");
    expect(recorded.args).toContain("--no-approve");
    expect(recorded.args[recorded.args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
    expect(recorded.args[recorded.args.indexOf("--model") + 1]).toBe("openai-codex/gpt-5.3-codex-spark");
    expect(recorded.args[recorded.args.indexOf("--thinking") + 1]).toBe("high");
    expect(recorded.prompt).toContain("You are Explorer");
    h.ctx.isProjectTrusted = () => true;
    const trusted = await runAgent(h.ctx, { agent: "oracle", task: "review" });
    expect(trusted.ok).toBe(true);
    const trustedArgs = JSON.parse(fs.readFileSync(capture, "utf8")).args;
    expect(trustedArgs).toContain("--approve");
    expect(trustedArgs).not.toContain("--no-approve");
    expect(trustedArgs[trustedArgs.indexOf("--thinking") + 1]).toBe("low");
    fs.writeFileSync(configPath(), JSON.stringify({ defaultAgent: "orchestrator", models: { council: "openai-codex/gpt-5.3-codex-spark" }, thinking: { council: "max" } }));
    await runAgent(h.ctx, { agent: "council", task: "review another decision" });
    const councilArgs = JSON.parse(fs.readFileSync(capture, "utf8")).args;
    expect(councilArgs[councilArgs.indexOf("--model") + 1]).toBe("openai-codex/gpt-5.5");
    expect(councilArgs[councilArgs.indexOf("--thinking") + 1]).toBe("low");
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_CAPTURE;
  }
});

test("specialist text deltas and tool activity reach ordered live snapshots before completion", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "30";
  try {
    const snapshots: AgentProgress[][] = [];
    const results = await runAssignments(h.ctx, [
      { agent: "explorer", task: "find auth" }, { agent: "explorer", task: "find config" },
    ], undefined, (snapshot) => snapshots.push(snapshot));
    expect(results.map((item) => item.ok)).toEqual([true, true]);
    expect(snapshots[0].map((item) => item.state)).toEqual(["queued", "queued"]);
    expect(snapshots.some((snapshot) => snapshot.some((item) => item.activity.includes("read src/index.ts")))).toBe(true);
    expect(snapshots.some((snapshot) => snapshot.some((item) => item.text.includes("Inspecting the code")))).toBe(true);
    expect(snapshots.at(-1)?.map((item) => item.state)).toEqual(["done", "done"]);
    expect(snapshots.at(-1)?.map((item) => item.task)).toEqual(["find auth", "find config"]);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("OMP cards show only safe progress until final outputs, regardless of expansion", () => {
  initTheme();
  const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const tasks: any = [
    { agent: "explorer", task: "SECRET_TASK run private-command --token=hidden" },
    { agent: "fixer", task: "SECRET_OTHER fix issue" },
  ];
  const call = renderOmpCall("OMP delegate", tasks, theme).render(120).join("\n");
  expect(call).toContain("0/2");
  expect(call).toContain("Explorer task 1");
  expect(call).toContain("Fixer task 2");
  expect(call).toContain("queued");
  expect(call).not.toMatch(/SECRET_|private-command|hidden|fix issue/);

  const progress: AgentProgress[] = tasks.map((task: any, index: number) => ({
    agent: task.agent, task: task.task, model: "SECRET_MODEL", state: index ? "running" : "queued",
    activity: "SECRET_ACTIVITY private-command", text: "SECRET_PREVIEW assistant message",
    activities: ["SECRET_ACTIVITY private-command"],
  }));
  const render = (expanded: boolean, isPartial: boolean) => renderOmpResult(
    { content: [{ type: "text", text: "SECRET_RESULT" }], details: { progress } },
    { expanded, isPartial }, theme,
  ).render(120).join("\n");
  const compact = render(false, true);
  expect(compact).toContain("running · 0/2");
  expect(compact).toContain("○ queued · Explorer task 1");
  expect(compact).toContain("◷ running · Fixer task 2");
  expect(compact).not.toMatch(/SECRET_|private-command|assistant message|Ctrl\+Alt\+O/);
  const expanded = render(true, true);
  expect(expanded).not.toContain("Ctrl+Alt+O");
  expect(expanded).not.toMatch(/SECRET_|private-command|assistant message|Activity:|Preview:|Model:|Task:/);

  progress[0].state = "done";
  progress[1].state = "failed";
  const result: any = { content: [{ type: "text", text: "SECRET_RESULT" }], details: { progress, results: [
    { agent: "explorer", ok: true, output: "**Final answer**\n\nSafe conclusion." },
    { agent: "fixer", ok: false, output: "SECRET_STDERR /private/path" },
  ] } };
  for (const isExpanded of [false, true]) {
    const finished = renderOmpResult(result, { expanded: isExpanded, isPartial: false }, theme).render(120).join("\n");
    expect(finished).toContain("failed · 2/2");
    expect(finished).toContain("✓ done · Explorer task 1");
    expect(finished).toContain("✗ failed · Fixer task 2");
    expect(finished).toContain("Final answer");
    expect(finished).toContain("Safe conclusion.");
    expect(finished).not.toMatch(/SECRET_|private-command|assistant message|\/private\/path|Activity:|Preview:|Model:|Task:|Assistant output:/);
    expect(finished).not.toContain("Ctrl+Alt+O");
    expect(finished.match(/Final answer/g)).toHaveLength(1);
  }
});

test("OMP tool rows replace queued content in place as progress changes", () => {
  initTheme();
  const theme: any = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
  const h = harness();
  for (const [name, args, agent] of [
    ["omp_delegate", { agent: "explorer", task: "inspect" }, "explorer"],
    ["omp_council", { question: "review" }, "council"],
  ] as const) {
    const tool = h.tools[name];
    const state: Record<string, unknown> = {};
    const context: any = { state };
    const call = tool.renderCall(args, theme, context);
    expect(call.render(80).join("\n")).toContain("queued");

    const progress = [{ agent, task: "private task", model: "private model", state: "running", activity: "", text: "", activities: [] }];
    const partial = tool.renderResult({ content: [], details: { progress } }, { expanded: false, isPartial: true }, theme, context);
    const running = [...call.render(80), ...partial.render(80)].join("\n");
    expect(running.match(/OMP/g)).toHaveLength(1);
    expect(running).toContain("running · 0/1");
    expect(running).not.toContain("queued");

    const complete = tool.renderResult({ content: [], details: { progress: [{ ...progress[0], state: "done" }], results: [{ agent, ok: true, output: "Finished" }] } },
      { expanded: false, isPartial: false }, theme, context);
    const done = [...call.render(80), ...complete.render(80)].join("\n");
    expect(done.match(/OMP/g)).toHaveLength(1);
    expect(done).toContain("done · 1/1");
    expect(done).not.toContain("running");
  }
});

test("OMP rendering tracks theme changes and stays within narrow widths", () => {
  initTheme();
  let palette = 1;
  const colors: string[] = [];
  const theme: any = {
    fg: (color: string, text: string) => { colors.push(color); return `\x1b[3${palette}m${text}\x1b[39m`; },
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  };
  const tasks: any = [{ agent: "explorer", task: "LEAK_COMMAND --key=secret" }];
  const result: any = { content: [], details: { progress: [{
    agent: "explorer", task: tasks[0].task, state: "running", model: "private-model",
    activity: "LEAK_ACTIVITY", text: "LEAK_PREVIEW", activities: ["LEAK_ACTIVITY"],
  }] } };
  const call = renderOmpCall("OMP delegate", tasks, theme);
  const compact = renderOmpResult(result, { expanded: false, isPartial: true }, theme);
  const expanded = renderOmpResult(result, { expanded: true, isPartial: true }, theme);
  expect(colors).toContain("accent");
  expect(colors).toContain("warning");
  expect(call.render(80).join("\n")).toContain("\x1b[31m");
  palette = 2;
  const updatedCall = renderOmpCall("OMP delegate", tasks, theme);
  const updatedCompact = renderOmpResult(result, { expanded: false, isPartial: true }, theme);
  const updatedExpanded = renderOmpResult(result, { expanded: true, isPartial: true }, theme);
  for (const view of [updatedCall, updatedCompact, updatedExpanded]) {
    const lines = view.render(22);
    expect(lines.every((line) => visibleWidth(line) <= 22)).toBe(true);
    expect(lines.join("\n")).toContain("\x1b[32m");
  }
  expect(updatedCall.render(22).join("\n")).not.toContain("LEAK_COMMAND");
  expect(updatedCompact.render(22).join("\n")).not.toMatch(/LEAK_|private-model|secret/);
  expect(updatedCompact.render(22).join("\n")).toContain("running");
  expect(updatedExpanded.render(80).join("\n")).not.toMatch(/LEAK_|private-model|secret/);
  result.details.progress[0].state = "done";
  result.details.results = [{ agent: "explorer", ok: true, output: "**Resolved** with a narrow layout" }];
  for (const isExpanded of [false, true]) {
    const finished = renderOmpResult(result, { expanded: isExpanded, isPartial: false }, theme).render(22);
    expect(finished.every((line: string) => visibleWidth(line) <= 22)).toBe(true);
    expect(finished.join("\n")).toContain("Resolved");
    expect(finished.join("\n")).not.toMatch(/LEAK_|private-model|secret/);
  }
});

test("delegation shows live progress and final output collapsed without setting a widget", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
  const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
  h.ctx.ui.setWidget = (key: string, lines: string[] | undefined) => widgets.push({ key, lines });
  const partials: any[] = [];
  const capture = path.join(tmp, "delegate-capture.json");
  process.env.OMP_TEST_CAPTURE = capture;
  const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  try {
    const tool = h.tools.omp_delegate;
    const call = tool.renderCall({ agent: "explorer", task: "查看 src/index.ts" }, theme).render(80).join("\n");
    expect(call).toContain("Explorer task");
    expect(call).toContain("0/1");
    expect(call).not.toContain("src/index.ts");
    const result = await tool.execute("call-123", { agent: "explorer", task: "查看 src/index.ts" }, undefined, (partial: any) => partials.push(partial), h.ctx);
    expect(partials[0].content[0].text).toContain("preparing user-language prompts");
    expect(partials[0].details.progress.map((item: AgentProgress) => item.state)).toEqual(["queued"]);
    const preparing = tool.renderResult(partials[0], { expanded: false, isPartial: true }, theme).render(100).join("\n");
    expect(preparing).toContain("queued · 0/1");
    expect(preparing).toContain("○ queued · Explorer task");
    expect(preparing).not.toContain("Ctrl+Alt+O");
    expect(preparing).not.toContain("preparing user-language prompts");
    expect(h.translations).toHaveLength(1);
    expect(h.translations[0].input.latestUserMessage).toBe("请用中文处理这个任务");
    expect(Object.keys(h.translations[0].input.prompts)).toEqual(["explorer"]);
    await waitFor(() => fs.existsSync(capture));
    await waitFor(() => h.sentMessages.length === 1);
    const recorded = JSON.parse(fs.readFileSync(capture, "utf8"));
    expect(recorded.prompt).toContain("请用中文回答");
    expect(recorded.args.at(-1)).toBe("本地化任务 1: 查看 src/index.ts");
    expect(result.usage.cost.total).toBeCloseTo(0.15);
    expect(result.usage.totalTokens).toBe(5);
    expect(h.sentMessages[0].message.content).toContain("Specialist read the task");
    for (const isExpanded of [false, true]) {
      const displayed = tool.renderResult(result, { expanded: isExpanded, isPartial: false }, theme).render(100).join("\n");
      expect(displayed).toContain("Specialist read the task");
      expect(displayed).not.toMatch(/read src\/index.ts|Inspecting the code|Activity:|Preview:|Model:|Task:/);
      expect(displayed.match(/Specialist read the task/g)).toHaveLength(1);
      expect(displayed).not.toContain("Ctrl+Alt+O");
    }
    expect(widgets).toEqual([]);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_CAPTURE;
  }
});

test("background delegation returns immediately, updates its card and delivers completion", async () => {
  initTheme();
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "100";
  const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  try {
    const tool = h.tools.omp_delegate;
    const state: Record<string, unknown> = {};
    let invalidations = 0;
    const context = { state, toolCallId: "background-call", invalidate: () => invalidations++ };
    const card = tool.renderCall({ agent: "explorer", task: "inspect" }, theme, context);
    const result = await tool.execute("background-call", { agent: "explorer", task: "inspect" }, undefined, undefined, h.ctx);
    expect(result.details.jobId).toBeString();
    expect(result.content[0].text).toContain("started");
    expect(result.content[0].text).toContain("Never use shell sleep or polling");
    expect(result.content[0].text).not.toContain(result.details.jobId);
    expect(h.sentMessages).toHaveLength(0);
    tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    expect(card.render(100).join("\n")).toContain("running");
    await waitFor(() => h.sentMessages.length === 1);
    expect(h.sentMessages[0].message.content).toContain("Specialist read the task");
    expect(h.sentMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(h.sentMessages[0].message.content).not.toContain(result.details.jobId);
    tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    expect(card.render(100).join("\n")).toContain("done");
    expect(invalidations).toBeGreaterThan(0);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("session shutdown cancels background work without sending a stale result", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "300";
  try {
    await h.tools.omp_delegate.execute("background-cancel", { agent: "explorer", task: "inspect" }, undefined, undefined, h.ctx);
    h.handlers.session_shutdown?.({}, h.ctx);
    await Bun.sleep(100);
    expect(h.sentMessages).toHaveLength(0);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("background batches share one three-child limit", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "300";
  try {
    const first = await h.tools.omp_delegate.execute("first-batch", { tasks: [
      { agent: "explorer", task: "one" },
      { agent: "explorer", task: "two" },
      { agent: "explorer", task: "three" },
    ] }, undefined, undefined, h.ctx);
    const theme: any = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
    await waitFor(async () => {
      const card = h.tools.omp_delegate.renderResult(first, { expanded: false, isPartial: true }, theme).render(100).join("\n");
      return (card.match(/running · Explorer task/g) ?? []).length === 3;
    });
    const second = await h.tools.omp_delegate.execute("second-batch", { agent: "explorer", task: "four" }, undefined, undefined, h.ctx);
    const pending = h.tools.omp_delegate.renderResult(second, { expanded: false, isPartial: true }, theme).render(100).join("\n");
    expect(pending).toContain("queued · Explorer task");
    await waitFor(() => h.sentMessages.length === 2, 150);
  } finally {
    h.handlers.session_shutdown?.({}, h.ctx);
    await Bun.sleep(100);
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("council shows live progress and final outputs collapsed without setting a widget", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
  const widgets: unknown[] = [];
  h.ctx.ui.setWidget = (...args: unknown[]) => widgets.push(args);
  const partials: any[] = [];
  const capture = path.join(tmp, "council-capture.json");
  process.env.OMP_TEST_CAPTURE = capture;
  const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  try {
    const tool = h.tools.omp_council;
    const call = tool.renderCall({ question: "如何审查方案？" }, theme).render(80).join("\n");
    expect(call).toContain("Council review");
    expect(call).toContain("0/3");
    expect(call).not.toContain("如何审查方案？");
    const result = await tool.execute("council-123", { question: "如何审查方案？" }, undefined, (partial: any) => partials.push(partial), h.ctx);
    expect(partials[0].content[0].text).toContain("preparing user-language prompts");
    expect(partials[0].details.progress.map((item: AgentProgress) => item.state)).toEqual(["queued", "queued", "queued"]);
    const preparing = tool.renderResult(partials[0], { expanded: false, isPartial: true }, theme).render(100).join("\n");
    expect(preparing).toContain("queued · 0/3");
    expect(preparing.match(/○ queued · Council review/g)).toHaveLength(3);
    expect(h.translations).toHaveLength(1);
    expect(h.translations[0].input.latestUserMessage).toBe("请用中文处理这个任务");
    expect(h.translations[0].input.tasks).toHaveLength(3);
    expect(h.translations[0].input.tasks.every((task: string) => task.includes("如何审查方案？"))).toBe(true);
    expect(Object.keys(h.translations[0].input.prompts)).toEqual(["council"]);
    await waitFor(() => fs.existsSync(capture));
    await waitFor(() => h.sentMessages.length === 1);
    const recorded = JSON.parse(fs.readFileSync(capture, "utf8"));
    expect(recorded.prompt).toContain("请用中文回答");
    expect([1, 2, 3].map((i) => `本地化任务 ${i}: ${h.translations[0].input.tasks[i - 1]}`)).toContain(recorded.args.at(-1));
    expect(result.details.progress.map((item: AgentProgress) => item.task)).toEqual([1, 2, 3].map((i) => `本地化任务 ${i}: ${h.translations[0].input.tasks[i - 1]}`));
    expect(result.usage.cost.total).toBeCloseTo(0.15);
    expect(result.usage.totalTokens).toBe(5);
    expect(h.sentMessages[0].message.content).toContain("3/3 reviewers responded");
    for (const isExpanded of [false, true]) {
      const displayed = tool.renderResult(result, { expanded: isExpanded, isPartial: false }, theme).render(100).join("\n");
      expect(displayed).toContain("Council review 1");
      expect(displayed).toContain("Council review 2");
      expect(displayed).toContain("Council review 3");
      expect(displayed.match(/Specialist read the task/g)).toHaveLength(3);
      expect(displayed).not.toMatch(/read src\/index.ts|Inspecting the code|Activity:|Preview:|Model:|Task:/);
      expect(displayed).not.toContain("Ctrl+Alt+O");
    }
    expect(widgets).toEqual([]);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_CAPTURE;
  }
});

test("specialist failure sets no widget and exposes failure state", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
  const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
  h.ctx.ui.setWidget = (key: string, lines: string[] | undefined) => widgets.push({ key, lines });
  try {
    process.env.OMP_TEST_FAIL = "1";
    const failed = await h.tools.omp_delegate.execute("failed", { agent: "explorer", task: "simulate failure" }, undefined, undefined, h.ctx);
    await waitFor(() => h.sentMessages.length === 1);
    expect(h.sentMessages[0].message.content).toContain("inspect the local conversation viewer");
    expect(h.sentMessages[0].message.content).not.toContain("simulated failure");
    const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    for (const isExpanded of [false, true]) {
      const displayed = h.tools.omp_delegate.renderResult(failed, { expanded: isExpanded, isPartial: false }, theme).render(80).join("\n");
      expect(displayed).toContain("✗ failed · Explorer task");
      expect(displayed).not.toMatch(/stderr|simulated failure|inspect the local conversation viewer|read src\/index.ts/i);
    }
    expect(widgets).toEqual([]);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_FAIL;
  }
});

test("parallel delegation translates all tasks and prompts in one call", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
  try {
    const partials: any[] = [];
    const result = await h.tools.omp_delegate.execute("parallel", { tasks: [
      { agent: "explorer", task: "find files" }, { agent: "oracle", task: "review issue" }, { agent: "librarian", task: "find docs" },
    ] }, undefined, (partial: any) => partials.push(partial), h.ctx);
    expect(partials[0].details.progress.map((item: AgentProgress) => item.state)).toEqual(["queued", "queued", "queued"]);
    const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const queued = h.tools.omp_delegate.renderResult(partials[0], { expanded: false, isPartial: true }, theme).render(100).join("\n");
    expect(queued).toContain("queued · 0/3");
    expect(queued).toContain("Explorer task 1");
    expect(queued).toContain("Oracle task 2");
    expect(queued).toContain("Librarian task 3");
    expect(h.translations).toHaveLength(1);
    expect(h.translations[0].input.tasks).toEqual(["find files", "review issue", "find docs"]);
    expect(Object.keys(h.translations[0].input.prompts)).toEqual(["explorer", "oracle", "librarian"]);
    expect(result.details.progress.map((item: AgentProgress) => item.task)).toEqual(["本地化任务 1: find files", "本地化任务 2: review issue", "本地化任务 3: find docs"]);
    expect(result.usage.cost.total).toBeCloseTo(0.15);
    await waitFor(() => h.sentMessages.length === 1);
    expect(h.sentMessages[0].message.content).toContain("Specialist read the task");
  } finally {
    process.argv[1] = originalArgv;
  }
});

test("clicking one task expands its task and assistant reply inline", () => {
  initTheme();
  const h = harness();
  const theme: any = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => `\x1b[44m${text}\x1b[49m`, bold: (text: string) => text };
  const tasks = [
    { agent: "explorer", task: "first private task" },
    { agent: "oracle", task: "second private task" },
    { agent: "fixer", task: "third private task" },
  ];
  const state: Record<string, unknown> = {};
  let invalidations = 0;
  const context: any = { state, invalidate: () => invalidations++ };
  const tool = h.tools.omp_delegate;
  const mouse = (type: string, y: number, x = 99) => ({ type, button: "left", x, y, screenX: x, screenY: y, width: 100, height: 4, shift: false, alt: false, ctrl: false });

  let call = tool.renderCall({ tasks }, theme, context);
  expect(call.render(100).join("\n")).not.toContain("second private task");
  expect(call.handleMouse(mouse("move", 2))?.handled).toBe(true);
  call = tool.renderCall({ tasks }, theme, context);
  expect(call.render(100)[2]).toContain("\x1b[44m");
  expect(call.render(100)[1]).not.toContain("\x1b[44m");
  expect(call.handleMouse(mouse("move", 1))?.handled).toBe(true);
  call = tool.renderCall({ tasks }, theme, context);
  expect(call.render(100)[1]).toContain("\x1b[44m");
  expect(call.render(100)[2]).not.toContain("\x1b[44m");
  expect(call.handleMouse(mouse("move", 0))?.handled).toBe(true);
  call = tool.renderCall({ tasks }, theme, context);
  expect(call.render(100).join("\n")).not.toContain("\x1b[44m");
  expect(call.handleMouse(mouse("press", 2))?.handled).toBe(true);
  expect(call.handleMouse(mouse("release", 2))?.handled).toBe(true);
  expect(call.handleMouse(mouse("click", 2))?.handled).toBe(true);
  expect(invalidations).toBeGreaterThan(1);
  call = tool.renderCall({ tasks }, theme, context);
  const queued = call.render(100).join("\n");
  expect(queued).toContain("second private task");
  expect(queued).not.toContain("first private task");
  expect(queued).not.toContain("third private task");
  const queuedProgress = tasks.map((task) => ({ ...task, state: "queued", activity: "", text: "", activities: [] }));
  tool.renderResult({ content: [], details: { progress: queuedProgress } }, { expanded: false, isPartial: true }, theme, context);
  expect(call.render(100).join("\n")).toContain("second private task");

  const conversation = startConversation("oracle", "second private task", "model/a");
  conversation.record({ type: "message_end", message: { role: "assistant", content: [
    { type: "text", text: "assistant answer" },
    { type: "toolCall", id: "tool", name: "bash", arguments: { command: "SECRET_COMMAND" } },
  ] } });
  conversation.record({ type: "tool_execution_end", toolCallId: "tool", toolName: "bash", result: { content: "SECRET_RESULT" } });
  const runningProgress = queuedProgress.map((item, index) => index === 1 ? { ...item, state: "running", conversationId: conversation.id } : item);
  tool.renderResult({ content: [], details: { progress: runningProgress } }, { expanded: false, isPartial: true }, theme, context);
  expect(call.render(100).join("\n")).toContain("assistant answer");
  const progress = tasks.map((task, index) => ({ ...task, state: "done", activity: "", text: "", activities: [], ...(index === 1 ? { conversationId: conversation.id } : {}) }));
  const results = tasks.map((task) => ({ agent: task.agent, ok: true, output: "fallback answer" }));
  tool.renderResult({ content: [], details: { progress, results } }, { expanded: false, isPartial: false }, theme, context);
  const expanded = call.render(100).join("\n");
  expect(expanded).toContain("second private task");
  expect(expanded).toContain("assistant answer");
  expect(expanded).not.toMatch(/first private task|third private task|SECRET_COMMAND|SECRET_RESULT|Ctrl\+Alt\+O/);

  expect(call.handleMouse(mouse("press", 2))?.handled).toBe(true);
  expect(call.handleMouse(mouse("click", 2))?.handled).toBe(true);
  call = tool.renderCall({ tasks }, theme, context);
  tool.renderResult({ content: [], details: { progress, results } }, { expanded: false, isPartial: false }, theme, context);
  expect(call.render(100).join("\n")).not.toContain("second private task");
  const failedProgress = progress.map((item, index) => index === 1 ? { ...item, state: "failed" } : item);
  const failedResults = results.map((item, index) => index === 1 ? { ...item, ok: false, output: "SECRET_FAILURE" } : item);
  tool.renderResult({ content: [], details: { progress: failedProgress, results: failedResults } }, { expanded: false, isPartial: false }, theme, context);
  call.render(100);
  expect(call.handleMouse(mouse("press", 2))?.handled).toBe(true);
  expect(call.handleMouse(mouse("click", 2))?.handled).toBe(true);
  call = tool.renderCall({ tasks }, theme, context);
  tool.renderResult({ content: [], details: { progress: failedProgress, results: failedResults } }, { expanded: false, isPartial: false }, theme, context);
  const failed = call.render(100).join("\n");
  expect(failed).toContain("✗ failed · Oracle task 2");
  expect(failed).toContain("second private task");
  expect(failed).toContain("assistant answer");
  expect(failed).not.toContain("SECRET_FAILURE");
  conversation.finish("done");
});

test("preparation errors and cancellation fail closed before launching any child", async () => {
  const h = harness();
  const capture = path.join(tmp, "must-not-launch.json");
  process.env.OMP_TEST_CAPTURE = capture;
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
  try {
    h.ctx.modelRegistry.streamSimple = () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "invalid" }] }) });
    for (const [tool, params] of [["omp_delegate", { agent: "explorer", task: "inspect" }], ["omp_council", { question: "review" }]] as const) {
      await expect(h.tools[tool].execute("bad", params, undefined, undefined, h.ctx)).rejects.toThrow("Invalid language preparation response");
    }
    expect(fs.existsSync(capture)).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(h.tools.omp_delegate.execute("abort", { agent: "explorer", task: "inspect" }, controller.signal, undefined, h.ctx)).rejects.toThrow("Language preparation cancelled");
    expect(fs.existsSync(capture)).toBe(false);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_CAPTURE;
  }
});

test("delegation sums usage and displays failures", () => {
  const u = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 } };
  const results: Result[] = [{ agent: "oracle", model: "openai-codex/gpt-5.5", ok: false, output: "Failed", usage: u }];
  expect(sumUsage(results).cost.total).toBe(0.2);
  expect(formatResults(results)).toContain("FAILED oracle");
});
