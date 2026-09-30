import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import omp from "../extensions/omp/index.ts";
import { allowedMcpGateway, allowedMcpTool } from "../extensions/omp/mcp-policy.ts";
import { runAgent } from "../extensions/omp/subagents.ts";
import { childMcpConfig } from "../extensions/omp/child-mcp.ts";
import { updateConfig } from "../extensions/omp/config.ts";

const adapter = (name: string) =>
  ({
    name,
    description: name.startsWith("mcp__")
      ? `Namespace-proxy for MCP server "${name.slice(5)}". Forwards calls.`
      : "Direct MCP tool",
    sourceInfo: {
      path: "C:\\Users\\user\\.pi\\agent\\npm\\node_modules\\pi-mcp-adapter\\index.ts",
      source: "package",
      scope: "user",
      origin: "package",
    },
  }) as any;
const builtin = (name: string) =>
  ({
    name,
    sourceInfo: { path: "builtin", source: "builtin", scope: "user", origin: "top-level" },
  }) as any;
const names = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
  "powershell",
  "mcp",
  "mcpScript",
  "mcp__context7",
  "mcp__gh_grep",
  "mcp__playwright",
  "context7_lookup",
  "unknown_direct",
  "omp_delegate",
  "omp_council",
];
const all = names.map((name) =>
  [
    "mcp",
    "mcpScript",
    "mcp__context7",
    "mcp__gh_grep",
    "mcp__playwright",
    "context7_lookup",
    "unknown_direct",
  ].includes(name)
    ? adapter(name)
    : builtin(name),
);
let tmp = "";
const previous = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

function harness() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-test-"));
  process.env.PI_CODING_AGENT_DIR = tmp;
  fs.writeFileSync(path.join(tmp, "omp.json"), "{}\n");
  const handlers: Record<string, any> = {};
  const commands: Record<string, any> = {};
  let active = [...names];
  const pi: any = {
    on: (name: string, handler: any) => {
      handlers[name] = handler;
    },
    registerTool: () => {},
    registerShortcut: () => {},
    registerCommand: (name: string, cmd: any) => {
      commands[name] = cmd;
    },
    getActiveTools: () => [...active],
    getAllTools: () => [...all],
    setActiveTools: (next: string[]) => {
      active = [...next];
    },
  };
  const ctx: any = {
    cwd: tmp,
    mode: "rpc",
    hasUI: true,
    model: { provider: "test", id: "model" },
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "model" }] },
    isProjectTrusted: () => false,
    ui: { setStatus: () => {}, notify: () => {}, select: async () => undefined },
  };
  omp(pi);
  const before = () => {
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    handlers.before_agent_start(event);
    return event;
  };
  const call = (name: string, input: unknown = {}) => handlers.tool_call({ toolName: name, input });
  return { pi, ctx, handlers, commands, before, call, active: () => active };
}

