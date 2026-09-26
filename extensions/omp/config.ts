import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { isMainAgent, isRole, type MainAgent, type Role } from "./roles.ts";
import type { ServiceTier } from "./service-tier.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const isThinkingLevel = (value: string): value is ThinkingLevel =>
  (THINKING_LEVELS as readonly string[]).includes(value);

export interface OmpConfig {
  defaultAgent: MainAgent;
  models: Partial<Record<Role, string>>;
  thinking: Partial<Record<Role, ThinkingLevel>>;
  serviceTier?: Partial<Record<Role, ServiceTier>>;
}

export const DEFAULT_CONFIG: OmpConfig = { defaultAgent: "orchestrator", models: {}, thinking: {} };
export const configPath = () => path.join(getAgentDir(), "omp.json");

export function parseModel(value: string): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1 || value.length > 256 || /\s/.test(value)) return;
  const provider = value.slice(0, slash);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider)) return;
  return { provider, id: value.slice(slash + 1) };
}

export function parseConfig(raw: unknown): OmpConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Config must be a JSON object");
  const value = raw as Record<string, unknown>;
  const requestedDefault = value.defaultAgent ?? "orchestrator";
  if (typeof requestedDefault !== "string") throw new Error("Invalid defaultAgent");
  if (!isMainAgent(requestedDefault)) throw new Error("defaultAgent must be a main agent");
  const defaultAgent: MainAgent = requestedDefault;
  const models = value.models ?? {};
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("models must be an object");
  const validated: OmpConfig["models"] = {};
  for (const [role, model] of Object.entries(models)) {
    if (!isRole(role) || role === "council" || typeof model !== "string" || !parseModel(model)) {
      throw new Error(`Invalid models.${role}: expected provider/model-id`);
    }
    validated[role] = model;
  }
  const thinking = value.thinking ?? {};
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) throw new Error("thinking must be an object");
  const validatedThinking: OmpConfig["thinking"] = {};
  for (const [role, level] of Object.entries(thinking)) {
    if (!isRole(role) || role === "council" || typeof level !== "string" || !isThinkingLevel(level)) {
      throw new Error(`Invalid thinking.${role}: expected ${THINKING_LEVELS.join("/")}`);
    }
    validatedThinking[role] = level;
  }
  const tiers = value.serviceTier;
  const serviceTier: NonNullable<OmpConfig["serviceTier"]> = {};
  if (tiers !== undefined) {
    if (!tiers || typeof tiers !== "object" || Array.isArray(tiers)) throw new Error("serviceTier must be an object");
    for (const [role, tier] of Object.entries(tiers)) {
      if (!isRole(role) || role === "council" || role === "orchestrator" || (tier !== "default" && tier !== "priority")) {
        throw new Error(`Invalid serviceTier.${role}: expected default/priority for a specialist`);
      }
      serviceTier[role] = tier;
    }
  }
  return { defaultAgent, models: validated, thinking: validatedThinking, ...(Object.keys(serviceTier).length ? { serviceTier } : {}) };
}

export function readConfig(file = configPath()): OmpConfig {
  if (!fs.existsSync(file)) return { defaultAgent: "orchestrator", models: {}, thinking: {} };
  return parseConfig(JSON.parse(fs.readFileSync(file, "utf8")));
}

// The mutation queue serializes concurrent command writes; rename avoids partial JSON on crash.
export async function updateConfig(change: (current: OmpConfig) => OmpConfig, file = configPath()): Promise<OmpConfig> {
  return withFileMutationQueue(file, async () => {
    const next = parseConfig(change(readConfig(file)));
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await fs.promises.rename(tmp, file);
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
    return next;
  });
}
