import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig, type FastProviderMode, type OmpConfig } from "./config.ts";

const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";
const ANTHROPIC_FAST_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);
type FastModel = { provider: string; api: string; id?: string };
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function resolveMode(model: FastModel, config: OmpConfig): FastProviderMode | undefined {
  const overrides = config.fastProviders;
  const modelKey = `${model.provider}/${model.id}`;
  if (overrides && Object.hasOwn(overrides, modelKey)) return overrides[modelKey];
  if (overrides && Object.hasOwn(overrides, model.provider)) return overrides[model.provider];
  if (model.api === "openai-codex-responses" || model.provider === "openai") return "openai-priority";
  if (model.provider === "anthropic" && model.id && ANTHROPIC_FAST_MODELS.has(model.id)) return "anthropic-fast";
  // Groq auto explicitly selects the best tier available to the account;
  // hard-coding priority would be invalid, and performance requires enterprise access.
  if (model.provider === "groq") return "groq-auto";
  // There is no cross-provider Fast capability discovery in Pi. Unknown gateways,
  // dedicated Cerebras endpoints and model-specific Bedrock tiers need a declaration.
  return undefined;
}

/** One switch for all providers; each supported protocol uses its own Fast parameters. */
export default function registerFastMode(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    const config = readConfig();
    if (!config.fast || !isObject(event.payload)) return;
    const payload = event.payload;
    const mode = resolveMode(model, config);
    // Clone rather than mutate: reused workers and retries must not retain our tier
    // when the shared switch changes. Never change models, effort or token limits.
    switch (mode) {
      case "openai-priority":
        if (!["openai-responses", "openai-completions", "openai-codex-responses", "azure-openai-responses"].includes(model.api)) return;
        return { ...payload, service_tier: "priority" };
      case "anthropic-fast": {
        if (model.api !== "anthropic-messages") return;
        if (payload.betas !== undefined && !Array.isArray(payload.betas)) return;
        const betas = Array.isArray(payload.betas) ? payload.betas : [];
        // Pi calls the Anthropic beta SDK; it converts betas to the HTTP header.
        return { ...payload, speed: "fast", betas: [...new Set([...betas, ANTHROPIC_FAST_BETA])] };
      }
      case "groq-auto":
      case "cerebras-auto":
      case "groq-performance":
        if (model.api !== "openai-completions") return;
        return { ...payload, service_tier: mode === "groq-performance" ? "performance" : "auto" };
      case "bedrock-priority":
        if (model.api !== "bedrock-converse-stream") return;
        // Converse's SDK shape differs from the OpenAI-compatible Bedrock endpoint.
        return { ...payload, serviceTier: {
          ...(isObject(payload.serviceTier) ? payload.serviceTier : {}), type: "priority",
        } };
      default:
        return;
    }
  });
}