test("orchestrator permits scoped gateway, denies script, context7 direct/namespace and unknown direct", async () => {
  const h = harness();
  await h.handlers.session_start({}, h.ctx);
  expect(h.active()).toContain("mcp__gh_grep");
  expect(h.active()).toContain("mcp__playwright");
  expect(h.active()).toContain("mcp");
  for (const name of ["mcpScript", "mcp__context7", "context7_lookup", "unknown_direct"]) {
    expect(h.active()).not.toContain(name);
    expect(h.call(name)?.block).toBe(true);
  }
  expect(
    h.call("mcp", { server: "playwright", tool: "browser_snapshot", args: {} }),
  ).toBeUndefined();
  expect(
    h.call("mcp", { server: "gh_grep", tool: "search", args: { query: "test" } }),
  ).toBeUndefined();
  for (const server of ["my.server", "团队检索", "team/search"]) {
    expect(h.call("mcp", { server, tool: "search", args: {} })).toBeUndefined();
    expect(h.call("mcp", { server })).toBeUndefined();
  }
  for (const input of [
    {},
    { tool: "search" },
    { search: "browser" },
    { server: "context7", tool: "lookup" },
    { server: "context7", search: "x" },
    { connect: "context7" },
    { server: "playwright", tool: "x", search: "x" },
    { server: "playwright", search: "browser" },
    { server: "gh_grep", describe: "search" },
    { server: "playwright", instructions: true },
    { server: "playwright", tool: "x", args: [] },
    { server: "playwright", tool: "x", args: null },
    { server: "playwright", tool: "x", args: 1 },
    { server: "CONTEXT7", tool: "x" },
    { server: "CoNtExT7", tool: "x" },
    { server: " context7", tool: "x" },
    { server: "context7 ", tool: "x" },
    { server: "", tool: "x" },
    { server: " ", tool: "x" },
    { server: "my.server", search: "x" },
    { tool: "search", args: { server: "my.server" } },
    { server: "团队检索", tool: "search", connect: "my.server" },
    { connect: "playwright", tool: "x" },
    { connect: "playwright", server: "playwright" },
    { server: "playwright", tool: "x", action: "install" },
    { server: "playwright", action: "auth-start" },
    { server: "playwright", url: "https://example.com", tool: "x" },
    { server: "context7", connect: "playwright" },
    { server: "playwright", connect: "context7" },
    { server: "playwright", instructions: "context7" },
    { server: "playwright", args: { tool: "x" } },
    { server: "playwright", tool: "x", target: "global" },
    { server: "playwright", tool: "x", searchMode: "lexical" },
  ])
    expect(h.call("mcp", input)?.block).toBe(true);
  for (const input of [
    { connect: "playwright" },
    { server: "playwright" },
    { connect: "gh_grep" },
    { server: "gh_grep" },
    { server: "playwright", tool: "browser_snapshot", args: "{}" },
    { server: "gh_grep", tool: "search" },
  ]) {
    expect(h.call("mcp", input)).toBeUndefined();
  }
  expect(h.call("mcp__gh_grep")).toBeUndefined();
  expect(h.call("mcp__playwright")).toBeUndefined();
  const rolePrompt = h.before().systemPromptOptions.sections.omp_role;
  expect(rolePrompt).toContain("mcp({server:'gh_grep',tool:'search',args:");
  expect(rolePrompt).toContain(
    "Never use unscoped gateway calls, gateway search/describe/instructions modes, mcpScript, or the context7 server",
  );
  expect(h.call("bash")).toBeUndefined();
  // A tool registered and activated after the first filtering pass is still blocked.
  all.push(adapter("late_direct"));
  h.pi.setActiveTools([...h.active(), "late_direct", "mcpScript"]);
  expect(h.call("late_direct")?.block).toBe(true);
  expect(h.call("mcpScript")?.block).toBe(true);
  h.before();
  expect(h.active()).not.toContain("late_direct");
  all.pop();
});

test("council preserves all Pi builtins; switching to pi restores only previously enabled tools", async () => {
  const h = harness();
  await updateConfig((config) => ({ ...config, defaultAgent: "council" }));
  h.pi.setActiveTools(h.active().filter((name: string) => name !== "unknown_direct"));
  await h.handlers.session_start({}, h.ctx);
  expect(
    h
      .active()
      .filter((name) =>
        ["read", "grep", "find", "ls", "bash", "edit", "write", "powershell"].includes(name),
      ),
  ).toHaveLength(8);
  expect(h.active()).not.toContain("mcp__playwright");
  expect(h.call("mcp__gh_grep")?.block).toBe(true);
  expect(h.active()).not.toContain("mcp");
  expect(h.call("mcp", { server: "playwright", tool: "browser_snapshot" })?.block).toBe(true);
  expect(h.call("mcp", { connect: "gh_grep" })?.block).toBe(true);
  // Moving from council to orchestrator restores the gateway without restoring direct tools.
  await updateConfig((config) => ({ ...config, defaultAgent: "orchestrator" }));
  await h.handlers.session_start({}, h.ctx);
  expect(h.active()).toContain("mcp");
  expect(h.active()).not.toContain("context7_lookup");
  expect(h.call("mcp", { server: "gh_grep", tool: "search" })).toBeUndefined();
  await updateConfig((config) => ({ ...config, defaultAgent: "council" }));
  await h.handlers.session_start({}, h.ctx);
  // Switch using /omp RPC's settings picker, not by mutating the internal role.
  let picks = 0;
  // Picker option is a formatted row; use its actual first entry.
  h.ctx.ui.select = async (_title: string, options: string[]) =>
    ++picks === 1 ? options[0] : "pi";
  await h.commands.omp.handler("", h.ctx);
  expect(h.call("mcp")?.block).not.toBe(true);
  expect(h.active()).toContain("mcp__playwright");
  expect(h.active()).not.toContain("unknown_direct");
  expect(h.active()).not.toContain("omp_delegate");
  expect(h.active()).not.toContain("omp_council");
  expect(h.call("omp_delegate")?.block).toBe(true);
  expect(h.call("omp_council")?.block).toBe(true);
  h.pi.setActiveTools(h.active().filter((name: string) => name !== "bash"));
  await h.handlers.session_start({}, h.ctx); // role from config is now pi
  expect(h.before().systemPromptOptions.sections.omp_role).toBeUndefined();
  expect(h.active()).not.toContain("bash");
  await updateConfig((config) => ({ ...config, defaultAgent: "orchestrator" }));
  await h.handlers.session_start({}, h.ctx);
  expect(h.active()).toContain("omp_delegate");
  expect(h.active()).toContain("omp_council");
});

