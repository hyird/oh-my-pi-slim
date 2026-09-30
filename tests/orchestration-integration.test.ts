import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import omp from "../extensions/omp/index.ts";
import ompEntry from "../extensions/omp/entry.ts";
import { initTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  configPath,
  DEFAULT_CONFIG,
  parseConfig,
  parseModel,
  readConfig,
  updateConfig,
} from "../extensions/omp/config.ts";
import {
  editLineCounts,
  formatResults,
  queuedProgress,
  resolveModel,
  runAgent,
  runAssignments,
  type AgentProgress,
  type Assignment,
  type Result,
} from "../extensions/omp/subagents.ts";
import {
  getChoices,
  getSettingsRows,
  INHERIT,
  INHERIT_THINKING,
} from "../extensions/omp/settings-ui.ts";
import { Box, TruncatedText, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  paintPinnedBackground,
  renderOmpCall,
  renderOmpResult,
  renderOmpToolCall,
  renderPinnedOmpOverview,
  renderPinnedOmpDetail,
} from "../extensions/omp/render.ts";
import { startConversation } from "../extensions/omp/transcript.ts";
import { TaskSessions } from "../extensions/omp/task-sessions.ts";

const savedDir = process.env.PI_CODING_AGENT_DIR;
let tmp: string;
const liveHarnesses: Array<{ handlers: Record<string, any>; ctx: any }> = [];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-"));
  process.env.PI_CODING_AGENT_DIR = tmp;
  // Most integration cases exercise explicit user settings and inheritance.
  fs.writeFileSync(configPath(), "{}\n");
});
afterEach(async () => {
  await Promise.all(liveHarnesses.splice(0).map((h) => h.handlers.session_shutdown({}, h.ctx)));
  if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const models = [
  { provider: "openai-codex", id: "gpt-5.5" },
  { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
] as any[];

test("a parent turn waits locally for the first specialist result instead of cycling goal continuations", async () => {
  const h = harness();
  const argv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  try {
    h.handlers.context?.({ messages: [] }, h.ctx);
    await h.tools.omp_delegate.execute(
      "waiting",
      {
        tasks: [
          { agent: "explorer", task: "[delay=150] first" },
          { agent: "fixer", task: "[delay=5000] later" },
        ],
      },
      undefined,
      undefined,
      h.ctx,
    );
    let ended = false;
    const end = Promise.resolve(h.handlers.agent_end?.({ messages: [] }, h.ctx)).then(() => {
      ended = true;
    });
    await Bun.sleep(40);
    expect(ended).toBe(false);
    await end;
    expect(h.sentMessages).toHaveLength(1);
    expect(h.sentMessages[0]!.message.content).toContain("1 OMP tasks still running");
    // The result is already queued: a boundary before its next context read must not wait twice.
    await h.handlers.agent_end({ messages: [] }, h.ctx);
  } finally {
    process.argv[1] = argv;
  }
});

test.each(["input", "abort", "shutdown"])(
  "local background waiting releases on %s",
  async (action) => {
    const h = harness();
    const argv = process.argv[1];
    process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
    const controller = new AbortController();
    h.ctx.signal = controller.signal;
    try {
      h.handlers.context?.({ messages: [] }, h.ctx);
      await h.tools.omp_delegate.execute(
        "waiting",
        { agent: "fixer", task: "[delay=5000] work" },
        undefined,
        undefined,
        h.ctx,
      );
      let ended = false;
      const end = Promise.resolve(h.handlers.agent_end?.({ messages: [] }, h.ctx)).then(() => {
        ended = true;
      });
      await Bun.sleep(20);
      expect(ended).toBe(false);
      if (action === "input") h.handlers.input({ source: "interactive" }, h.ctx);
      else if (action === "abort") controller.abort();
      else await h.handlers.session_shutdown({}, h.ctx);
      await end;
      expect(ended).toBe(true);
    } finally {
      controller.abort();
      process.argv[1] = argv;
    }
  },
);

function harness() {
  const commands: Record<string, any> = {};
  const shortcuts: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const handlers: Record<string, any> = {};
  const notifications: string[] = [];
  const sentMessages: Array<{ message: any; options: any }> = [];
  const selected: string[] = [];
  const modelCalls: any[] = [];
  const branch: any[] = [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "请用中文处理这个任务" }] },
    },
  ];
  const ctx: any = {
    cwd: tmp,
    model: models[0],
    mode: "tui",
    hasUI: true,
    modelRegistry: {
      getAvailable: () => models,
      streamSimple: (_model: any, request: any, options: any) => {
        modelCalls.push({ request, options });
        throw new Error("Dispatch must not call the main model");
      },
    },
    sessionManager: { getBranch: () => branch },
    isProjectTrusted: () => false,
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus: () => {},
      setWidget: () => {},
      select: async () => undefined,
      input: async () => undefined,
    },
  };
  const pi: any = {
    registerCommand: (name: string, command: any) => {
      commands[name] = command;
    },
    registerShortcut: (key: string, shortcut: any) => {
      shortcuts[key] = shortcut;
    },
    registerTool: (tool: any) => {
      tools[tool.name] = tool;
    },
    sendMessage: (message: any, options: any) => {
      sentMessages.push({ message, options });
    },
    on: (name: string, handler: any) => {
      handlers[name] = handler;
    },
    setModel: async (model: any) => {
      selected.push(`${model.provider}/${model.id}`);
      ctx.model = model;
      return true;
    },
    appendEntry: () => {
      throw new Error("/omp must not modify session state");
    },
  };
  omp(pi);
  const h = {
    ctx,
    commands,
    shortcuts,
    tools,
    handlers,
    notifications,
    sentMessages,
    selected,
    modelCalls,
    branch,
  };
  liveHarnesses.push(h);
  return h;
}

async function waitFor(check: () => boolean | Promise<boolean>, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  expect(await check()).toBe(true);
}

function widgetText(content: any, width = 100): string {
  if (!content) return "";
  if (Array.isArray(content)) return content.join("\n");
  const theme: any = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  return content({ requestRender: () => {} }, theme)
    .render(width)
    .join("\n");
}

describe("config safety", () => {
  test("a new install uses the factory role defaults without sharing mutable config", () => {
    fs.rmSync(configPath());
    expect(readConfig()).toEqual(DEFAULT_CONFIG);
    const first = readConfig();
    first.models.oracle = "other/model";
    expect(readConfig().models.oracle).toBe("openai-codex/gpt-6-astra");
  });
  test("parses defaults and model IDs; rejects invalid roles and models", () => {
    expect(parseConfig({})).toEqual({ defaultAgent: "orchestrator", models: {}, thinking: {} });
    expect(parseModel("openai-codex/gpt-5.5")).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
    expect(parseModel("--model/evil")).toBeUndefined();
    expect(() => parseConfig({ models: { unknown: "openai-codex/gpt-5.5" } })).toThrow();
    expect(() => parseConfig({ defaultAgent: "bad" })).toThrow();
    expect(parseConfig({ defaultAgent: "pi" }).defaultAgent).toBe("pi");
    expect(() => parseConfig({ defaultAgent: "explorer" })).toThrow(
      "defaultAgent must be a main agent",
    );
    expect(() => parseConfig({ models: { fixer: "invalid" } })).toThrow(
      "Invalid models.fixer: expected provider/model-id",
    );
    expect(() => parseConfig([])).toThrow("Config must be a JSON object");
    expect(() => parseConfig({ defaultAgent: 1 })).toThrow("Invalid defaultAgent");
    expect(() => parseConfig({ defaultAgent: "bad" })).toThrow("defaultAgent must be a main agent");
    expect(() => parseConfig({ models: [] })).toThrow("models must be an object");
    expect(parseConfig({ thinking: { explorer: "high" } }).thinking).toEqual({ explorer: "high" });
    expect(() => parseConfig({ thinking: { council: "off" } })).toThrow("Invalid thinking.council");
    expect(() => parseConfig({ models: { council: "openai-codex/gpt-5.5" } })).toThrow(
      "Invalid models.council",
    );
    expect(() => parseConfig({ thinking: { orchestrator: "high" } })).toThrow(
      "Invalid thinking.orchestrator",
    );
    expect(() => parseConfig({ models: { orchestrator: "openai-codex/gpt-5.5" } })).toThrow(
      "Invalid models.orchestrator",
    );
    expect(() => parseConfig({ thinking: { explorer: "ultra" } })).toThrow(
      "Invalid thinking.explorer",
    );
    expect(() => parseConfig({ thinking: { unknown: "high" } })).toThrow(
      "Invalid thinking.unknown",
    );
    expect(() => parseConfig({ thinking: [] })).toThrow("thinking must be an object");
  });
  test("obsolete speed settings are ignored and removed when settings change", async () => {
    const legacy = {
      defaultAgent: "orchestrator",
      models: { explorer: "openai-codex/gpt-6-luna" },
      thinking: { explorer: "low" as const },
      serviceTier: { explorer: "priority", fixer: "default" },
    };
    fs.writeFileSync(configPath(), JSON.stringify(legacy));
    expect(readConfig()).toEqual({
      defaultAgent: "orchestrator",
      models: legacy.models,
      thinking: legacy.thinking,
    });
    await updateConfig((c) => ({ ...c, thinking: { ...c.thinking, explorer: "high" } }));
    expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).not.toHaveProperty("serviceTier");
    for (const serviceTier of [null, [], "fast", { explorer: true }]) {
      expect(parseConfig({ serviceTier })).toEqual(parseConfig({}));
    }
  });
  test("concurrent config writes remain intact", async () => {
    await Promise.all([
      updateConfig((c) => ({
        ...c,
        models: { ...c.models, explorer: "openai-codex/gpt-5.3-codex-spark" },
      })),
      updateConfig((c) => ({
        ...c,
        models: { ...c.models, fixer: "openai-codex/gpt-5.5" },
        thinking: { ...c.thinking, fixer: "high" },
      })),
    ]);
    expect(readConfig().models).toEqual({
      explorer: "openai-codex/gpt-5.3-codex-spark",
      fixer: "openai-codex/gpt-5.5",
    });
    expect(readConfig().thinking).toEqual({ fixer: "high" });
    expect(fs.readdirSync(tmp)).toEqual(["omp.json"]);
  });
  test("saving unchanged settings does not replace the config file", async () => {
    await updateConfig((config) => ({ ...config, defaultAgent: "pi" }));
    const before = fs.statSync(configPath(), { bigint: true });
    await updateConfig((config) => config);
    const after = fs.statSync(configPath(), { bigint: true });
    expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([
      before.ino,
      before.mtimeNs,
      before.ctimeNs,
    ]);
  });
  test("does not overwrite malformed config", async () => {
    fs.writeFileSync(configPath(), "broken {");
    await expect(updateConfig((c) => ({ ...c, defaultAgent: "pi" }))).rejects.toThrow();
    expect(fs.readFileSync(configPath(), "utf8")).toBe("broken {");
  });
});

