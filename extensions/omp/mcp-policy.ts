import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { MainAgent } from "./roles.ts";

const gatewayNames = new Set(["mcp", "mcpScript"]);
const ompToolNames = new Set(["omp_delegate", "omp_council"]);

/** Allow only server-bound calls, lists and connections. Reject all other dispatch modes
 * (including search/describe, which may search outside the selected server). */
export function allowedMcpGateway(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const params = input as Record<string, unknown>;
  const validServer = (value: unknown): value is string =>
    typeof value === "string" &&
    !!value &&
    value === value.trim() &&
    !/[\x00-\x1f\x7f-\x9f]/.test(value) &&
    value.toLowerCase() !== "context7";
  if (Object.hasOwn(params, "connect"))
    return Object.keys(params).length === 1 && validServer(params.connect);
  if (!validServer(params.server)) return false;
  if (Object.hasOwn(params, "tool"))
    return (
      Object.keys(params).every((key) => ["server", "tool", "args"].includes(key)) &&
      typeof params.tool === "string" &&
      !!params.tool.trim() &&
      (!Object.hasOwn(params, "args") ||
        typeof params.args === "string" ||
        (typeof params.args === "object" && params.args !== null && !Array.isArray(params.args)))
    );
  return Object.keys(params).length === 1;
}
const builtins = new Set(["read", "grep", "find", "ls", "bash", "edit", "write", "powershell"]);

function adapterTool(tool: ToolInfo | undefined): boolean {
  const info = tool?.sourceInfo;
  return (
    !!info &&
    [info.path, info.source, info.baseDir].some(
      (value) => typeof value === "string" && /(^|[\\/])pi-mcp-adapter([\\/]|$)/i.test(value),
    )
  );
}

function nativeMcpTool(tool: ToolInfo | undefined): boolean {
  return tool?.sourceInfo?.path === "builtin:mcp";
}

const resourceNames = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

function allowedResourceServer(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const server = (input as Record<string, unknown>).server;
  return typeof server === "string" && /^[A-Za-z0-9_-]+$/.test(server)
    && server.toLowerCase() !== "context7";
}

/** Native MCP uses host-owned namespaces; legacy adapter direct tools lack server metadata. */
export function allowedMcpTool(name: string, role: MainAgent, tools: readonly ToolInfo[]): boolean {
  if (role === "pi") return !ompToolNames.has(name);
  const tool = tools.find((item) => item.name === name);
  if (nativeMcpTool(tool)) {
    if (role !== "orchestrator") return false;
    if (resourceNames.has(name)) return true; // tool_call checks the explicit server below.
    // The host namespace remains authoritative when a long tool name is shortened.
    const server = tool?.namespace?.name.match(/^mcp__([A-Za-z0-9_-]+)$/)?.[1];
    return !!server && server.toLowerCase() !== "context7" && name.startsWith("mcp__");
  }
  if (gatewayNames.has(name))
    return (
      name === "mcp" &&
      role === "orchestrator" &&
      adapterTool(tools.find((tool) => tool.name === name))
    );
  if (name.startsWith("mcp__"))
    return (
      role === "orchestrator" &&
      tools.some((tool) => {
        if (tool.name !== name || !adapterTool(tool)) return false;
        const server = tool.description?.match(/^Namespace-proxy for MCP server "([^"]+)"\./)?.[1];
        return (
          !!server &&
          server.toLowerCase() !== "context7" &&
          server.replace(/-/g, "_") === name.slice(5)
        );
      })
    );
  if (adapterTool(tool)) return false; // direct tools have no reliable server identity
  // A source-less extension tool may be a late-registered direct MCP tool.
  if (tool && !tool.sourceInfo && !builtins.has(name) && !name.startsWith("omp_")) return false;
  return true;
}

export function installMcpPolicy(
  pi: ExtensionAPI,
  currentRole: () => MainAgent,
): (role: MainAgent) => void {
  const suppressed = new Set<string>();
  const reconcile = (role: MainAgent) => {
    // Older embedders may not expose tool introspection; never widen their tool set.
    if (!pi.getActiveTools || !pi.getAllTools || !pi.setActiveTools) return;
    const active = pi.getActiveTools();
    if (role === "pi") {
      const available = new Set(pi.getAllTools().map((tool) => tool.name));
      const restore = [
        ...active,
        ...[...suppressed].filter(
          (name) => !ompToolNames.has(name) && available.has(name) && !active.includes(name),
        ),
      ];
      for (const name of restore) if (ompToolNames.has(name)) suppressed.add(name);
      for (const name of [...suppressed]) if (!ompToolNames.has(name)) suppressed.delete(name);
      const next = restore.filter((name) => !ompToolNames.has(name));
      if (next.length !== active.length || next.some((name, i) => name !== active[i]))
        pi.setActiveTools(next);
      return;
    }
    const tools = pi.getAllTools();
    const restored = [
      ...active,
      ...[...suppressed].filter(
        (name) =>
          tools.some((tool) => tool.name === name) &&
          !active.includes(name) &&
          allowedMcpTool(name, role, tools),
      ),
    ];
    for (const name of restored) suppressed.delete(name);
    const denied = restored.filter((name) => !allowedMcpTool(name, role, tools));
    for (const name of denied) suppressed.add(name);
    const next = restored.filter((name) => !denied.includes(name));
    if (next.length !== active.length || next.some((name, i) => name !== active[i]))
      pi.setActiveTools(next);
  };
  pi.on("tool_call", (event) => {
    const role = currentRole();
    if (
      !allowedMcpTool(event.toolName, role, pi.getAllTools?.() ?? []) ||
      (role !== "pi" && event.toolName === "mcp" && !allowedMcpGateway(event.input)) ||
      (role !== "pi" && resourceNames.has(event.toolName) && !allowedResourceServer(event.input))
    ) {
      return { block: true, reason: `OMP ${role} MCP policy denies ${event.toolName}` };
    }
  });
  return reconcile;
}