test("unattributed namespace and direct tools fail closed", () => {
  expect(allowedMcpTool("mcp__gh_grep", "orchestrator", [])).toBe(false);
  expect(allowedMcpTool("mcp__context7", "orchestrator", all)).toBe(false);
  expect(allowedMcpTool("context7_lookup", "orchestrator", all)).toBe(false);
  expect(allowedMcpTool("mcp", "pi", all)).toBe(true);
  expect(allowedMcpTool("mcp", "orchestrator", [])).toBe(false);
  expect(allowedMcpGateway({ server: "context7", tool: "x", args: {} })).toBe(false);
  expect(
    allowedMcpTool("mcp__gh_grep", "orchestrator", [
      { ...adapter("mcp__gh_grep"), description: "Direct MCP tool" },
    ]),
  ).toBe(false);
});

test("native MCP namespaces remain enforced for direct and nested calls and resources", async () => {
  const h = harness();
  const native = (name: string, server?: string) => ({
    ...builtin(name),
    sourceInfo: { ...builtin(name).sourceInfo, path: "builtin:mcp" },
    namespace: server ? { name: `mcp__${server}` } : undefined,
    exposure: "deferred",
  });
  const tools = [
    native("mcp__gh_grep__searchGitHub", "gh_grep"),
    native("mcp__CONTEXT7__resolve", "CONTEXT7"),
    native("mcp__a_long_shortened_tool_12345678", "context7"),
    native("mcp__unattributed__tool"),
    ...["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].map((name) => native(name)),
  ];
  h.pi.getAllTools = () => [...all, ...tools];
  h.pi.setActiveTools([...h.active(), ...tools.map((tool) => tool.name)]);
  await h.handlers.session_start({}, h.ctx);
  expect(h.active()).toContain("mcp__gh_grep__searchGitHub");
  for (const parentToolCallId of [undefined, "codemode-call/1"]) {
    const call = (toolName: string, input = {}) => h.handlers.tool_call({ toolName, input, parentToolCallId });
    expect(call("mcp__gh_grep__searchGitHub")).toBeUndefined();
    for (const name of ["mcp__CONTEXT7__resolve", "mcp__a_long_shortened_tool_12345678", "mcp__unattributed__tool"]) {
      expect(call(name)?.block).toBe(true);
      expect(h.active()).not.toContain(name);
    }
    for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
      expect(call(name, { server: "gh_grep" })).toBeUndefined();
      for (const input of [{}, { server: "context7" }, { server: "CONTEXT7" }, { server: " gh_grep" }]) {
        expect(call(name, input)?.block).toBe(true);
      }
    }
  }
  await updateConfig((config) => ({ ...config, defaultAgent: "council" }));
  await h.handlers.session_start({}, h.ctx);
  for (const tool of tools) expect(h.call(tool.name, { server: "gh_grep" })?.block).toBe(true);
  await updateConfig((config) => ({ ...config, defaultAgent: "pi" }));
  await h.handlers.session_start({}, h.ctx);
  expect(h.active()).toContain("mcp__gh_grep__searchGitHub");
  expect(h.call("mcp__CONTEXT7__resolve")).toBeUndefined();
});

