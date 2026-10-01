import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  createMcpExtension,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type LoadedMcpConfig,
  type McpServerEntry,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { isRole } from "./roles.ts";
import { MCP_ISOLATION_ERROR_MARKER, mcpIsolationError } from "./mcp-isolation.ts";

const MCP_TARGET = "mcp__gh_grep__searchGitHub";
const MCP_SERVER = "gh_grep";
const MCP_GATEWAY = "mcp";
const MCP_TARGET_EXPOSURE = "deferred";
const MCP_FORBIDDEN_HELPERS = new Set(["codemode", "tool_search", "mcpScript"]);
const MCP_RESOURCES = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
const CHILD_MCP_SOURCE = fileURLToPath(import.meta.url);
const SERVER_ENTRY: McpServerEntry = {
  name: MCP_SERVER,
  source: "omp:librarian",
  config: {
    url: "https://mcp.grep.app",
    exposure: "hidden",
    toolExposure: { "*": "hidden", searchGitHub: MCP_TARGET_EXPOSURE },
  },
};

export function childMcpConfig(role: string, serverEntry = SERVER_ENTRY): LoadedMcpConfig {
  if (!isRole(role)) throw new Error(`Invalid OMP child role for native MCP: ${role || "missing"}`);
  return {
    servers: role === "librarian" ? [structuredClone(serverEntry)] : [],
    errors: [],
    autoEnableCodemode: false,
  };
}

function isMcpTool(name: string): boolean {
  return name === MCP_GATEWAY || MCP_FORBIDDEN_HELPERS.has(name) || name.startsWith("mcp__") || MCP_RESOURCES.has(name);
}

