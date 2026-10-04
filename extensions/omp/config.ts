import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { isMainAgent, isRole, type MainAgent, type Role } from "./roles.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const isThinkingLevel = (value: string): value is ThinkingLevel =>
  (THINKING_LEVELS as readonly string[]).includes(value);

export interface OmpConfig {
  defaultAgent: MainAgent;
  fast: boolean;
  models: Partial<Record<Role, string>>;
  thinking: Partial<Record<Role, ThinkingLevel>>;
}

/** Factory settings for a new OMP install. Saved per-role choices override these. */
export const DEFAULT_CONFIG: OmpConfig = {
  defaultAgent: "orchestrator",
  fast: false,
  models: {
    oracle: "openai/gpt-6-astra",
    librarian: "openai/gpt-6-luna",
    explorer: "openai/gpt-6-luna",
    designer: "openai/gpt-6-luna",
    fixer: "openai/gpt-6-luna",
  },
  thinking: {
    oracle: "high",
    librarian: "low",
    explorer: "low",
    designer: "medium",
    fixer: "high",
  },
};
export const configPath = () => path.join(getAgentDir(), "omp.json");

export function parseModel(value: string): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1 || value.length > 256 || /\s/.test(value)) return;
  const provider = value.slice(0, slash);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider)) return;
  return { provider, id: value.slice(slash + 1) };
}

export function parseConfig(raw: unknown): OmpConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Config must be a JSON object");
  const value = raw as Record<string, unknown>;
  const requestedDefault = value.defaultAgent ?? "orchestrator";
  if (typeof requestedDefault !== "string") throw new Error("Invalid defaultAgent");
  if (!isMainAgent(requestedDefault)) throw new Error("defaultAgent must be a main agent");
  const defaultAgent: MainAgent = requestedDefault;
  const fast = value.fast === undefined ? false : value.fast;
  if (typeof fast !== "boolean") throw new Error("fast must be a boolean");
  const models = value.models ?? {};
  if (!models || typeof models !== "object" || Array.isArray(models))
    throw new Error("models must be an object");
  const validated: OmpConfig["models"] = {};
  for (const [role, model] of Object.entries(models)) {
    if (
      !isRole(role) ||
      role === "council" ||
      role === "orchestrator" ||
      typeof model !== "string" ||
      !parseModel(model)
    ) {
      throw new Error(`Invalid models.${role}: expected provider/model-id`);
    }
    validated[role] = model;
  }
  const thinking = value.thinking ?? {};
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking))
    throw new Error("thinking must be an object");
  const validatedThinking: OmpConfig["thinking"] = {};
  for (const [role, level] of Object.entries(thinking)) {
    if (
      !isRole(role) ||
      role === "council" ||
      role === "orchestrator" ||
      typeof level !== "string" ||
      !isThinkingLevel(level)
    ) {
      throw new Error(`Invalid thinking.${role}: expected ${THINKING_LEVELS.join("/")}`);
    }
    validatedThinking[role] = level;
  }
  return {
    defaultAgent,
    fast,
    models: validated,
    thinking: validatedThinking,
  };
}

export function readConfig(file = configPath()): OmpConfig {
  if (!fs.existsSync(file))
    return {
      defaultAgent: DEFAULT_CONFIG.defaultAgent,
      fast: DEFAULT_CONFIG.fast,
      models: { ...DEFAULT_CONFIG.models },
      thinking: { ...DEFAULT_CONFIG.thinking },
    };
  return parseConfig(JSON.parse(fs.readFileSync(file, "utf8")));
}

// The mutation queue serializes concurrent command writes; rename avoids partial JSON on crash.
export async function updateConfig(
  change: (current: OmpConfig) => OmpConfig,
  file = configPath(),
  canCommit: () => boolean = () => true,
): Promise<OmpConfig> {
  return withFileMutationQueue(file, async () => {
    const current = readConfig(file);
    if (!canCommit()) return current;
    const next = parseConfig(change(current));
    if (!canCommit() || JSON.stringify(next) === JSON.stringify(current)) return current;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      if (!canCommit()) return current;
      await fs.promises.rename(tmp, file);
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
    return next;
  });
}