test("namespace context7 denial uses the declared server, not a case-sensitive name prefix", () => {
  expect(allowedMcpTool("mcp__context7_foo", "orchestrator", [adapter("mcp__context7_foo")])).toBe(
    true,
  );
  expect(allowedMcpTool("mcp__CONTEXT7", "orchestrator", [adapter("mcp__CONTEXT7")])).toBe(false);
  expect(
    allowedMcpTool("mcp__context7_foo", "orchestrator", [
      {
        ...adapter("mcp__context7_foo"),
        description: 'Namespace-proxy for MCP server "context7". Forwards calls.',
      },
    ]),
  ).toBe(false);
  expect(
    allowedMcpTool("mcp__CONTEXT7", "orchestrator", [
      { ...adapter("mcp__CONTEXT7"), description: "Direct MCP tool" },
    ]),
  ).toBe(false);
});

test("native child MCP config is role-scoped and librarian launch uses only its scoped gateway", async () => {
  const librarian = childMcpConfig("librarian");
  expect(librarian.servers).toHaveLength(1);
  expect(librarian.servers[0]).toMatchObject({
    name: "gh_grep",
    config: {
      url: "https://mcp.grep.app",
      exposure: "hidden",
      toolExposure: { "*": "hidden", searchGitHub: "deferred" }
    },
  });
  expect(librarian.autoEnableCodemode).toBe(false);
  for (const role of ["explorer", "oracle", "designer", "fixer", "council"])
    expect(childMcpConfig(role).servers).toEqual([]);
  expect(() => childMcpConfig("unknown")).toThrow("Invalid OMP child role");

  const h = harness();
  const savedArgv = process.argv[1];
  const capture = path.join(tmp, "capture.json");
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_CAPTURE = capture;
  process.env.OMP_TEST_WAIT_MS = "250";
  try {
    const result = await runAgent(h.ctx, { agent: "librarian", task: "research" });
    expect(result.ok).toBe(true);
    const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
    const args: string[] = captured.args;
    expect(args).not.toContain("--mcp-config");
    expect(args).toContain("--extension");
    expect(captured.childGuard).toBe("1");
    expect(captured.childRole).toBe("librarian");
    expect(args[args.indexOf("--tools") + 1].split(",")).toEqual([
      "read", "grep", "find", "ls", "bash", "websearch", "mcp", "mcp__gh_grep__searchGitHub",
    ]);
    expect(args[args.indexOf("--tools") + 1]).not.toMatch(/context7|mcpScript|codemode|tool_search|list_mcp/);
    expect(captured.prompt).toContain("mcp({server:'gh_grep',tool:'search',args:");
    expect(captured.prompt).toContain("If the scoped gateway is unavailable");

    for (const role of ["explorer", "oracle", "designer", "fixer", "council"] as const) {
      await runAgent(h.ctx, { agent: role, task: "review" });
      const other = JSON.parse(fs.readFileSync(capture, "utf8"));
      const tools = other.args[other.args.indexOf("--tools") + 1];
      expect(other.childRole).toBe(role);
      expect(other.args).not.toContain("--mcp-config");
      expect(tools).not.toMatch(/(^|,)(mcp|mcpScript|codemode|tool_search|mcp__[^,]+|list_mcp_resources)(,|$)/);
    }
  } finally {
    process.argv[1] = savedArgv;
    delete process.env.OMP_TEST_CAPTURE;
    delete process.env.OMP_TEST_WAIT_MS;
  }
});

test("OMP native MCP isolation extension errors terminate only the scoped child", async () => {
  const h = harness();
  const savedArgv = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
  process.env.OMP_TEST_MCP_EXTENSION_ERROR = "1";
  try {
    const result = await runAgent(h.ctx, { agent: "librarian", task: "collision" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("fixture command collision");
    expect(result.output).toContain("access_token=[redacted]");
    expect(result.output).not.toContain("fixture-secret");
    expect(result.output).not.toContain("child extension reported a runtime error");
    const conversations = fs.readdirSync(path.join(tmp, "omp", "conversations"));
    expect(conversations).toHaveLength(1);
    const log = fs.readFileSync(path.join(tmp, "omp", "conversations", conversations[0]!), "utf8");
    expect(log).toContain("fixture command collision");
    expect(log).toContain("access_token=[redacted]");
    expect(log).not.toContain("fixture-secret");
  } finally {
    process.argv[1] = savedArgv;
    delete process.env.OMP_TEST_MCP_EXTENSION_ERROR;
  }
});