describe("/omp settings entry point", () => {
  test("children register only websearch, not orchestration or provider tier hooks", async () => {
    const savedChild = process.env.PI_OMP_CHILD;
    const savedTier = process.env.PI_OMP_SERVICE_TIER;
    process.env.PI_OMP_CHILD = "1";
    process.env.PI_OMP_SERVICE_TIER = "priority";
    const registered: string[] = [];
    const pi: any = new Proxy({}, {
      get(_target, name) {
        if (name === "registerTool") return (tool: any) => registered.push(tool.name);
        throw new Error(`Child must not access ${String(name)}`);
      },
    });
    try {
      await ompEntry(pi);
      expect(registered).toEqual(["websearch"]);
      registered.length = 0;
      omp(pi);
      expect(registered).toEqual(["websearch"]);
    } finally {
      if (savedChild === undefined) delete process.env.PI_OMP_CHILD;
      else process.env.PI_OMP_CHILD = savedChild;
      if (savedTier === undefined) delete process.env.PI_OMP_SERVICE_TIER;
      else process.env.PI_OMP_SERVICE_TIER = savedTier;
    }
  });
  test("registers only /omp; rejects subcommands without creating a config file", async () => {
    fs.rmSync(configPath());
    const h = harness();
    expect(Object.keys(h.commands)).toEqual(["omp"]);
    expect(Object.keys(h.shortcuts)).toEqual([]);
    await h.commands.omp.handler("default oracle", h.ctx);
    expect(h.notifications.at(-1)).toContain("Enter /omp without arguments");
    expect(fs.existsSync(configPath())).toBe(false);
  });
  test("settings show one row per delegated role with model and thinking", () => {
    const rows = getSettingsRows();
    expect(rows.map((r) => r.id)).toEqual([
      "default",
      "role:oracle",
      "role:librarian",
      "role:explorer",
      "role:designer",
      "role:fixer",
    ]);
    expect(rows[0].label).toBe("Default main agent");
    expect(rows[0].description).toContain("does not change Pi's current model");
    expect(rows.slice(1).map((row) => row.label)).toEqual([
      "oracle",
      "librarian",
      "explorer",
      "designer",
      "fixer",
    ]);
    expect(rows[1].currentValue).toBe(`${INHERIT} · ${INHERIT_THINKING}`);
    expect(rows[1].description).toContain("Choose the model, then the thinking level");
    expect(getChoices("default", harness().ctx)).toEqual(["pi", "orchestrator", "council"]);
    expect(getChoices("model:explorer", harness().ctx)[0]).toBe(INHERIT);
    expect(getChoices("thinking:explorer", harness().ctx)).toEqual([
      INHERIT_THINKING,
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
  test("specialist model choices and saved overrides respect Pi's enabled models", async () => {
    const h = harness();
    h.ctx.scopedModels = [{ model: models[1] }];
    expect(getChoices("model:explorer", h.ctx)).toEqual([
      INHERIT,
      "openai-codex/gpt-5.3-codex-spark",
    ]);
    await updateConfig((config) => ({ ...config, models: { explorer: "openai-codex/gpt-5.5" } }));
    expect(getChoices("model:explorer", h.ctx)).not.toContain("openai-codex/gpt-5.5");
    expect(getSettingsRows(h.ctx).find((row) => row.id === "role:explorer")?.description).toContain(
      "Configured model is disabled",
    );
    expect(() => resolveModel(h.ctx, "explorer")).toThrow("not enabled or available");
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    expect(readConfig().models.explorer).toBe("openai-codex/gpt-5.3-codex-spark");
    expect(h.notifications.at(-1)).toContain(
      "explorer: openai-codex/gpt-5.5 → openai-codex/gpt-5.3-codex-spark",
    );
    expect(h.modelCalls).toEqual([]);
    h.ctx.mode = "rpc";
    let calls = 0;
    h.ctx.ui.select = async (_title: string, options: string[]) => {
      if (++calls === 1) return options[3];
      if (calls === 2) return "openai-codex/gpt-5.5"; // forged, now disabled
      if (calls === 3) return "high";
      return undefined;
    };
    await h.commands.omp.handler("", h.ctx);
    expect(h.notifications.at(-1)).toContain("not enabled or available");
    expect(readConfig().thinking.explorer).toBeUndefined();
  });
  test("repairs a stale specialist model even if the warning UI is unavailable", async () => {
    const h = harness();
    h.ctx.scopedModels = [{ model: models[1] }];
    await updateConfig((config) => ({ ...config, models: { explorer: "openai-codex/gpt-5.5" } }));
    h.ctx.ui.notify = () => {
      throw new Error("stale notification UI");
    };
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    expect(readConfig().models.explorer).toBe("openai-codex/gpt-5.3-codex-spark");
    await updateConfig((config) => ({ ...config, models: { explorer: "openai-codex/gpt-5.5" } }));
    const originalArgv = process.argv[1];
    process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
    try {
      const result = await h.tools.omp_delegate.execute(
        "stale-model",
        { agent: "explorer", task: "inspect" },
        undefined,
        undefined,
        h.ctx,
      );
      expect(result.details.jobId).toBeString();
      expect(readConfig().models.explorer).toBe("openai-codex/gpt-5.3-codex-spark");
      await waitFor(() => h.sentMessages.length === 1);
    } finally {
      process.argv[1] = originalArgv;
    }
  });
  test("TUI selects model then thinking in one role row and saves both together", async () => {
    const h = harness();
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    let component: any;
    h.ctx.ui.custom = (factory: any) =>
      new Promise<void>((done) => {
        component = factory(
          { requestRender: () => {} },
          { fg: (_: string, text: string) => text, bold: (text: string) => text },
          {},
          done,
        );
      });
    const finished = h.commands.omp.handler("", h.ctx);
    await waitFor(() => Boolean(component));
    expect(component.render(90).join("\n")).toContain("Main agent / specialist settings");
    expect(component.render(90).join("\n")).toContain("Default main agent");
    expect(component.render(90).join("\n")).toContain("explorer");
    expect(component.render(32).length).toBeGreaterThan(1);
    component.handleInput("\r"); // default main Agent picker
    component.handleInput("\x1b[A"); // pi native (only pi/orchestrator are primary)
    component.handleInput("\r");
    await waitFor(() => readConfig().defaultAgent === "pi");
    for (let i = 0; i < 3; i++) component.handleInput("\x1b[B"); // explorer row
    component.handleInput("\r");
    for (const char of "spark") component.handleInput(char);
    expect(component.render(90).join("\n")).toContain("Search models:");
    expect(component.render(90).join("\n")).toContain("gpt-5.3-codex-spark");
    component.handleInput("\r");
    expect(component.render(90).join("\n")).toContain("explorer thinking");
    expect(readConfig().models.explorer).toBeUndefined(); // save after thinking is chosen
    for (let i = 0; i < 5; i++) component.handleInput("\x1b[B"); // high
    component.handleInput("\r");
    expect(component.render(90).join("\n")).not.toContain("explorer speed");
    await waitFor(
      () =>
        readConfig().models.explorer === "openai-codex/gpt-5.3-codex-spark" &&
        readConfig().thinking.explorer === "high",
    );
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
    await updateConfig((c) => ({
      ...c,
      models: { explorer: "openai-codex/gpt-5.3-codex-spark" },
      thinking: { explorer: "high" },
    }));
    const h = harness();
    let component: any;
    let palette = 1;
    const colors: string[] = [];
    h.ctx.ui.custom = (factory: any) =>
      new Promise<void>((done) => {
        component = factory(
          { requestRender: () => {} },
          {
            fg: (color: string, text: string) => {
              colors.push(color);
              return `\x1b[3${palette}m${text}\x1b[39m`;
            },
            bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
          },
          {},
          done,
        );
      });
    const finished = h.commands.omp.handler("", h.ctx);
    await waitFor(() => Boolean(component));
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
    for (let i = 0; i < 3; i++) component.handleInput("\x1b[B");
    expect(
      component
        .render(32)
        .join("\n")
        .replace(/\x1b\[[\d;]*m/g, "")
        .replace(/\s+/g, ""),
    ).toContain("openai-codex/gpt-5.3-codex-spark");
    component.handleInput("\r");
    const picker = component.render(24);
    expect(picker.every((line: string) => visibleWidth(line) <= 24)).toBe(true);
    component.handleInput("\x1b");
    component.handleInput("\x1b");
    await finished;
  });
  test("RPC cannot set a specialist as default even with a forged option", async () => {
    const before = fs.readFileSync(configPath(), "utf8");
    const h = harness();
    h.ctx.mode = "rpc";
    let calls = 0;
    h.ctx.ui.select = async (_title: string, options: string[]) =>
      ++calls === 1 ? options[0] : "fixer";
    await h.commands.omp.handler("", h.ctx);
    expect(readConfig().defaultAgent).toBe("orchestrator");
    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
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
      if (++calls === 1) return options[3]; // explorer role
      if (calls === 2) return "openai-codex/gpt-5.5";
      if (calls === 3) {
        expect(readConfig().models.explorer).toBeUndefined();
        return "high";
      }
      return undefined;
    };
    await h.commands.omp.handler("", h.ctx);
    expect(titles).toEqual([
      "OMP · Main agent / specialist settings (cancel to close)",
      "explorer model",
      "explorer thinking",
      "OMP · Main agent / specialist settings (cancel to close)",
    ]);
    expect(readConfig().models.explorer).toBe("openai-codex/gpt-5.5");
    expect(readConfig().thinking.explorer).toBe("high");
    expect(readConfig()).not.toHaveProperty("serviceTier");
  });
  test("pi main agent cannot launch OMP children even through a stale tool call", async () => {
    await updateConfig((config) => ({ ...config, defaultAgent: "pi" }));
    const h = harness();
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    await expect(
      h.tools.omp_delegate.execute(
        "id",
        { agent: "explorer", task: "inspect" },
        undefined,
        undefined,
        h.ctx,
      ),
    ).rejects.toThrow("disabled while the default agent is pi");
    await expect(
      h.tools.omp_council.execute("id", { question: "review" }, undefined, undefined, h.ctx),
    ).rejects.toThrow("disabled while the default agent is pi");
    expect(h.modelCalls).toEqual([]);
  });
  test("rejects specialist defaults instead of migrating obsolete config", async () => {
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ defaultAgent: "fixer", models: { fixer: "openai-codex/gpt-5.5" } }),
    );
    const h = harness();
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    expect(() => readConfig()).toThrow("defaultAgent must be a main agent");
    const event: any = { systemPromptOptions: { sections: {} } };
    h.handlers.before_agent_start(event);
    expect(event.systemPromptOptions.sections.omp_role).toContain(
      "Active OMP main agent: orchestrator",
    );
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
    await updateConfig((c) => ({
      ...c,
      defaultAgent: "orchestrator",
      models: { fixer: "openai-codex/gpt-5.3-codex-spark" },
    }));
    const h = harness();
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    expect(h.selected).toEqual([]);
    const event: any = { systemPromptOptions: { sections: {} } };
    h.handlers.before_agent_start(event);
    expect(event.systemPromptOptions.sections.omp_role).toContain(
      "Active OMP main agent: orchestrator",
    );
    expect(event.systemPromptOptions.sections.omp_role).toContain(
      "not the default implementation worker",
    );
    expect(event.systemPromptOptions.sections.omp_role).toContain("multi-file implementation");
    expect(event.systemPromptOptions.sections.omp_roster).toContain(
      "Never use shell sleep or polling",
    );
    expect(Object.keys(h.tools).sort()).toEqual(["omp_council", "omp_delegate", "websearch"]);
    await expect(
      h.tools.omp_delegate.execute(
        "id",
        { agent: "bad", task: "test" },
        undefined,
        undefined,
        h.ctx,
      ),
    ).rejects.toThrow();
  });
});

test("isolated child uses the configured specialist model and tool allowlist (offline fake Pi)", async () => {
  const h = harness();
  h.ctx.thinkingLevel = "low";
  await updateConfig((c) => ({
    ...c,
    models: { explorer: "openai-codex/gpt-5.3-codex-spark" },
    thinking: { explorer: "high" },
  }));
  const originalArgv = process.argv[1];
  const capture = path.join(tmp, "capture.json");
  process.env.OMP_TEST_CAPTURE = capture;
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  try {
    const result = await runAgent(h.ctx, { agent: "explorer", task: "find files" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("Specialist read the task");
    expect(result.usage.cost.total).toBe(0.3);
    const recorded = JSON.parse(fs.readFileSync(capture, "utf8"));
    expect(recorded.args).not.toContain("--no-extensions");
    expect(recorded.args).not.toContain("--mcp-config"); // adapter is optional for non-Librarians
    expect(recorded.childGuard).toBe("1");
    expect(recorded.args).toContain("--no-approve");
    expect(recorded.args[recorded.args.indexOf("--tools") + 1]).toBe("read,grep,find,ls,websearch");
    expect(recorded.args[recorded.args.indexOf("--model") + 1]).toBe(
      "openai-codex/gpt-5.3-codex-spark",
    );
    expect(recorded.args[recorded.args.indexOf("--thinking") + 1]).toBe("high");
    expect(recorded.prompt).toContain("You are Explorer");
    h.ctx.isProjectTrusted = () => true;
    const trusted = await runAgent(h.ctx, { agent: "oracle", task: "review" });
    expect(trusted.ok).toBe(true);
    const trustedArgs = JSON.parse(fs.readFileSync(capture, "utf8")).args;
    expect(trustedArgs).toContain("--approve");
    expect(trustedArgs).not.toContain("--no-approve");
    expect(trustedArgs[trustedArgs.indexOf("--thinking") + 1]).toBe("low");
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ defaultAgent: "orchestrator", models: {}, thinking: {} }),
    );
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
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "30";
  try {
    const snapshots: AgentProgress[][] = [];
    const results = await runAssignments(
      h.ctx,
      [
        { agent: "explorer", task: "find auth" },
        { agent: "explorer", task: "find config" },
      ],
      undefined,
      (snapshot) => snapshots.push(snapshot),
    );
    expect(results.map((item) => item.ok)).toEqual([true, true]);
    expect(snapshots[0].map((item) => item.state)).toEqual(["queued", "queued"]);
    expect(snapshots[1][1]).toBe(snapshots[0][1]); // the other queued row is reused
    expect(snapshots[1]).not.toBe(snapshots[0]);
    expect(
      snapshots.every((rows) =>
        rows.every((row) => Object.isFrozen(row) && Object.isFrozen(row.activities) && Object.isFrozen(row.operations)),
      ),
    ).toBe(true);
    expect(
      snapshots.some((snapshot) =>
        snapshot.some((item) => item.activity.includes("read src/index.ts")),
      ),
    ).toBe(true);
    expect(
      snapshots.some((snapshot) =>
        snapshot.some((item) => item.text.includes("Inspecting the code")),
      ),
    ).toBe(true);
    expect(snapshots.at(-1)?.map((item) => item.state)).toEqual(["done", "done"]);
    expect(snapshots.at(-1)?.map((item) => item.task)).toEqual(["find auth", "find config"]);
    expect(
      snapshots
        .at(-1)
        ?.every((item) => Number.isFinite(item.tokensPerSecond) && item.tokensPerSecond! > 0),
    ).toBe(true);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("expanded OMP details show commands and file paths with click-to-wrap, without tool output", async () => {
  initTheme();
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_TOOL_SUMMARY = "1";
  try {
    const snapshots: AgentProgress[][] = [];
    const results = await runAssignments(
      h.ctx,
      [{ agent: "fixer", task: "keep task description" }],
      undefined,
      (snapshot) => snapshots.push(snapshot),
    );
    expect(results[0].ok).toBe(true);
    const progress = snapshots.at(-1)?.[0];
    const file = "src/core/tasks/event-loop/RootTask/WorkerHandle/internal/deeply-nested-source-file.ts";
    const command = "rg -n 'resolveRootTask|WorkerHandle|PMR' src/core/tasks/event-loop.ts src/core/tasks/root-task.ts";
    expect(progress?.operations?.map(({ name, invocation, state, added, removed }) =>
      ({ name, invocation, state, added, removed }))).toEqual([
      { name: "bash", invocation: `bash ${command}`, state: "done", added: undefined, removed: undefined },
      { name: "read", invocation: `read ${file}`, state: "done", added: undefined, removed: undefined },
      { name: "edit", invocation: `edit ${file}`, state: "done", added: 2, removed: 1 },
      { name: "edit", invocation: `edit ${file}`, state: "done", added: 1, removed: 2 },
    ]);
    expect(progress?.operations?.every(Object.isFrozen)).toBe(true);
    expect(snapshots.some((rows) => rows[0].operations?.some((item) =>
      item.name === "edit" && item.state === "running"))).toBe(true);
    const theme: any = { fg: (_: string, value: string) => value, bold: (value: string) => value };
    const state = {};
    const detail = renderPinnedOmpDetail("keep task description", progress, results[0], theme, state);
    const rendered = detail.render(50).join("\n");
    expect(rendered).toContain("keep task description");
    expect(rendered).toContain("Specialist read the task");
    expect(rendered).toContain("▸ bash rg -n");
    expect(rendered).toContain("▸ read src/core/tasks");
    expect(rendered).toContain("▸ edit src/core/tasks");
    expect(rendered.match(/▸ /g)).toHaveLength(4);
    expect(rendered).toContain("...");
    expect(rendered).not.toMatch(/SECRET_|root-task\.ts|deeply-nested-source-file\.ts/);
    const click = (y: number): any => ({ type: "click", button: "left", x: 10, y,
      screenX: 10, screenY: y, width: 50, height: detail.render(50).length });
    const bashRow = detail.render(50).findIndex((line) => line.includes("▸ bash"));
    expect(detail.handleMouse?.(click(bashRow))?.handled).toBe(true);
    const bashExpanded = detail.render(50).join("\n");
    expect(bashExpanded).toContain("▾ bash rg -n");
    expect(bashExpanded).toContain("root-task.ts");
    expect(bashExpanded.replace(/\s/g, "")).toContain(command.replace(/\s/g, ""));
    expect(detail.render(50).length).toBeGreaterThan(rendered.split("\n").length);
    const readRow = detail.render(50).findIndex((line) => line.includes("▸ read"));
    expect(detail.handleMouse?.(click(readRow))?.handled).toBe(true);
    const readExpanded = detail.render(50).map((line) => stripTerminalSequences(line).trim()).join("");
    expect(readExpanded).toContain(file);
    expect(readExpanded).not.toContain("root-task.ts");
    const editRow = detail.render(50).findIndex((line) => line.includes("▸ edit"));
    expect(detail.handleMouse?.(click(editRow))?.handled).toBe(true);
    const editExpanded = detail.render(50).map((line) => stripTerminalSequences(line).trim()).join("");
    expect(editExpanded).toContain(`${file} +2 -1`);
    expect(editExpanded).not.toMatch(/SECRET_/);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_TOOL_SUMMARY;
  }
});

test("short tool paths show colored edit counts after the file without an expand arrow", () => {
  initTheme();
  const theme: any = {
    fg: (color: string, value: string) => color === "toolDiffAdded"
      ? `\x1b[32m${value}\x1b[0m`
      : color === "toolDiffRemoved" ? `\x1b[31m${value}\x1b[0m` : value,
    bold: (value: string) => value,
  };
  const state = {};
  const progress: AgentProgress = {
    agent: "fixer",
    task: "fix router",
    state: "done",
    activity: "",
    text: "",
    activities: [],
    operations: [{
      id: "edit-1",
      name: "edit",
      invocation: "edit tests/web/unit/router/context_dispatch.cpp",
      state: "done",
      added: 8,
      removed: 9,
    }],
  };
  const detail = renderPinnedOmpDetail("fix router", progress, undefined, theme, state);
  const rows = detail.render(80);
  const editRow = rows.find((line) => line.includes("context_dispatch.cpp")) ?? "";
  expect(stripTerminalSequences(editRow).trim()).toBe(
    "edit tests/web/unit/router/context_dispatch.cpp +8 -9",
  );
  expect(editRow).toContain("\x1b[32m +8\x1b[0m");
  expect(editRow).toContain("\x1b[31m -9\x1b[0m");
  expect(editRow).not.toContain("▸");
  const rowIndex = rows.indexOf(editRow);
  const click: any = { type: "click", button: "left", x: 10, y: rowIndex,
    screenX: 10, screenY: rowIndex, width: 80, height: rows.length };
  expect(detail.handleMouse?.(click)?.handled).not.toBe(true);
  expect(state).not.toHaveProperty("expandedOperation");

  const narrow = detail.render(36);
  expect(narrow.some((line) => stripTerminalSequences(line).includes("▸ edit") && line.includes("...")))
    .toBe(true);
});

test("fixed OMP background covers truncated and hovered rows through ANSI resets", () => {
  const colors = { toolSuccessBg: "\x1b[42m", selectedBg: "\x1b[100m" };
  const theme: any = {
    bg: (color: keyof typeof colors, text: string) => colors[color] + text + "\x1b[49m",
    getBgAnsi: (color: keyof typeof colors) => colors[color],
  };
  const backgrounds = (line: string) => {
    let active = "default";
    const cells: string[] = [];
    let offset = 0;
    for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
      cells.push(...Array.from(line.slice(offset, match.index), () => active));
      const codes = match[1] ? match[1].split(";").map(Number) : [0];
      if (codes.includes(0) || codes.includes(49)) active = "default";
      if (codes.includes(42)) active = "base";
      if (codes.includes(100)) active = "selected";
      offset = match.index! + match[0].length;
    }
    cells.push(...Array.from(line.slice(offset), () => active));
    return cells;
  };
  const box = new Box(1, 0, (text) => paintPinnedBackground(theme, "toolSuccessBg", text));
  box.addChild(new TruncatedText("\x1b[37m" + "long command ".repeat(6) + "\x1b[39m"));
  const normal = box.render(28)[0]!;
  expect(normal).toContain("...");
  expect(backgrounds(normal)).toEqual(Array(28).fill("base"));

  const hovered = new Box(1, 0, (text) => paintPinnedBackground(theme, "toolSuccessBg", text));
  hovered.addChild({
    render: (width) => [theme.bg("selectedBg", new TruncatedText("long task ".repeat(8)).render(width)[0]!)],
    invalidate() {},
  });
  const selected = backgrounds(hovered.render(28)[0]!);
  expect(selected).toEqual(["base", ...Array(26).fill("selected"), "base"]);
});

test("edit line counts ignore diff context and unified patch headers", () => {
  expect(editLineCounts({ details: { diff: " 1 context\n-2 old\n+2 new\n+3 new" } }))
    .toEqual({ added: 2, removed: 1 });
  expect(editLineCounts({ details: { patch: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new" } }))
    .toEqual({ added: 1, removed: 1 });
  expect(editLineCounts({ details: { patch: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n--- old\n+++ new" } }))
    .toEqual({ added: 1, removed: 1 });
  expect(editLineCounts({ content: [{ type: "text", text: "+ SECRET_BODY" }] }))
    .toBeUndefined();
});

test("a completion callback failure does not abandon the remaining specialists", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  try {
    const completed: number[] = [];
    const results = await runAssignments(
      h.ctx,
      [
        { agent: "explorer", task: "first" },
        { agent: "explorer", task: "second" },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      (_result, index) => {
        completed.push(index);
        if (index === 0) throw new Error("UI delivery failed");
      },
    );
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(completed.sort()).toEqual([0, 1]);
  } finally {
    process.argv[1] = originalArgv;
  }
});

test("cancelled queued work finishes every task row without launching children", async () => {
  initTheme();
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  const snapshots: AgentProgress[][] = [];
  const items = [
    { agent: "explorer" as const, task: "first" },
    { agent: "fixer" as const, task: "second" },
  ];
  const results = await runAssignments(h.ctx, items, controller.signal, (snapshot) =>
    snapshots.push(snapshot),
  );
  expect(results).toHaveLength(2);
  expect(results.every((item) => item.cancelled)).toBe(true);
  expect(snapshots.at(-1)?.map((item) => item.state)).toEqual(["cancelled", "cancelled"]);
  expect(formatResults(results)).toContain("CANCELLED explorer");
  const theme: any = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const card = renderOmpResult(
    { content: [], details: { progress: snapshots.at(-1), results } } as any,
    { expanded: false, isPartial: false },
    theme,
  )
    .render(100)
    .join("\n");
  expect(card).toContain("cancelled · 2/2");
  expect(card).toContain("■ cancelled · Explorer task 1");
  expect(card).toContain("■ cancelled · Fixer task 2");
});

test("cancelling after one child completes preserves its result and settles the rest", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "60";
  const controller = new AbortController();
  const snapshots: AgentProgress[][] = [];
  try {
    const items = Array.from({ length: 4 }, (_, index) => ({
      agent: "explorer" as const,
      task: `task ${index}`,
    }));
    const results = await runAssignments(h.ctx, items, controller.signal, (snapshot) => {
      snapshots.push(snapshot);
      if (!controller.signal.aborted && snapshot.some((item) => item.state === "done"))
        controller.abort();
    });
    expect(results).toHaveLength(4);
    expect(results.some((item) => item.ok)).toBe(true);
    expect(results.some((item) => item.cancelled)).toBe(true);
    expect(
      snapshots.at(-1)?.every((item) => item.state === "done" || item.state === "cancelled"),
    ).toBe(true);
    expect(formatResults(results)).toContain("OK explorer");
    expect(formatResults(results)).toContain("CANCELLED explorer");
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
    agent: task.agent,
    task: task.task,
    model: "SECRET_MODEL",
    state: index ? "running" : "queued",
    activity: "SECRET_ACTIVITY private-command",
    text: "SECRET_PREVIEW assistant message",
    activities: ["SECRET_ACTIVITY private-command"],
  }));
  const render = (expanded: boolean, isPartial: boolean) =>
    renderOmpResult(
      { content: [{ type: "text", text: "SECRET_RESULT" }], details: { progress } },
      { expanded, isPartial },
      theme,
    )
      .render(120)
      .join("\n");
  const compact = render(false, true);
  expect(compact).toContain("running · 0/2");
  expect(compact).toContain("○ queued · Explorer task 1");
  expect(compact).toContain("⠋ running · Fixer task 2");
  expect(compact).not.toMatch(/SECRET_|private-command|assistant message|Ctrl\+Alt\+O/);
  const expanded = render(true, true);
  expect(expanded).not.toContain("Ctrl+Alt+O");
  expect(expanded).not.toMatch(
    /SECRET_|private-command|assistant message|Activity:|Preview:|Model:|Task:/,
  );

  progress[0].state = "done";
  progress[1].state = "failed";
  const result: any = {
    content: [{ type: "text", text: "SECRET_RESULT" }],
    details: {
      progress,
      results: [
        {
          agent: "explorer",
          ok: true,
          output: "**Final answer**\n\nSafe conclusion.\x9d\x1b]0;SECRET_TITLE",
        },
        { agent: "fixer", ok: false, output: "SECRET_STDERR /private/path" },
      ],
    },
  };
  for (const isExpanded of [false, true]) {
    const finished = renderOmpResult(result, { expanded: isExpanded, isPartial: false }, theme)
      .render(120)
      .join("\n");
    expect(finished).toContain("failed · 2/2");
    expect(finished).toContain("✓ done · Explorer task 1");
    expect(finished).toContain("✗ failed · Fixer task 2");
    expect(finished).toContain("Final answer");
    expect(finished).toContain("Safe conclusion.");
    expect(finished).not.toMatch(
      /SECRET_|private-command|assistant message|\/private\/path|Activity:|Preview:|Model:|Task:|Assistant output:/,
    );
    expect(finished).not.toContain("Ctrl+Alt+O");
    expect(finished.match(/Final answer/g)).toHaveLength(1);
  }
});

test("OMP tool rows replace queued content in place as progress changes", () => {
  initTheme();
  const theme: any = {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
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

    const progress = [
      {
        agent,
        task: "private task",
        model: "private model",
        state: "running",
        activity: "",
        text: "",
        activities: [],
      },
    ];
    const partial = tool.renderResult(
      { content: [], details: { progress } },
      { expanded: false, isPartial: true },
      theme,
      context,
    );
    const running = [...call.render(80), ...partial.render(80)].join("\n");
    expect(running.match(/OMP/g)).toHaveLength(1);
    expect(running).toContain("running · 0/1");
    expect(running).not.toContain("queued");

    const complete = tool.renderResult(
      {
        content: [],
        details: {
          progress: [{ ...progress[0], state: "done" }],
          results: [{ agent, ok: true, output: "Finished" }],
        },
      },
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    const done = [...call.render(80), ...complete.render(80)].join("\n");
    expect(done.match(/OMP/g)).toHaveLength(1);
    expect(done).toContain("done · 1/1");
    expect(done).not.toContain("running");
  }
});

test("the fixed OMP list marks the selected task without inlining its detail", () => {
  initTheme();
  const theme: any = {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  const state: any = {};
  const progress: AgentProgress[] = [
    {
      agent: "explorer",
      task: "inspect private task",
      state: "running",
      activity: "",
      text: "",
      activities: [],
    },
  ];
  const mouse = (type: "press" | "release" | "click"): any => ({
    type,
    button: "left",
    x: 40,
    y: 1,
    screenX: 40,
    screenY: 1,
    width: 80,
    height: 2,
    shift: false,
    alt: false,
    ctrl: false,
  });
  const batch = { kind: "job" as const, progress, isPartial: true, frame: () => 0, state };
  const toggle = (target: any, index: number) => {
    target.expanded = new Set([index]);
  };
  let card = renderPinnedOmpOverview([batch], theme, () => {}, toggle);
  expect(card.render(80).join("\n")).not.toContain("inspect private task");
  card.handleMouse?.(mouse("press"));
  card.handleMouse?.(mouse("release"));
  card.handleMouse?.(mouse("click"));
  card = renderPinnedOmpOverview([batch], theme, () => {}, toggle);
  expect(state.expanded.has(0)).toBe(true);
  expect(card.render(80).join("\n")).toContain("Explorer task ▾");
  expect(card.render(80).join("\n")).not.toContain("inspect private task");
});

test("OMP task rows show measured output token speed without clipping the task name", () => {
  initTheme();
  const theme: any = {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  const progress: AgentProgress[] = [
    {
      agent: "explorer",
      task: "inspect",
      state: "running",
      activity: "",
      text: "",
      activities: [],
      tokensPerSecond: 42.3,
    },
  ];
  const card = renderPinnedOmpOverview(
    [{ kind: "job", progress, isPartial: true, frame: () => 0, state: {} }],
    theme, () => {}, () => {},
  );
  expect(card.render(80).join("\n")).toContain("Explorer task ▸ · 42 token/s");
  expect(card.render(34).join("\n")).toContain("Explorer task ▸");
  expect(card.render(34).join("\n")).not.toContain("token/s");
});

test("OMP task rows show live run time and tokens, then retain final values", () => {
  const theme: any = { fg: (_: string, value: string) => value, bold: (value: string) => value };
  const now = spyOn(Date, "now").mockReturnValue(100_000);
  try {
    const item: AgentProgress = {
      ...queuedProgress([{ agent: "explorer", task: "inspect" }])[0]!,
      state: "running", startedAt: 27_000, totalTokens: 186_000,
      tokensPerSecond: 42.3, phase: "model",
    };
    const pinned = renderPinnedOmpOverview(
      [{ kind: "job", progress: [item], isPartial: true, frame: () => 0, state: {} }],
      theme, () => {}, () => {},
    );
    expect(pinned.render(80).join("\n")).toContain("Explorer task ▸ · 1m 13s · 186k tokens · 42 token/s");
    now.mockReturnValue(103_000);
    expect(pinned.render(80).join("\n")).toContain("1m 16s");
    expect(pinned.render(34).every((line) => visibleWidth(line) <= 34)).toBe(true);
    const completed = { ...item, state: "done" as const, elapsedMs: 76_500 };
    const history = renderOmpResult(
      { content: [], details: { progress: [completed] } },
      { expanded: false, isPartial: false }, theme,
    );
    now.mockReturnValue(200_000);
    expect(history.render(80).join("\n")).toContain("done · Explorer task · 1m 16s · 186k tokens");
  } finally {
    now.mockRestore();
  }
});

test("result-only cards retain run time and tokens after cancellation", () => {
  const theme: any = { fg: (_: string, value: string) => value, bold: (value: string) => value };
  const results: Result[] = [{
    agent: "fixer", model: "test/model", ok: false, cancelled: true, output: "private error",
    usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1010,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timings: { startupMs: 1, generationMs: 20, toolMs: 10, totalMs: 45_000 },
  }];
  const output = renderOmpResult(
    { content: [], details: { progress: [], results } },
    { expanded: false, isPartial: false }, theme,
  ).render(80).join("\n");
  expect(output).toContain("cancelled · Fixer task · 45s · 1.0k tokens");
  expect(output).not.toContain("private error");
});

test("OMP task rows show retries and quiet time without exposing activity text", () => {
  initTheme();
  const theme: any = {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  const item: AgentProgress = {
    agent: "explorer",
    task: "private task",
    state: "running",
    activity: "SECRET_ACTIVITY private-command",
    text: "SECRET_PREVIEW",
    activities: ["SECRET_ACTIVITY private-command"],
    phase: "retrying",
    retry: { attempt: 3, max: 3, delayMs: 8000 },
    lastEventAt: Date.now() - 125_000,
  };
  const pinned = renderPinnedOmpOverview(
    [{ kind: "job", progress: [item], isPartial: true, frame: () => 0, state: {} }],
    theme, () => {}, () => {},
  ).render(120).join("\n");
  expect(pinned).toContain("Explorer task ▸ · no events 2m · retrying 3/3");
  const result = renderOmpResult(
    { content: [], details: { progress: [item] } },
    { expanded: false, isPartial: true }, theme,
  ).render(120).join("\n");
  expect(result).toContain("Explorer task · no events 2m · retrying 3/3");
  expect(pinned + result).not.toMatch(/SECRET_|private-command|private task/);
});

test("OMP main status shows its own measured token speed and resets for a new turn", async () => {
  const h = harness();
  const statuses: string[] = [];
  h.ctx.ui.setStatus = (_key: string, value: string) => {
    statuses.push(value);
  };
  await h.handlers.session_start({ reason: "new" }, h.ctx);
  expect(statuses.at(-1)).toBe("OMP:orchestrator");
  const beforeAgent = () =>
    h.handlers.before_agent_start({ systemPromptOptions: { sections: {} } }, h.ctx);
  beforeAgent();
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  h.handlers.message_update(
    { assistantMessageEvent: { type: "text_delta", partial: { usage: { output: 10 } } } },
    h.ctx,
  );
  expect(statuses.at(-1)).toMatch(/^OMP:orchestrator · [\d.]+ token\/s$/);
  await Bun.sleep(5);
  h.handlers.message_end({ message: { role: "assistant", usage: { output: 25 } } }, h.ctx);
  expect(statuses.at(-1)).toMatch(/^OMP:orchestrator · [\d.]+ token\/s$/);
  beforeAgent();
  expect(statuses.at(-1)).toBe("OMP:orchestrator");
  h.handlers.session_shutdown({ reason: "quit" }, h.ctx);
});

test("a session start finishing after shutdown cannot restore its stale UI", async () => {
  const h = harness();
  const status = spyOn(h.ctx.ui, "setStatus");
  const originalClear = TaskSessions.prototype.clear;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let clears = 0;
  const clear = spyOn(TaskSessions.prototype, "clear").mockImplementation(
    function (this: TaskSessions) {
      return ++clears === 1 ? gate.then(() => originalClear.call(this)) : originalClear.call(this);
    },
  );
  try {
    const starting = h.handlers.session_start({ reason: "new" }, h.ctx);
    expect(clears).toBe(1);
    await h.handlers.session_shutdown({ reason: "quit" }, h.ctx);
    release();
    await starting;
    expect(status).not.toHaveBeenCalled();
  } finally {
    release();
    clear.mockRestore();
    status.mockRestore();
  }
});

test("a closed session cannot repair models after waiting for the config lock", async () => {
  const h = harness();
  await updateConfig((config) => ({
    ...config,
    models: { ...config.models, oracle: "missing/unavailable" },
  }));
  let entered!: () => void;
  const locked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const blocker = withFileMutationQueue(configPath(), async () => {
    entered();
    await gate;
  });
  await locked;
  try {
    const starting = h.handlers.session_start({ reason: "new" }, h.ctx);
    await Bun.sleep(10);
    await h.handlers.session_shutdown({ reason: "quit" }, h.ctx);
    unlock();
    await Promise.all([starting, blocker]);
    expect(readConfig().models.oracle).toBe("missing/unavailable");
    expect(h.notifications).not.toContainEqual(
      expect.stringContaining("switched unavailable specialist models"),
    );
  } finally {
    unlock();
    await blocker;
  }
});

test("OMP rendering tracks theme changes and stays within narrow widths", () => {
  initTheme();
  let palette = 1;
  const colors: string[] = [];
  const theme: any = {
    fg: (color: string, text: string) => {
      colors.push(color);
      return `\x1b[3${palette}m${text}\x1b[39m`;
    },
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  };
  const tasks: any = [{ agent: "explorer", task: "LEAK_COMMAND --key=secret" }];
  const result: any = {
    content: [],
    details: {
      progress: [
        {
          agent: "explorer",
          task: tasks[0].task,
          state: "running",
          model: "private-model",
          activity: "LEAK_ACTIVITY",
          text: "LEAK_PREVIEW",
          activities: ["LEAK_ACTIVITY"],
        },
      ],
    },
  };
  const call = renderOmpCall("OMP delegate", tasks, theme);
  expect(colors).toContain("accent");
  expect(call.render(80).join("\n")).toContain("\x1b[31m");
  palette = 2;
  const updatedCall = renderOmpCall("OMP delegate", tasks, theme);
  const updatedCompact = renderOmpResult(result, { expanded: false, isPartial: true }, theme);
  const updatedExpanded = renderOmpResult(result, { expanded: true, isPartial: true }, theme);
  expect(colors).toContain("warning");
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
  result.details.results = [
    { agent: "explorer", ok: true, output: "**Resolved** with a narrow layout" },
  ];
  for (const isExpanded of [false, true]) {
    const finished = renderOmpResult(
      result,
      { expanded: isExpanded, isPartial: false },
      theme,
    ).render(22);
    expect(finished.every((line: string) => visibleWidth(line) <= 22)).toBe(true);
    expect(finished.join("\n")).toContain("Resolved");
    expect(finished.join("\n")).not.toMatch(/LEAK_|private-model|secret/);
  }
});

test("delegation keeps its completed card fixed until the next user input", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  const widgets: Array<{ key: string; content: any }> = [];
  h.ctx.ui.setWidget = (key: string, content: any) => widgets.push({ key, content });
  const partials: any[] = [];
  const capture = path.join(tmp, "delegate-capture.json");
  process.env.OMP_TEST_CAPTURE = capture;
  const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  try {
    const tool = h.tools.omp_delegate;
    const call = tool
      .renderCall({ agent: "explorer", task: "查看 src/index.ts" }, theme)
      .render(80)
      .join("\n");
    expect(call).toContain("Explorer task");
    expect(call).toContain("0/1");
    expect(call).not.toContain("src/index.ts");
    const result = await tool.execute(
      "call-123",
      { agent: "explorer", task: "查看 src/index.ts" },
      undefined,
      (partial: any) => partials.push(partial),
      h.ctx,
    );
    expect(
      widgets.some(
        (widget) =>
          widget.key === "omp-active" && widgetText(widget.content).includes("Explorer task"),
      ),
    ).toBe(true);
    expect(widgets.map((widget) => widgetText(widget.content)).join("\n")).not.toContain(
      "src/index.ts",
    );
    expect(partials[0].content[0].text).toContain("starting specialists");
    expect(partials[0].details.progress.map((item: AgentProgress) => item.state)).toEqual([
      "queued",
    ]);
    const preparing = tool
      .renderResult(partials[0], { expanded: false, isPartial: true }, theme)
      .render(100)
      .join("\n");
    expect(preparing).toContain("queued · 0/1");
    expect(preparing).toContain("○ queued · Explorer task");
    expect(preparing).not.toContain("Ctrl+Alt+O");
    expect(preparing).not.toContain("starting specialists");
    expect(h.modelCalls).toHaveLength(0);
    await waitFor(() => fs.existsSync(capture));
    await waitFor(() => h.sentMessages.length === 1);
    const recorded = JSON.parse(fs.readFileSync(capture, "utf8"));
    expect(recorded.message).toContain("请用中文处理这个任务");
    expect(recorded.message).toEndWith("Assigned task:\n查看 src/index.ts");
    expect(result.usage).toBeUndefined();
    expect(h.sentMessages[0].message.content).toContain("Specialist read the task");
    for (const isExpanded of [false, true]) {
      const displayed = tool
        .renderResult(result, { expanded: isExpanded, isPartial: false }, theme)
        .render(100)
        .join("\n");
      expect(displayed).toContain("Specialist read the task");
      expect(displayed).not.toMatch(
        /read src\/index.ts|Inspecting the code|Activity:|Preview:|Model:|Task:/,
      );
      expect(displayed.match(/Specialist read the task/g)).toHaveLength(1);
      expect(displayed).not.toContain("Ctrl+Alt+O");
    }
    expect(widgetText(widgets.at(-1)?.content)).toContain("done · Explorer task");
    h.handlers.input({ source: "extension", text: "automatic result" }, h.ctx);
    expect(widgetText(widgets.at(-1)?.content)).toContain("done · Explorer task");
    h.handlers.input({ source: "interactive", text: "next request" }, h.ctx);
    expect(widgets.at(-1)).toEqual({ key: "omp-active", content: undefined });
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_CAPTURE;
  }
});

test("dispatch starts in the fixed card at the height required by its tasks", async () => {
  const h = harness();
  let pinned: any;
  h.ctx.ui.setWidget = (_key: string, content: any) => {
    pinned = content;
  };
  await h.handlers.session_start({ reason: "new" }, h.ctx);
  const tool = h.tools.omp_delegate;
  const theme: any = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  const context = {
    state: {} as any,
    toolCallId: "pending-call",
    invalidate: () => {},
    isPartial: true,
  };
  const args: { tasks: Assignment[] } = {
    tasks: [
      { agent: "explorer", task: "inspect" },
      { agent: "fixer", task: "edit" },
      { agent: "oracle", task: "review" },
    ],
  };
  expect(tool.renderCall(args, theme, context).render(80)).toEqual([]);
  expect(pinned).toBeUndefined();
  h.handlers.tool_execution_start(
    { toolCallId: "pending-call", toolName: "omp_delegate", args },
    h.ctx,
  );
  const initial = widgetText(pinned);
  expect(initial.split("\n")).toHaveLength(6); // box padding + header + three rows
  expect(initial).toContain("queued · Explorer task 1");
  expect(initial).toContain("queued · Fixer task 2");
  expect(initial).toContain("queued · Oracle task 3");
  expect(tool.renderCall(args, theme, context).render(80)).toEqual([]);
  expect(
    tool
      .renderResult(
        { content: [], details: { progress: queuedProgress(args.tasks) } },
        { expanded: false, isPartial: true },
        theme,
        context,
      )
      .render(80),
  ).toEqual([]);
  h.handlers.tool_execution_end(
    {
      toolCallId: "pending-call",
      toolName: "omp_delegate",
      isError: true,
      result: { content: [] },
    },
    h.ctx,
  );
  expect(pinned).toBeUndefined();
  expect(
    tool
      .renderCall(args, theme, { ...context, isPartial: false, isError: true })
      .render(80)
      .join("\n"),
  ).toContain("Explorer task");
});

test("background delegation returns immediately, updates its card and delivers completion", async () => {
  initTheme();
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "100";
  const theme: any = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  let pinned: any;
  h.ctx.ui.setWidget = (_key: string, content: any) => {
    pinned = content;
  };
  try {
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    const tool = h.tools.omp_delegate;
    const state: Record<string, unknown> = {};
    let invalidations = 0;
    const context = { state, toolCallId: "background-call", invalidate: () => invalidations++ };
    const card = tool.renderCall({ agent: "explorer", task: "inspect" }, theme, context);
    expect(tool.renderShell).toBe("self");
    h.handlers.tool_execution_start(
      {
        toolCallId: "background-call",
        toolName: "omp_delegate",
        args: { agent: "explorer", task: "inspect" },
      },
      h.ctx,
    );
    expect(card.render(100)).toEqual([]);
    expect(
      tool.renderCall({ agent: "explorer", task: "inspect" }, theme, context).render(100),
    ).toEqual([]);
    expect(
      tool
        .renderResult(
          {
            content: [],
            details: { progress: queuedProgress([{ agent: "explorer", task: "inspect" }]) },
          },
          { expanded: false, isPartial: true },
          theme,
          context,
        )
        .render(100),
    ).toEqual([]);
    expect(widgetText(pinned)).toContain("queued · Explorer task");
    const result = await tool.execute(
      "background-call",
      { agent: "explorer", task: "inspect" },
      undefined,
      undefined,
      h.ctx,
    );
    expect(result.details.jobId).toBeString();
    expect(result.content[0].text).toContain("started");
    expect(result.content[0].text).toContain("Never use shell sleep or polling");
    expect(result.content[0].text).not.toContain(result.details.jobId);
    expect(h.sentMessages).toHaveLength(0);
    tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    expect(card.render(100)).toEqual([]);
    expect(widgetText(pinned)).toContain("running · Explorer task");
    const backgrounds: string[] = [];
    const fixedCard = pinned(
      { requestRender: () => {} },
      {
        ...theme,
        bg: (color: string, text: string) => {
          backgrounds.push(color);
          return text;
        },
      },
    );
    const fixedLines = fixedCard.render(100);
    expect(backgrounds).toContain("toolSuccessBg");
    expect(fixedLines[0].trim()).toBe("");
    expect(fixedLines[1]).toContain("OMP · running");
    expect(fixedLines.at(-1)?.trim()).toBe("");
    const mouse = (type: "press" | "release" | "click"): any => ({
      type,
      button: "left",
      x: 40,
      y: 2,
      screenX: 40,
      screenY: 2,
      width: 100,
      height: 4,
      shift: false,
      alt: false,
      ctrl: false,
    });
    fixedCard.handleMouse?.(mouse("press"));
    fixedCard.handleMouse?.(mouse("release"));
    fixedCard.handleMouse?.(mouse("click"));
    expect(widgetText(pinned)).toContain("inspect");
    await waitFor(() => h.sentMessages.length === 1);
    expect(h.sentMessages[0].message.content).toContain("Specialist read the task");
    expect(h.sentMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(h.sentMessages[0].message.content).not.toContain(result.details.jobId);
    tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    expect(card.render(100)).toEqual([]);
    expect(widgetText(pinned)).toContain("done · Explorer task");
    h.handlers.input({ source: "extension", text: "automatic completion" }, h.ctx);
    expect(widgetText(pinned)).toContain("done · Explorer task");
    h.handlers.input({ source: "interactive", text: "next message" }, h.ctx);
    const releasedCall = tool.renderCall({ agent: "explorer", task: "inspect" }, theme, {
      ...context,
      isPartial: false,
    });
    tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    expect(releasedCall.render(100).join("\n")).toContain("done");
    expect(releasedCall.render(100).join("\n")).toContain("inspect");
    expect(pinned).toBeUndefined();
    expect(invalidations).toBeGreaterThan(0);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("a new dispatch returns finished batches to chat while keeping batches separate", async () => {
  initTheme();
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  let pinned: any;
  let invalidations = 0;
  h.ctx.ui.setWidget = (_key: string, content: any) => {
    pinned = content;
  };
  const theme: any = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  try {
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    const tool = h.tools.omp_delegate;
    const firstArgs = { agent: "explorer", task: "first batch" };
    const firstContext = {
      state: {} as Record<string, unknown>,
      toolCallId: "first-batch",
      invalidate: () => {
        invalidations++;
      },
    };
    h.handlers.tool_execution_start(
      { toolCallId: "first-batch", toolName: "omp_delegate", args: firstArgs },
      h.ctx,
    );
    const firstResult = await tool.execute("first-batch", firstArgs, undefined, undefined, h.ctx);
    tool.renderResult(firstResult, { expanded: false, isPartial: false }, theme, firstContext);
    await waitFor(() => h.sentMessages.length === 1);
    expect(widgetText(pinned)).toContain("done · Explorer task");

    h.handlers.tool_execution_start(
      {
        toolCallId: "second-batch",
        toolName: "omp_delegate",
        args: { agent: "fixer", task: "second batch" },
      },
      h.ctx,
    );
    const fixed = widgetText(pinned);
    expect(fixed).toContain("queued · Fixer task");
    expect(fixed).not.toContain("Explorer task");
    expect(fixed.match(/OMP/g)).toHaveLength(1);
    const releasedCard = tool.renderCall(firstArgs, theme, { ...firstContext, isPartial: false });
    tool.renderResult(firstResult, { expanded: false, isPartial: false }, theme, firstContext);
    expect(releasedCard.render(100).join("\n")).toContain("done · Explorer task");
    expect(invalidations).toBeGreaterThan(0);
    h.handlers.tool_execution_end(
      {
        toolCallId: "second-batch",
        toolName: "omp_delegate",
        isError: true,
        result: { content: [] },
      },
      h.ctx,
    );
    h.handlers.session_shutdown({ reason: "quit" }, h.ctx);
  } finally {
    process.argv[1] = originalArgv;
  }
});

test("a new dispatch leaves an unfinished earlier batch fixed", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "300";
  let pinned: any;
  h.ctx.ui.setWidget = (_key: string, content: any) => {
    pinned = content;
  };
  try {
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    const tool = h.tools.omp_delegate;
    h.handlers.tool_execution_start(
      {
        toolCallId: "running-first",
        toolName: "omp_delegate",
        args: { agent: "explorer", task: "still working" },
      },
      h.ctx,
    );
    await tool.execute(
      "running-first",
      { agent: "explorer", task: "still working" },
      undefined,
      undefined,
      h.ctx,
    );
    h.handlers.tool_execution_start(
      {
        toolCallId: "queued-second",
        toolName: "omp_delegate",
        args: { agent: "fixer", task: "next batch" },
      },
      h.ctx,
    );
    const fixed = widgetText(pinned);
    expect(fixed).toContain("running · Explorer task");
    expect(fixed).toContain("queued · Fixer task");
    expect((fixed.match(/OMP/g) ?? []).length).toBe(1);
    expect(fixed.indexOf("Explorer task")).toBeLessThan(fixed.indexOf("Fixer task"));
    h.handlers.session_shutdown({ reason: "quit" }, h.ctx);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("combined fixed batches scroll together within half the terminal", () => {
  const h = harness();
  let pinned: any;
  h.ctx.ui.setWidget = (_key: string, content: any) => {
    pinned = content;
  };
  for (let batch = 1; batch <= 3; batch++) {
    h.handlers.tool_execution_start(
      {
        toolCallId: `batch-${batch}`,
        toolName: "omp_delegate",
        args: {
          tasks: Array.from({ length: 3 }, (_, index) => ({
            agent: batch === 3 ? "oracle" : "explorer",
            task: `batch ${batch} task ${index + 1}`,
          })),
        },
      },
      h.ctx,
    );
  }
  const theme: any = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  const card = pinned({ terminal: { rows: 20 }, requestRender: () => {} }, theme);
  expect(card.render(100)).toHaveLength(10);
  expect(card.render(100).join("\n")).toContain("Explorer task 1");
  card.handleMouse?.({
    type: "wheel",
    button: "left",
    x: 10,
    y: 3,
    screenX: 10,
    screenY: 3,
    width: 100,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: 100,
  } as any);
  const scrolled = card.render(100);
  expect(scrolled).toHaveLength(10);
  expect(scrolled.join("\n")).toContain("Oracle task 3");
});

test("long fixed task details scroll within half the terminal and keep task rows clickable", () => {
  initTheme();
  const h = harness();
  let pinned: any;
  h.ctx.ui.setWidget = (_key: string, content: any) => {
    pinned = content;
  };
  const task = Array.from({ length: 60 }, (_, i) => `detail line ${i + 1}`).join("\n");
  h.handlers.tool_execution_start(
    {
      toolCallId: "scroll-call",
      toolName: "omp_delegate",
      args: {
        tasks: [
          { agent: "explorer", task },
          { agent: "fixer", task: "second task detail" },
        ],
      },
    },
    h.ctx,
  );
  const theme: any = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  const tui: any = { terminal: { rows: 20 }, requestRender: () => {} };
  const mouse = (type: string, y: number, wheelDelta = 0): any => ({
    type,
    button: "left",
    x: 10,
    y,
    screenX: 10,
    screenY: y,
    width: 100,
    height: 13,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta,
  });
  let card = pinned(tui, theme);
  expect(card.render(100).join("\n")).toContain("Explorer task 1");
  card.handleMouse?.(mouse("click", 2));
  card = pinned(tui, theme);
  const expandedLines = card.render(100);
  expect(expandedLines).toHaveLength(10);
  expect(expandedLines.join("\n")).toContain("detail line 1");
  expect(expandedLines.join("\n")).toContain("Explorer task 1");
  expect(
    stripTerminalSequences(
      expandedLines.find((line: string) => line.includes("Explorer task 1")) ?? "",
    ),
  ).toContain("Explorer task 1 ▾ ↕ 1–");
  expect(expandedLines.join("\n")).not.toContain("· scroll");
  const narrowRow = card.render(36).find((line: string) => line.includes("Explorer task 1")) ?? "";
  expect(stripTerminalSequences(narrowRow)).toContain("Explorer task 1 ▾");
  expect(stripTerminalSequences(narrowRow)).not.toContain("↕");
  expect(expandedLines.join("\n")).toContain("Fixer task 2");
  expect(expandedLines.findIndex((line: string) => line.includes("Explorer task 1"))).toBeLessThan(
    expandedLines.findIndex((line: string) => line.includes("detail line 1")),
  );
  expect(expandedLines.findIndex((line: string) => line.includes("detail line 1"))).toBeLessThan(
    expandedLines.findIndex((line: string) => line.includes("Fixer task 2")),
  );
  card.handleMouse?.(mouse("wheel", 5, 100));
  card = pinned(tui, theme);
  const scrolled = card.render(100);
  expect(scrolled).toHaveLength(10);
  expect(scrolled.join("\n")).toContain("Explorer task 1");
  expect(scrolled.join("\n")).toContain("Fixer task 2");
  const secondRow = scrolled.findIndex((line: string) => line.includes("Fixer task 2"));
  expect(secondRow).toBeGreaterThanOrEqual(0);
  card.handleMouse?.(mouse("click", secondRow));
  card = pinned(tui, theme);
  const second = card.render(100).join("\n");
  expect(second).toContain("second task detail");
  expect(second).toContain("Explorer task 1 ▸");
  expect(second).toContain("Fixer task 2 ▾");
  expect(second).not.toContain("detail line 60");
  h.handlers.session_shutdown({ reason: "quit" }, h.ctx);
});

test("five fixed tasks keep their order around the expanded second task", () => {
  initTheme();
  const h = harness();
  let pinned: any;
  h.ctx.ui.setWidget = (_key: string, content: any) => {
    pinned = content;
  };
  const longTask = Array.from({ length: 60 }, (_, i) => `detail line ${i + 1}`).join("\n");
  h.handlers.tool_execution_start(
    {
      toolCallId: "five-tasks",
      toolName: "omp_delegate",
      args: {
        tasks: Array.from({ length: 5 }, (_, i) => ({
          agent: "explorer",
          task: i === 1 ? longTask : `task ${i + 1} detail`,
        })),
      },
    },
    h.ctx,
  );
  const theme: any = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  const tui: any = { terminal: { rows: 20 }, requestRender: () => {} };
  const mouse = (type: string, y: number, wheelDelta = 0): any => ({
    type,
    button: "left",
    x: 10,
    y,
    screenX: 10,
    screenY: y,
    width: 100,
    height: 13,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta,
  });
  const rowPositions = (lines: string[]) =>
    Array.from({ length: 5 }, (_, i) =>
      lines.findIndex((line) => line.includes(`Explorer task ${i + 1}`)),
    );
  let card = pinned(tui, theme);
  expect(rowPositions(card.render(100))).toEqual([2, 3, 4, 5, 6]);
  card.handleMouse?.(mouse("click", 3));
  card = pinned(tui, theme);
  const expanded = card.render(100);
  expect(expanded).toHaveLength(10);
  const positions = rowPositions(expanded);
  expect(positions[0]).toBeLessThan(positions[1]);
  expect(positions[1]).toBeLessThan(
    expanded.findIndex((line: string) => line.includes("detail line 1")),
  );
  expect(expanded.findIndex((line: string) => line.includes("detail line 1"))).toBeLessThan(
    positions[2],
  );
  expect(positions.slice(2)).toEqual([6, 7, 8]);
  card.handleMouse?.(mouse("wheel", 6, 100));
  card = pinned(tui, theme);
  const scrolled = card.render(100);
  expect(rowPositions(scrolled)).toEqual(positions);
  expect(scrolled.join("\n")).not.toContain("detail line 1\n");
  h.handlers.session_shutdown({ reason: "quit" }, h.ctx);
});

test("separate dispatches share one OMP heading and expand in launch order", () => {
  initTheme();
  const h = harness();
  let pinned: any;
  h.ctx.ui.setWidget = (_key: string, content: any) => { pinned = content; };
  const batches = [
    { id: "council", name: "omp_council", args: { question: "second review detail" } },
    { id: "fixer", name: "omp_delegate", args: { agent: "fixer", task: "fixer detail" } },
    { id: "explorer", name: "omp_delegate", args: { agent: "explorer", task: "explorer detail" } },
  ];
  for (const batch of batches)
    h.handlers.tool_execution_start(
      { toolCallId: batch.id, toolName: batch.name, args: batch.args }, h.ctx,
    );
  const theme: any = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  const tui: any = { terminal: { rows: 24 }, requestRender: () => {} };
  const taskNames = [
    "Council review 1", "Council review 2", "Council review 3", "Fixer task", "Explorer task",
  ];
  const positions = (lines: string[]) => taskNames.map((name) =>
    lines.findIndex((line) => line.includes(name)));
  let card = pinned(tui, theme);
  const collapsed = card.render(100);
  expect((collapsed.join("\n").match(/OMP/g) ?? []).length).toBe(1);
  expect(collapsed[1]).toContain("0/5");
  expect(positions(collapsed)).toEqual([2, 3, 4, 5, 6]);
  card.handleMouse?.({
    type: "click", button: "left", x: 10, y: 3, screenX: 10, screenY: 3,
    width: 100, height: 12, shift: false, alt: false, ctrl: false,
  });
  card = pinned(tui, theme);
  const expanded = card.render(100);
  const rows = positions(expanded);
  const detail = expanded.findIndex((line: string) => line.includes("second review detail"));
  expect(rows[0]).toBeLessThan(rows[1]);
  expect(rows[1]).toBeLessThan(detail);
  expect(detail).toBeLessThan(rows[2]);
  expect(rows.slice(2)).toEqual([rows[2], rows[2] + 1, rows[2] + 2]);
  h.handlers.session_shutdown({ reason: "quit" }, h.ctx);
});

test("fixed task order survives a later dispatch starting first", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "300";
  let pinned: any;
  h.ctx.ui.setWidget = (_key: string, content: any) => { pinned = content; };
  try {
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    const first = { agent: "explorer", task: "first" };
    const second = { agent: "fixer", task: "second" };
    h.handlers.tool_execution_start(
      { toolCallId: "started-first", toolName: "omp_delegate", args: first }, h.ctx,
    );
    h.handlers.tool_execution_start(
      { toolCallId: "started-second", toolName: "omp_delegate", args: second }, h.ctx,
    );
    await h.tools.omp_delegate.execute("started-second", second, undefined, undefined, h.ctx);
    const fixed = widgetText(pinned);
    expect(fixed.indexOf("Explorer task")).toBeLessThan(fixed.indexOf("Fixer task"));
    expect((fixed.match(/OMP/g) ?? []).length).toBe(1);
    h.handlers.session_shutdown({ reason: "quit" }, h.ctx);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("only one task can stay expanded across dispatches in the fixed OMP overview", () => {
  initTheme();
  const h = harness();
  let pinned: any;
  h.ctx.ui.setWidget = (_key: string, content: any) => {
    pinned = content;
  };
  h.handlers.tool_execution_start(
    {
      toolCallId: "first",
      toolName: "omp_delegate",
      args: { agent: "explorer", task: "first private detail" },
    },
    h.ctx,
  );
  h.handlers.tool_execution_start(
    {
      toolCallId: "second",
      toolName: "omp_delegate",
      args: { agent: "fixer", task: "second private detail" },
    },
    h.ctx,
  );
  const theme: any = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  const tui: any = { terminal: { rows: 30 }, requestRender: () => {} };
  const click = (y: number): any => ({
    type: "click",
    button: "left",
    x: 10,
    y,
    screenX: 10,
    screenY: y,
    width: 100,
    height: 15,
    shift: false,
    alt: false,
    ctrl: false,
  });
  let card = pinned(tui, theme);
  expect(card.render(100).join("\n")).not.toContain("private detail");
  card.handleMouse?.(click(2));
  card = pinned(tui, theme);
  const first = card.render(100).join("\n");
  expect(first).toContain("first private detail");
  expect(first).not.toContain("second private detail");
  const secondRow = card.render(100).findIndex((line: string) => line.includes("Fixer task"));
  card.handleMouse?.(click(secondRow));
  card = pinned(tui, theme);
  const second = card.render(100).join("\n");
  expect(second).toContain("second private detail");
  expect(second).not.toContain("first private detail");
  expect(second).toContain("Explorer task ▸");
  expect(second).toContain("Fixer task ▾");
  h.handlers.session_shutdown({ reason: "quit" }, h.ctx);
});

test("running OMP rows animate like Pi Working and stop after completion", async () => {
  initTheme();
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "300";
  const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  let pinned: any;
  h.ctx.ui.setWidget = (_key: string, content: any) => {
    pinned = content;
  };
  try {
    const tool = h.tools.omp_delegate;
    const context = {
      state: {} as Record<string, unknown>,
      toolCallId: "animated-call",
      invalidate: () => {},
    };
    const card = tool.renderCall({ agent: "explorer", task: "inspect" }, theme, context);
    const result = await tool.execute(
      "animated-call",
      { agent: "explorer", task: "inspect" },
      undefined,
      undefined,
      h.ctx,
    );
    tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    const first = widgetText(pinned, 80);
    expect(first).toContain("running · Explorer task");
    await Bun.sleep(100);
    tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    const second = widgetText(pinned, 80);
    expect(second).toContain("running · Explorer task");
    expect(second).not.toBe(first);
    await waitFor(() => h.sentMessages.length === 1);
    tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    const finished = widgetText(pinned, 80);
    expect(finished).toContain("done · Explorer task");
    await Bun.sleep(100);
    tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    expect(widgetText(pinned, 80)).toBe(finished);
    h.handlers.input({ source: "interactive", text: "next" }, h.ctx);
    tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    expect(card.render(80).join("\n")).toContain("done · Explorer task");
  } finally {
    h.handlers.session_shutdown?.({}, h.ctx);
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("session shutdown cancels background work even when the old UI throws", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "300";
  try {
    h.ctx.ui.setStatus = () => {
      throw new Error("old status UI");
    };
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    h.ctx.ui.setWidget = (_key: string, content: unknown) => {
      if (content === undefined) throw new Error("old widget UI");
    };
    await h.tools.omp_delegate.execute(
      "background-cancel",
      { agent: "explorer", task: "inspect" },
      undefined,
      undefined,
      h.ctx,
    );
    await h.handlers.session_shutdown?.({}, h.ctx);
    await Bun.sleep(100);
    expect(h.sentMessages).toHaveLength(0);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("a failed fixed widget falls back to the tool card and still delivers the result", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  h.ctx.ui.setWidget = () => {
    throw new Error("widget unavailable");
  };
  const theme: any = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  try {
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    const args = { agent: "explorer", task: "inspect" };
    const context = { state: {}, toolCallId: "widget-fallback", invalidate: () => {} };
    h.handlers.tool_execution_start(
      { toolCallId: context.toolCallId, toolName: "omp_delegate", args },
      h.ctx,
    );
    const tool = h.tools.omp_delegate;
    const card = tool.renderCall(args, theme, context);
    expect(card.render(100).join("\n")).toContain("queued · Explorer task");
    const result = await tool.execute(context.toolCallId, args, undefined, undefined, h.ctx);
    tool.renderResult(result, { expanded: false, isPartial: true }, theme, context);
    expect(card.render(100).join("\n")).toContain("Explorer task");
    await waitFor(() => h.sentMessages.length === 1);
    expect(h.sentMessages[0].message.content).toContain("Specialist read the task");
  } finally {
    process.argv[1] = originalArgv;
  }
});

test("tool cards redraw when the fixed widget fails and recovers", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "300";
  const theme: any = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  try {
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    const args = { agent: "explorer", task: "inspect" };
    let invalidations = 0;
    const context = {
      state: {},
      toolCallId: "widget-transition",
      invalidate: () => {
        invalidations++;
      },
    };
    const tool = h.tools.omp_delegate;
    const result = await tool.execute(context.toolCallId, args, undefined, undefined, h.ctx);
    tool.renderResult(result, { expanded: false, isPartial: true }, theme, context);
    expect(tool.renderCall(args, theme, context).render(100)).toEqual([]);
    h.ctx.ui.setWidget = () => {
      throw new Error("widget unavailable");
    };
    h.handlers.tool_execution_start({ toolCallId: "probe", toolName: "omp_delegate", args }, h.ctx);
    expect(invalidations).toBeGreaterThan(0);
    expect(tool.renderCall(args, theme, context).render(100).join("\n")).toContain("Explorer task");
    h.ctx.ui.setWidget = () => {};
    h.handlers.tool_execution_end({ toolCallId: "probe", toolName: "omp_delegate" }, h.ctx);
    expect(tool.renderCall(args, theme, context).render(100)).toEqual([]);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("reload cancels running children without restoring cards or delivering stale results", async () => {
  const firstExtension = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "300";
  let secondExtension: ReturnType<typeof harness> | undefined;
  try {
    await firstExtension.tools.omp_delegate.execute(
      "reload-cancel",
      { agent: "explorer", task: "inspect" },
      undefined,
      undefined,
      firstExtension.ctx,
    );
    firstExtension.handlers.session_shutdown({ reason: "reload" }, firstExtension.ctx);
    secondExtension = harness();
    const restoredWidgets: any[] = [];
    secondExtension.ctx.ui.setWidget = (_key: string, content: any) =>
      restoredWidgets.push(content);
    await secondExtension.handlers.session_start({ reason: "reload" }, secondExtension.ctx);
    await Bun.sleep(400);
    expect(firstExtension.sentMessages).toHaveLength(0);
    expect(secondExtension.sentMessages).toHaveLength(0);
    expect(restoredWidgets.every((content) => !widgetText(content).includes("Explorer task"))).toBe(
      true,
    );
  } finally {
    (secondExtension ?? firstExtension).handlers.session_shutdown(
      { reason: "quit" },
      (secondExtension ?? firstExtension).ctx,
    );
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("background batches start more than three children concurrently", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "300";
  try {
    const first = await h.tools.omp_delegate.execute(
      "first-batch",
      {
        tasks: [
          { agent: "explorer", task: "one" },
          { agent: "explorer", task: "two" },
          { agent: "explorer", task: "three" },
        ],
      },
      undefined,
      undefined,
      h.ctx,
    );
    const theme: any = {
      fg: (_color: string, value: string) => value,
      bold: (value: string) => value,
    };
    await waitFor(async () => {
      const card = h.tools.omp_delegate
        .renderResult(first, { expanded: false, isPartial: true }, theme)
        .render(100)
        .join("\n");
      return (card.match(/running · Explorer task/g) ?? []).length === 3;
    });
    const second = await h.tools.omp_delegate.execute(
      "second-batch",
      { agent: "explorer", task: "four" },
      undefined,
      undefined,
      h.ctx,
    );
    await waitFor(() =>
      h.tools.omp_delegate
        .renderResult(second, { expanded: false, isPartial: true }, theme)
        .render(100)
        .join("\n")
        .includes("running · Explorer task"),
    );
    await waitFor(() => h.sentMessages.length === 2, 150);
  } finally {
    h.handlers.session_shutdown?.({}, h.ctx);
    await Bun.sleep(100);
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("one delegation accepts more than four tasks without a count limit", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "300";
  try {
    const tool = h.tools.omp_delegate;
    expect(tool.parameters.properties.tasks.maxItems).toBeUndefined();
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      agent: "explorer",
      task: `inspect ${index + 1}`,
    }));
    const result = await tool.execute("five-task-batch", { tasks }, undefined, undefined, h.ctx);
    expect(result.details.progress).toHaveLength(5);
    const theme: any = {
      fg: (_color: string, value: string) => value,
      bold: (value: string) => value,
    };
    await waitFor(() => {
      const card = tool
        .renderResult(result, { expanded: false, isPartial: true }, theme)
        .render(100)
        .join("\n");
      return (
        h.sentMessages.length === 0 && (card.match(/running · Explorer task/g) ?? []).length === 5
      );
    });
    await waitFor(() => h.sentMessages.length === 1, 120);
    expect(h.sentMessages[0].message.content.match(/OK explorer/g)).toHaveLength(5);
  } finally {
    h.handlers.session_shutdown?.({}, h.ctx);
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("council moves all reviewer statuses to the fixed card and clears it on completion", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
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
    const result = await tool.execute(
      "council-123",
      { question: "如何审查方案？" },
      undefined,
      (partial: any) => partials.push(partial),
      h.ctx,
    );
    expect(partials[0].content[0].text).toContain("starting specialists");
    expect(partials[0].details.progress.map((item: AgentProgress) => item.state)).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
    const preparing = tool
      .renderResult(partials[0], { expanded: false, isPartial: true }, theme)
      .render(100)
      .join("\n");
    expect(preparing).toContain("queued · 0/3");
    expect(preparing.match(/○ queued · Council review/g)).toHaveLength(3);
    expect(h.modelCalls).toHaveLength(0);
    await waitFor(() => fs.existsSync(capture));
    await waitFor(() => h.sentMessages.length === 1);
    const recorded = JSON.parse(fs.readFileSync(capture, "utf8"));
    expect(recorded.message).toContain("请用中文处理这个任务");
    expect(
      result.details.progress
        .map((item: AgentProgress) => item.task)
        .some((task: string) => recorded.message.endsWith(task)),
    ).toBe(true);
    expect(
      result.details.progress.every((item: AgentProgress) => item.task.includes("如何审查方案？")),
    ).toBe(true);
    expect(result.usage).toBeUndefined();
    expect(h.sentMessages[0].message.content).toContain("3/3 reviewers responded");
    for (const isExpanded of [false, true]) {
      const displayed = tool
        .renderResult(result, { expanded: isExpanded, isPartial: false }, theme)
        .render(100)
        .join("\n");
      expect(displayed).toContain("Council review 1");
      expect(displayed).toContain("Council review 2");
      expect(displayed).toContain("Council review 3");
      expect(displayed.match(/Specialist read the task/g)).toHaveLength(3);
      expect(displayed).not.toMatch(
        /read src\/index.ts|Inspecting the code|Activity:|Preview:|Model:|Task:/,
      );
      expect(displayed).not.toContain("Ctrl+Alt+O");
    }
    expect(widgets.some((entry: any) => widgetText(entry[1]).includes("Council review 3"))).toBe(
      true,
    );
    expect(widgetText((widgets.at(-1) as any)?.[1])).toContain("done · Council review 3");
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_CAPTURE;
  }
});

test("specialist failure clears the pinned status and exposes failure state in the card", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  const widgets: Array<{ key: string; content: any }> = [];
  h.ctx.ui.setWidget = (key: string, content: any) => widgets.push({ key, content });
  try {
    process.env.OMP_TEST_FAIL = "1";
    const failed = await h.tools.omp_delegate.execute(
      "failed",
      { agent: "explorer", task: "simulate failure" },
      undefined,
      undefined,
      h.ctx,
    );
    await waitFor(() => h.sentMessages.length === 1);
    expect(h.sentMessages[0].message.content).toContain("simulated secret failure");
    const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    for (const isExpanded of [false, true]) {
      const displayed = h.tools.omp_delegate
        .renderResult(failed, { expanded: isExpanded, isPartial: false }, theme)
        .render(80)
        .join("\n");
      expect(displayed).toContain("✗ failed · Explorer task");
      expect(displayed).not.toMatch(
        /stderr|simulated failure|Specialist run failed|read src\/index.ts/i,
      );
    }
    expect(widgets.some((entry) => widgetText(entry.content).includes("Explorer task"))).toBe(true);
    expect(widgetText(widgets.at(-1)?.content)).toContain("failed · Explorer task");
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_FAIL;
  }
});

test("parallel delegation preserves all tasks without a preparation model call", async () => {
  const h = harness();
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  try {
    const partials: any[] = [];
    const result = await h.tools.omp_delegate.execute(
      "parallel",
      {
        tasks: [
          { agent: "explorer", task: "find files" },
          { agent: "oracle", task: "review issue" },
          { agent: "librarian", task: "find docs" },
        ],
      },
      undefined,
      (partial: any) => partials.push(partial),
      h.ctx,
    );
    expect(partials[0].details.progress.map((item: AgentProgress) => item.state)).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
    const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const queued = h.tools.omp_delegate
      .renderResult(partials[0], { expanded: false, isPartial: true }, theme)
      .render(100)
      .join("\n");
    expect(queued).toContain("queued · 0/3");
    expect(queued).toContain("Explorer task 1");
    expect(queued).toContain("Oracle task 2");
    expect(queued).toContain("Librarian task 3");
    expect(h.modelCalls).toHaveLength(0);
    expect(result.details.progress.map((item: AgentProgress) => item.task)).toEqual([
      "find files",
      "review issue",
      "find docs",
    ]);
    expect(result.usage).toBeUndefined();
    await waitFor(() => h.sentMessages.length === 1);
    expect(h.sentMessages[0].message.content).toContain("Specialist read the task");
  } finally {
    process.argv[1] = originalArgv;
  }
});

test("clicking one task expands its task and assistant reply inline", () => {
  initTheme();
  const h = harness();
  const theme: any = {
    fg: (_: string, text: string) => text,
    bg: (_: string, text: string) => `\x1b[44m${text}\x1b[49m`,
    bold: (text: string) => text,
  };
  const tasks = [
    { agent: "explorer", task: "first private task" },
    { agent: "oracle", task: "second private task" },
    { agent: "fixer", task: "third private task" },
  ];
  const state: Record<string, unknown> = {};
  let invalidations = 0;
  const context: any = { state, invalidate: () => invalidations++ };
  const tool = h.tools.omp_delegate;
  const mouse = (type: string, y: number, x = 99) => ({
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 100,
    height: 4,
    shift: false,
    alt: false,
    ctrl: false,
  });

  const renderCall = () =>
    renderOmpToolCall("OMP delegate", tasks as any, theme, state as any, context.invalidate);
  let call: any = renderCall();
  expect(call.render(100).join("\n")).not.toContain("second private task");
  expect(call.handleMouse(mouse("move", 2))?.handled).toBe(true);
  call = renderCall();
  expect(call.render(100)[2]).toContain("\x1b[44m");
  expect(call.render(100)[1]).not.toContain("\x1b[44m");
  expect(call.handleMouse(mouse("move", 1))?.handled).toBe(true);
  call = renderCall();
  expect(call.render(100)[1]).toContain("\x1b[44m");
  expect(call.render(100)[2]).not.toContain("\x1b[44m");
  expect(call.handleMouse(mouse("move", 0))?.handled).toBe(true);
  call = renderCall();
  expect(call.render(100).join("\n")).not.toContain("\x1b[44m");
  expect(call.handleMouse(mouse("press", 2))?.handled).toBe(true);
  expect(call.handleMouse(mouse("release", 2))?.handled).toBe(true);
  expect(call.handleMouse(mouse("click", 2))?.handled).toBe(true);
  expect(invalidations).toBeGreaterThan(1);
  call = renderCall();
  const queued = call.render(100).join("\n");
  expect(queued).toContain("second private task");
  expect(queued).not.toContain("first private task");
  expect(queued).not.toContain("third private task");
  const queuedProgress = tasks.map((task) => ({
    ...task,
    state: "queued",
    activity: "",
    text: "",
    activities: [],
  }));
  tool.renderResult(
    { content: [], details: { progress: queuedProgress } },
    { expanded: false, isPartial: true },
    theme,
    context,
  );
  expect(call.render(100).join("\n")).toContain("second private task");

  const conversation = startConversation("oracle", "second private task", "model/a");
  conversation.record({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "assistant answer" },
        { type: "toolCall", id: "tool", name: "bash", arguments: { command: "SECRET_COMMAND" } },
      ],
    },
  });
  conversation.record({
    type: "tool_execution_end",
    toolCallId: "tool",
    toolName: "bash",
    result: { content: "SECRET_RESULT" },
  });
  conversation.flush(); // legacy cards read persisted logs, after the batch is flushed
  const runningProgress = queuedProgress.map((item, index) =>
    index === 1 ? { ...item, state: "running", conversationId: conversation.id } : item,
  );
  tool.renderResult(
    { content: [], details: { progress: runningProgress } },
    { expanded: false, isPartial: true },
    theme,
    context,
  );
  expect(call.render(100).join("\n")).toContain("assistant answer");
  const progress = tasks.map((task, index) => ({
    ...task,
    state: "done",
    activity: "",
    text: "",
    activities: [],
    ...(index === 1 ? { conversationId: conversation.id } : {}),
  }));
  const results = tasks.map((task) => ({ agent: task.agent, ok: true, output: "fallback answer" }));
  tool.renderResult(
    { content: [], details: { progress, results } },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  const expanded = call.render(100).join("\n");
  expect(expanded).toContain("second private task");
  expect(expanded).toContain("assistant answer");
  expect(expanded).not.toMatch(
    /first private task|third private task|SECRET_COMMAND|SECRET_RESULT|Ctrl\+Alt\+O/,
  );

  expect(call.handleMouse(mouse("press", 2))?.handled).toBe(true);
  expect(call.handleMouse(mouse("click", 2))?.handled).toBe(true);
  call = renderCall();
  tool.renderResult(
    { content: [], details: { progress, results } },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  expect(call.render(100).join("\n")).not.toContain("second private task");
  const failedProgress = progress.map((item, index) =>
    index === 1 ? { ...item, state: "failed" } : item,
  );
  const failedResults = results.map((item, index) =>
    index === 1 ? { ...item, ok: false, output: "SECRET_FAILURE" } : item,
  );
  tool.renderResult(
    { content: [], details: { progress: failedProgress, results: failedResults } },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  call.render(100);
  expect(call.handleMouse(mouse("press", 2))?.handled).toBe(true);
  expect(call.handleMouse(mouse("click", 2))?.handled).toBe(true);
  call = renderCall();
  tool.renderResult(
    { content: [], details: { progress: failedProgress, results: failedResults } },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  const failed = call.render(100).join("\n");
  expect(failed).toContain("✗ failed · Oracle task 2");
  expect(failed).toContain("second private task");
  expect(failed).toContain("assistant answer");
  expect(failed).not.toContain("SECRET_FAILURE");
  conversation.finish("done");
});

test("cancelled delegation and Council calls do not launch children", async () => {
  const h = harness();
  const capture = path.join(tmp, "must-not-launch.json");
  process.env.OMP_TEST_CAPTURE = capture;
  const originalArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  try {
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.tools.omp_delegate.execute(
        "abort",
        { agent: "explorer", task: "inspect" },
        controller.signal,
        undefined,
        h.ctx,
      ),
    ).rejects.toThrow("Specialist dispatch cancelled");
    await expect(
      h.tools.omp_council.execute(
        "abort-council",
        { question: "review" },
        controller.signal,
        undefined,
        h.ctx,
      ),
    ).rejects.toThrow("Specialist dispatch cancelled");
    expect(fs.existsSync(capture)).toBe(false);
  } finally {
    process.argv[1] = originalArgv;
    delete process.env.OMP_TEST_CAPTURE;
  }
});

test("delegation displays failures", () => {
  const u = {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 },
  };
  const results: Result[] = [
    { agent: "oracle", model: "openai-codex/gpt-5.5", ok: false, output: "Failed", usage: u },
  ];
  expect(formatResults(results)).toContain("FAILED oracle");
});

test("one animation timer serves concurrent batches without rebuilding unchanged widgets", async () => {
  const h = harness();
  const oldArgv = process.argv[1];
  const oldWait = process.env.OMP_TEST_WAIT_MS;
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_WAIT_MS = "900";
  const realInterval = globalThis.setInterval;
  let timers = 0;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((
    fn: any,
    delay: any,
    ...args: any[]
  ) => {
    if (delay === 80) timers++;
    return realInterval(fn, delay, ...args);
  }) as any);
  let builds = 0;
  let renders = 0;
  let widget: any;
  const theme: any = {
    fg: (_: string, value: string) => value,
    bg: (_: string, value: string) => value,
    bold: (value: string) => value,
  };
  h.ctx.ui.setWidget = (_: string, factory: any) => {
    builds++;
    widget = factory?.(
      {
        terminal: { rows: 30 },
        requestRender: () => {
          renders++;
        },
      },
      theme,
    );
  };
  try {
    await h.tools.omp_delegate.execute(
      "one",
      { agent: "explorer", task: "one" },
      undefined,
      undefined,
      h.ctx,
    );
    await h.tools.omp_delegate.execute(
      "two",
      { agent: "fixer", task: "two" },
      undefined,
      undefined,
      h.ctx,
    );
    expect(timers).toBe(1);
    await Bun.sleep(300); // drain initial child events and progress throttles
    const before = widget.render(90).join("\n");
    const built = builds;
    await Bun.sleep(180);
    expect(builds).toBe(built);
    expect(renders).toBeGreaterThan(0);
    expect(widget.render(90).join("\n")).not.toBe(before);
    await waitFor(() => h.sentMessages.length === 2, 160);
    const after = renders;
    await Bun.sleep(100);
    expect(renders).toBe(after);
    expect(widget.render(90).join("\n")).toContain("done");
  } finally {
    h.handlers.session_shutdown({}, h.ctx);
    interval.mockRestore();
    process.argv[1] = oldArgv;
    if (oldWait === undefined) delete process.env.OMP_TEST_WAIT_MS;
    else process.env.OMP_TEST_WAIT_MS = oldWait;
  }
});

test("dispatch reads configuration and model availability once for a batch", async () => {
  const h = harness();
  await updateConfig((c) => ({ ...c, thinking: { explorer: "high", fixer: "low" } }));
  const oldArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  const originalRead = fs.readFileSync;
  let configReads = 0;
  const read = spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
    if (file === configPath()) configReads++;
    return (originalRead as any)(file, ...args);
  }) as any);
  const available = spyOn(h.ctx.modelRegistry, "getAvailable");
  try {
    await h.tools.omp_delegate.execute(
      "snapshot",
      {
        tasks: [
          { agent: "explorer", task: "one" },
          { agent: "explorer", task: "two" },
          { agent: "fixer", task: "three" },
        ],
      },
      undefined,
      undefined,
      h.ctx,
    );
    await waitFor(() => h.sentMessages.length === 1);
    expect(configReads).toBe(1);
    expect(available).toHaveBeenCalledTimes(1);
  } finally {
    read.mockRestore();
    available.mockRestore();
    process.argv[1] = oldArgv;
  }
});

test("live details reuse assistant previews and markdown components without disk reads", () => {
  initTheme();
  const theme: any = { fg: (_: string, value: string) => value, bold: (value: string) => value };
  const state = {};
  const progress: AgentProgress = {
    ...queuedProgress([{ agent: "explorer", task: "inspect" }])[0],
    conversationId: "recording",
    replyText: "first reply",
  };
  const read = spyOn(fs, "readFileSync");
  try {
    const first = renderPinnedOmpDetail("inspect", progress, undefined, theme, state);
    for (let i = 0; i < 20; i++)
      expect(renderPinnedOmpDetail("inspect", progress, undefined, theme, state)).toBe(first);
    expect(read).not.toHaveBeenCalled();
    progress.replyText = "updated reply";
    const updatedReply = renderPinnedOmpDetail("inspect", progress, undefined, theme, state);
    expect(updatedReply).not.toBe(first);
    progress.operations = Object.freeze([
      Object.freeze({ id: "tool", name: "read", state: "done" as const }),
    ]);
    expect(renderPinnedOmpDetail("inspect", progress, undefined, theme, state)).not.toBe(updatedReply);
  } finally {
    read.mockRestore();
  }
});

test("activity updates still publish immediately after the history reaches its cap", async () => {
  const h = harness();
  const oldArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_ACTIVITIES = "1";
  const snapshots: AgentProgress[][] = [];
  try {
    await runAssignments(
      h.ctx,
      [{ agent: "explorer", task: "activities" }],
      undefined,
      (snapshot) => snapshots.push(snapshot),
    );
    const activities = snapshots
      .map((rows) => rows[0])
      .filter((row) => row.state === "running" && row.activity.startsWith("read file-"));
    expect(new Set(activities.map((row) => row.activity)).size).toBe(35);
    expect(activities.at(-1)?.activities).toHaveLength(32);
    expect(activities[0].activities).toEqual(["read file-0"]);
    expect(snapshots.at(-1)?.[0].state).toBe("done");
  } finally {
    process.argv[1] = oldArgv;
    delete process.env.OMP_TEST_ACTIVITIES;
  }
});

test("released history is retained without scans during dispatch, animation or rendering", async () => {
  initTheme();
  const h = harness();
  const oldArgv = process.argv[1];
  const oldWait = process.env.OMP_TEST_WAIT_MS;
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  delete process.env.OMP_TEST_WAIT_MS;
  // Capture the history map at the dispatch boundary to measure scans without
  // exposing mutable runtime state in the extension's production API.
  let history: Map<string, any> | undefined;
  const originalSet = Map.prototype.set;
  const set = spyOn(Map.prototype, "set").mockImplementation(function (
    this: Map<any, any>,
    key: any,
    value: any,
  ) {
    if (value?.id === key && value?.controller instanceof AbortController) history = this;
    return originalSet.call(this, key, value);
  });
  let scans: ReturnType<typeof spyOn> | undefined;
  let pinned: any;
  let renders = 0;
  const theme: any = {
    fg: (_: string, value: string) => value,
    bg: (_: string, value: string) => value,
    bold: (value: string) => value,
  };
  h.ctx.ui.setWidget = (_: string, factory: any) => {
    pinned = factory?.(
      {
        terminal: { rows: 30 },
        requestRender: () => {
          renders++;
        },
      },
      theme,
    );
  };
  const tool = h.tools.omp_delegate;
  const args = { agent: "explorer", task: "history" };
  let first: any;
  try {
    for (let i = 0; i < 12; i++) {
      const callId = `history-${i}`;
      h.handlers.tool_execution_start(
        { toolCallId: callId, toolName: "omp_delegate", args },
        h.ctx,
      );
      const result = await tool.execute(callId, args, undefined, undefined, h.ctx);
      if (i === 0) {
        first = result;
        set.mockRestore();
        expect(history).toBeDefined();
        scans = spyOn(history!, "values");
      }
      await waitFor(() => h.sentMessages.length === i + 1);
      if (i === 0) {
        const context = {
          state: {},
          toolCallId: "history-0",
          isPartial: false,
          invalidate: () => {},
        };
        tool.renderResult(first, { expanded: false, isPartial: false }, theme, context);
        expect(history?.get(first.details.jobId)?.invalidators.size).toBe(1);
      }
      h.handlers.input({ source: "user" });
      if (i === 0) {
        expect(history?.get(first.details.jobId)?.invalidators.size).toBe(0);
        tool.renderResult(first, { expanded: false, isPartial: false }, theme, {
          state: {},
          toolCallId: "history-0",
          isPartial: false,
          invalidate: () => {},
        });
        expect(history?.get(first.details.jobId)?.invalidators.size).toBe(0);
      }
      expect(pinned).toBeUndefined();
    }
    expect(history?.size).toBe(12);
    process.env.OMP_TEST_WAIT_MS = "500";
    h.handlers.tool_execution_start(
      { toolCallId: "active", toolName: "omp_delegate", args },
      h.ctx,
    );
    await tool.execute("active", args, undefined, undefined, h.ctx);
    await Bun.sleep(200);
    expect(renders).toBeGreaterThan(0);
    const context = { state: {}, toolCallId: "history-0", isPartial: false, invalidate: () => {} };
    const card = tool.renderCall(args, theme, context);
    tool.renderResult(first, { expanded: false, isPartial: false }, theme, context);
    expect(card.render(100).join("\n")).toContain("done · Explorer task");
    await waitFor(() => h.sentMessages.length === 13, 100);
    h.handlers.input({ source: "user" });
    expect(pinned).toBeUndefined();
    expect(scans).not.toHaveBeenCalled();
    scans?.mockRestore();
    scans = undefined;
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    expect(history?.size).toBe(0);
  } finally {
    set.mockRestore();
    scans?.mockRestore();
    h.handlers.session_shutdown({}, h.ctx);
    process.argv[1] = oldArgv;
    if (oldWait === undefined) delete process.env.OMP_TEST_WAIT_MS;
    else process.env.OMP_TEST_WAIT_MS = oldWait;
  }
});

test("fast results unblock the parent while a sibling remains running, without duplicate final delivery", async () => {
  const h = harness();
  const oldArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  try {
    const dispatched = await h.tools.omp_delegate.execute(
      "incremental",
      {
        tasks: [
          { agent: "explorer", task: "[delay=0] fast map" },
          { agent: "librarian", task: "[delay=400] slow research" },
        ],
      },
      undefined,
      undefined,
      h.ctx,
    );
    expect(dispatched.content[0].text).toContain("taskId=");
    await waitFor(() => h.sentMessages.length >= 1);
    expect(h.sentMessages[0].message.content).toContain(
      "1/2 tasks completed; 1 OMP tasks still running",
    );
    expect(h.sentMessages[0].message.content).toContain("OK explorer");
    expect(h.sentMessages[0].message.content).not.toContain("OK librarian");
    await waitFor(() => h.sentMessages.length === 2);
    expect(h.sentMessages[1].message.content).toContain(
      "2/2 tasks completed; 0 OMP tasks still running",
    );
    expect(h.sentMessages[1].message.content).toContain("OK librarian");
    expect(h.sentMessages[1].message.content).not.toContain("OK explorer");
    await Bun.sleep(80);
    expect(h.sentMessages).toHaveLength(2);
  } finally {
    process.argv[1] = oldArgv;
  }
});

test("delegate taskId continues the same worker and rejects reuse after session replacement", async () => {
  const h = harness();
  const oldArgv = process.argv[1];
  const oldCapture = process.env.OMP_TEST_CAPTURE;
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_CAPTURE = path.join(tmp, "continue.json");
  try {
    const result = await h.tools.omp_delegate.execute(
      "first",
      { agent: "fixer", task: "first edit" },
      undefined,
      undefined,
      h.ctx,
    );
    await waitFor(() => h.sentMessages.length === 1);
    const taskId = result.details.progress[0].taskId;
    const initial = JSON.parse(fs.readFileSync(process.env.OMP_TEST_CAPTURE, "utf8"));
    h.branch.push({
      type: "message",
      message: { role: "user", content: "Please continue in English" },
    });
    await h.tools.omp_delegate.execute(
      "continued",
      { agent: "fixer", taskId, task: "follow-up" },
      undefined,
      undefined,
      h.ctx,
    );
    await waitFor(() => h.sentMessages.length === 2);
    const continued = JSON.parse(fs.readFileSync(process.env.OMP_TEST_CAPTURE, "utf8"));
    expect(continued.pid).toBe(initial.pid);
    expect(continued.count).toBe(2);
    expect(continued.message).toContain("Please continue in English");
    expect(continued.prompt).not.toContain("请用中文处理这个任务");
    await h.handlers.session_start({ reason: "new" }, h.ctx);
    await expect(
      h.tools.omp_delegate.execute(
        "stale",
        { agent: "fixer", taskId, task: "stale" },
        undefined,
        undefined,
        h.ctx,
      ),
    ).rejects.toThrow("Unknown taskId");
  } finally {
    process.argv[1] = oldArgv;
    if (oldCapture === undefined) delete process.env.OMP_TEST_CAPTURE;
    else process.env.OMP_TEST_CAPTURE = oldCapture;
  }
});

test("notification retries reuse a completed result without starting new child work", async () => {
  const h = harness();
  const oldArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  let attempts = 0;
  const originalPush = h.sentMessages.push.bind(h.sentMessages);
  h.sentMessages.push = (...items: any[]) => {
    if (++attempts === 1) throw new Error("temporary transport failure");
    return originalPush(...items);
  };
  try {
    await h.tools.omp_delegate.execute(
      "retry-delivery",
      { agent: "fixer", task: "only one run" },
      undefined,
      undefined,
      h.ctx,
    );
    let ended = false;
    const end = h.handlers.agent_end({ messages: [] }, h.ctx).then(() => {
      ended = true;
    });
    await waitFor(() => attempts === 1);
    expect(ended).toBe(false);
    await end;
    expect(h.sentMessages).toHaveLength(1);
    expect(attempts).toBe(2);
    expect(h.sentMessages[0].message.content.match(/OK fixer/g)).toHaveLength(1);
    expect(fs.readdirSync(path.join(tmp, "omp", "conversations"))).toHaveLength(1);
  } finally {
    process.argv[1] = oldArgv;
  }
});

test("a failed notification does not delay another completed task", async () => {
  const h = harness();
  const oldArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  const originalPush = h.sentMessages.push.bind(h.sentMessages);
  let firstId = "";
  let firstFailures = 0;
  let allowFirst = false;
  h.sentMessages.push = (...items: any[]) => {
    if (firstId && items[0].message.content.includes(firstId) && !allowFirst) {
      firstFailures++;
      throw new Error("first notification unavailable");
    }
    return originalPush(...items);
  };
  try {
    const first = await h.tools.omp_delegate.execute(
      "first-delivery",
      { agent: "fixer", task: "first task" },
      undefined,
      undefined,
      h.ctx,
    );
    firstId = first.details.progress[0].taskId;
    await waitFor(() => firstFailures > 0);
    const second = await h.tools.omp_delegate.execute(
      "second-delivery",
      { agent: "fixer", task: "second task" },
      undefined,
      undefined,
      h.ctx,
    );
    const secondId = second.details.progress[0].taskId;
    await waitFor(() => h.sentMessages.length === 1);
    expect(h.sentMessages[0].message.content).toContain(secondId);
    allowFirst = true;
    await waitFor(() => h.sentMessages.length === 2, 150);
    expect(h.sentMessages[1].message.content).toContain(firstId);
  } finally {
    process.argv[1] = oldArgv;
  }
});

test("delivery resumes after six failures even when the warning UI is broken", async () => {
  const h = harness();
  const oldArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  let attempts = 0;
  let warnings = 0;
  const originalPush = h.sentMessages.push.bind(h.sentMessages);
  h.sentMessages.push = (...items: any[]) => {
    if (++attempts <= 6) throw new Error("message transport unavailable");
    return originalPush(...items);
  };
  h.ctx.ui.notify = () => {
    warnings++;
    throw new Error("warning UI unavailable");
  };
  try {
    await h.tools.omp_delegate.execute(
      "failed-delivery",
      { agent: "fixer", task: "one run" },
      undefined,
      undefined,
      h.ctx,
    );
    await waitFor(() => h.sentMessages.length === 1, 250);
    expect(attempts).toBe(7);
    expect(warnings).toBe(1);
    expect(fs.readdirSync(path.join(tmp, "omp", "conversations"))).toHaveLength(1);
  } finally {
    process.argv[1] = oldArgv;
  }
});
