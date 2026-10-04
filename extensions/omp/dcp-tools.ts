import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ROLES } from "./roles.ts";

const DCP_PACKAGE = "@davecodes/pi-dcp";
export const DCP_ISOLATION_ERROR_MARKER = "OMP_DCP_ISOLATION_FAILURE";
const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const BUILTIN_AND_OMP_TOOLS = new Set([
  "bash", "read", "write", "edit", "grep", "find", "ls", "powershell",
  "codemode", "tool_search", "mcp", "mcpScript", "list_mcp_resources",
  "list_mcp_resource_templates", "read_mcp_resource", "subagent", "omp_delegate",
  "omp_council", "websearch",
]);

export interface DcpProvider {
  path: string;
  tools: string[];
}

export interface DcpToolSnapshot {
  providers: DcpProvider[];
  tools: string[];
  signature: string;
}

function dcpExtensionPath(sourceInfo: unknown): string | undefined {
  if (!sourceInfo || typeof sourceInfo !== "object") return;
  const info = sourceInfo as Record<string, unknown>;
  if (
    typeof info.path !== "string" ||
    !info.path ||
    typeof info.source !== "string" ||
    !info.source ||
    !["user", "project", "temporary"].includes(String(info.scope)) ||
    !["package", "top-level"].includes(String(info.origin))
  ) return;

  let extensionPath: string;
  try {
    extensionPath = fs.realpathSync(info.path);
    if (!fs.statSync(extensionPath).isFile()) return;
  } catch {
    return;
  }

  let dir = path.dirname(extensionPath);
  while (true) {
    const manifestPath = path.join(dir, "package.json");
    let text: string;
    try {
      text = fs.readFileSync(manifestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      const parent = path.dirname(dir);
      if (parent === dir) return;
      dir = parent;
      continue;
    }
    let manifest: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      manifest = JSON.parse(text);
    } catch {
      return;
    }
    if (manifest.name !== DCP_PACKAGE || !Array.isArray(manifest.pi?.extensions)) return;
    const entries = manifest.pi.extensions;
    if (!entries.some((entry) => {
      if (typeof entry !== "string") return false;
      try {
        return fs.realpathSync(path.resolve(dir, entry)) === extensionPath;
      } catch {
        return false;
      }
    })) return;
    // This verifies local package attribution, not publisher authenticity.
    if (typeof info.source !== "string" || !info.source.trim()) return;
    return extensionPath;
  }
}

/** Discover only active, visible tools registered by the verified pi-dcp package. */
export function discoverDcpTools(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">): DcpToolSnapshot {
  if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function") {
    return { providers: [], tools: [], signature: "[]" };
  }
  const active = new Set(pi.getActiveTools());
  const reserved = new Set([
    ...Object.values(ROLES).flatMap((role) => role.tools),
    "powershell", "codemode", "tool_search", "mcp", "subagent", "omp_delegate", "omp_council",
  ]);
  const byPath = new Map<string, Set<string>>();
  for (const tool of pi.getAllTools()) {
    if (
      !active.has(tool.name) ||
      !["direct", "model-only"].includes(tool.exposure) ||
      !TOOL_NAME.test(tool.name) ||
      reserved.has(tool.name) ||
      BUILTIN_AND_OMP_TOOLS.has(tool.name) ||
      tool.name.startsWith("mcp__")
    ) continue;
    const extensionPath = dcpExtensionPath(tool.sourceInfo);
    if (!extensionPath) continue;
    const names = byPath.get(extensionPath) ?? new Set<string>();
    names.add(tool.name);
    byPath.set(extensionPath, names);
  }
  const providers = [...byPath.entries()]
    .map(([providerPath, names]) => ({ path: providerPath, tools: [...names].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const tools = [...new Set(providers.flatMap((provider) => provider.tools))].sort();
  const signature = JSON.stringify(providers);
  return { providers, tools, signature };
}

export function dcpRegistrationFailure(
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">,
  expected: ReadonlyMap<string, string>,
): string | undefined {
  const active = new Set(pi.getActiveTools());
  for (const [name, expectedPath] of expected) {
    const registrations = pi.getAllTools().filter((tool) => tool.name === name);
    let actualPath: string | undefined;
    if (registrations.length === 1) {
      try {
        actualPath = fs.realpathSync(registrations[0].sourceInfo.path);
      } catch {
        actualPath = undefined;
      }
    }
    let verifiedPath: string | undefined;
    try {
      verifiedPath = fs.realpathSync(expectedPath);
    } catch {
      verifiedPath = undefined;
    }
    if (!verifiedPath || actualPath !== verifiedPath) return `provider registration mismatch for ${name}`;
    const exposure = registrations[0]?.exposure;
    if (!active.has(name) || (exposure !== "direct" && exposure !== "model-only")) {
      return `provider tool is not active and model-exposed: ${name}`;
    }
  }
  return undefined;
}

export function mergeRoleTools(base: readonly string[], dcpTools: readonly string[]): string[] {
  return [...new Set([...base, ...dcpTools])];
}
