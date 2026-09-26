import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ServiceTier = "default" | "priority";
export const supportsServiceTier = (provider?: string) => provider === "openai" || provider === "openai-codex";

/** Only OMP children opt in; never change the main session or another provider. */
export function installChildServiceTier(pi: ExtensionAPI): void {
  const tier = process.env.PI_OMP_SERVICE_TIER;
  if (process.env.PI_OMP_CHILD !== "1" || (tier !== "default" && tier !== "priority")) return;
  pi.on("before_provider_request", (event, ctx) => {
    if (!supportsServiceTier(ctx.model?.provider) || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
    return { ...event.payload, service_tier: tier };
  });
}