function isScopedGatewayInput(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return Object.keys(value).length === 3
    && value.server === MCP_SERVER
    && value.tool === "search"
    && value.args !== null
    && typeof value.args === "object"
    && !Array.isArray(value.args);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

type Permit = { args: string; used: boolean };

export function createChildMcpExtension(
  role: string,
  serverEntry = SERVER_ENTRY,
  expectedSource = CHILD_MCP_SOURCE,
) {
  childMcpConfig(role, serverEntry);
  return (pi: ExtensionAPI): void => {
    const permits = new Map<string, Permit>();
    const connectionWaiters = new Set<(error?: unknown) => void>();
    let isolationReady = false;
    let isolationFailure: string | undefined;

    // Pi 0.99.2 connects deferred MCP tools in the background. Wait only when
    // the gateway needs the target, without exposing discovery tools to children.
    const waitForTarget = (signal?: AbortSignal): Promise<void> => {
      if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("MCP call cancelled"));
      if (pi.getAllTools().some((tool) => tool.name === MCP_TARGET)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const finish = (error?: unknown) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          connectionWaiters.delete(finish);
          if (error !== undefined) reject(error);
          else resolve();
        };
        const abort = () => finish(signal?.reason ?? new Error("MCP call cancelled"));
        const timer = setTimeout(() => {
          finish(new Error("Native gh_grep target did not connect within 10 seconds. Refusing fallback."));
        }, 10_000);
        connectionWaiters.add(finish);
        signal?.addEventListener("abort", abort, { once: true });
      });
    };
    pi.on("session_shutdown", () => {
      isolationReady = false;
      permits.clear();
      for (const finish of connectionWaiters) finish(new Error("MCP session closed"));
    });

    // The native connector must not inherit servers registered by another extension.
    // Keep the host registry untouched and replace only the connector's view.
    const connectorApi: ExtensionAPI = {
      ...pi,
      getMcpServers: () => [],
      registerTool(definition) {
        pi.registerTool(definition);
        if (definition.name === MCP_TARGET) {
          for (const finish of connectionWaiters) finish();
        }
      },
    };
    createMcpExtension({
      loadConfig: () => childMcpConfig(role, serverEntry),
      updateConfig: () => {
        throw new Error(mcpIsolationError("child MCP configuration is immutable"));
      },
    })(connectorApi);

    const closeOnIsolationFailure = (ctx: ExtensionContext, reason: string): never => {
      isolationReady = false;
      isolationFailure ??= reason.includes(MCP_ISOLATION_ERROR_MARKER)
        ? reason
        : mcpIsolationError(reason);
      permits.clear();
      for (const finish of connectionWaiters) finish(new Error(isolationFailure));
      try {
        ctx.shutdown();
      } catch {
        // The latched policy remains fail-closed even if shutdown cannot be queued.
      }
      throw new Error(isolationFailure);
    };

    const rethrowLatchedFailure = (ctx: ExtensionContext): void => {
      if (!isolationFailure) return;
      try {
        ctx.shutdown();
      } catch {
        // Keep rejecting every later MCP boundary.
      }
      throw new Error(isolationFailure);
    };

    // Returns false only for a normal not-yet-connected/missing target. Conflicting
    // owners, duplicate registrations, changed exposure, and command collisions are fatal.
    const validateConnector = (ctx: ExtensionContext, requireTarget: boolean): boolean => {
      rethrowLatchedFailure(ctx);
      const mcpCommands = pi.getCommands().filter((command) => /^mcp(?::\d+)?$/.test(command.name));
      if (mcpCommands.length !== 1 || mcpCommands[0].sourceInfo.path !== expectedSource) {
        closeOnIsolationFailure(
          ctx,
          `/mcp has conflicting owners: ${mcpCommands.map((command) => `${command.name}=${command.sourceInfo.path}`).join(", ") || "no native connector"}`,
        );
      }
      if (role !== "librarian") return true;

      const gateways = pi.getAllTools().filter((tool) => tool.name === MCP_GATEWAY);
      if (gateways.length !== 1 || gateways[0].sourceInfo.path !== expectedSource) {
        closeOnIsolationFailure(
          ctx,
          `scoped gateway owner mismatch: ${gateways.map((tool) => tool.sourceInfo.path).join(", ") || "missing"}`,
        );
      }
      if (!requireTarget) return true;

      const targets = pi.getAllTools().filter((tool) => tool.name === MCP_TARGET);
      if (targets.length === 0) return false;
      if (targets.length !== 1) {
        closeOnIsolationFailure(
          ctx,
          `native target has conflicting owners: ${targets.map((tool) => tool.sourceInfo.path).join(", ")}`,
        );
      }
      if (targets[0].sourceInfo.path !== expectedSource) {
        closeOnIsolationFailure(ctx, `native target owner mismatch: ${targets[0].sourceInfo.path}`);
      }
      if (targets[0].exposure !== MCP_TARGET_EXPOSURE) {
        closeOnIsolationFailure(ctx, `native target exposure changed: ${targets[0].exposure}`);
      }
      return true;
    };

    pi.on("session_start", (_event, ctx) => {
      validateConnector(ctx, false);
      if (role !== "librarian") isolationReady = true;
    });

    pi.on("before_agent_start", (event, ctx) => {
      // Native discovery instructions mention helpers denied by this child's policy.
      delete event.systemPromptOptions.sections.mcp_servers;
      validateConnector(ctx, role === "librarian");
      isolationReady = true;
    });

    pi.on("tool_call", (event: ToolCallEvent, ctx) => {
      if (!isMcpTool(event.toolName)) return;
      rethrowLatchedFailure(ctx);
      if (!isolationReady) {
        return {
          block: true,
          reason: mcpIsolationError("connector has not been validated"),
        };
      }
      const targetReady = validateConnector(ctx, role === "librarian" && event.toolName === MCP_TARGET);
      if (event.toolName === MCP_TARGET && !targetReady) {
        return { block: true, reason: "Native gh_grep target is unavailable; the server may not be connected" };
      }
      if (event.toolName === MCP_GATEWAY && role === "librarian" && !event.parentToolCallId && isScopedGatewayInput(event.input)) return;
      if (role !== "librarian" || event.toolName !== MCP_TARGET || !event.parentToolCallId) {
        return { block: true, reason: `OMP child ${role} MCP policy denies ${event.toolName}` };
      }
      const permit = permits.get(event.parentToolCallId);
      if (!permit || permit.used || stableJson(event.input) !== permit.args) {
        return { block: true, reason: "OMP librarian MCP call is not authorized by its scoped gateway" };
      }
      permit.used = true;
    });

    if (role !== "librarian") return;
    pi.registerTool({
      name: MCP_GATEWAY,
      label: "Scoped MCP",
      description: "Call the librarian's single permitted GitHub code-search MCP tool.",
      promptSnippet: "Search public GitHub code through the scoped gh_grep MCP server.",
      parameters: Type.Object({
        server: Type.Literal(MCP_SERVER),
        tool: Type.Literal("search"),
        args: Type.Record(Type.String(), Type.Unknown()),
      }, { additionalProperties: false }),
      exposure: "model-only",
      prepareLoadout(loadout) {
        return {
          hiddenDeclarations: loadout.declared
            .filter((tool) => tool.name !== MCP_GATEWAY && isMcpTool(tool.name))
            .map((tool) => tool.name),
        };
      },
      async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionToolContext) {
        if (params.server !== MCP_SERVER || params.tool !== "search" || !params.args || typeof params.args !== "object" || Array.isArray(params.args)) {
          throw new Error("Only mcp({server:'gh_grep', tool:'search', args:{...}}) is permitted");
        }
        if (signal?.aborted) throw signal.reason ?? new Error("MCP call cancelled");
        rethrowLatchedFailure(ctx);
        if (!isolationReady) closeOnIsolationFailure(ctx, "connector has not been validated");
        if (!validateConnector(ctx, true)) await waitForTarget(signal);
        if (signal?.aborted) throw signal.reason ?? new Error("MCP call cancelled");
        if (!isolationReady) throw new Error("MCP session closed");
        const targetReady = validateConnector(ctx, true);
        if (!targetReady || !ctx.tools.some((tool) => tool.name === MCP_TARGET)) {
          throw new Error("Native gh_grep target is unavailable; the server may not be connected. Refusing fallback.");
        }

        const permit: Permit = { args: stableJson(params.args), used: false };
        permits.set(toolCallId, permit);
        try {
          const outcome = await ctx.executeTool(MCP_TARGET, params.args, {
            signal,
            onUpdate: (partial) => onUpdate?.(partial),
          });
          return { ...outcome.result, isError: outcome.isError || outcome.result.isError === true };
        } finally {
          permits.delete(toolCallId);
        }
      },
    });
  };
}

export default function childMcp(pi: ExtensionAPI): void {
  if (process.env.PI_OMP_CHILD !== "1") return;
  createChildMcpExtension(process.env.PI_OMP_CHILD_ROLE ?? "")(pi);
}
