import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.ts";

/** Shared request policy for the main session and every OMP child process. */
export default function registerFastMode(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!model || !readConfig().fast) return;
    const supported = model.api === "openai-codex-responses" ||
      (model.provider === "openai" &&
        (model.api === "openai-responses" || model.api === "openai-completions"));
    if (!supported || !event.payload || typeof event.payload !== "object" ||
      Array.isArray(event.payload)) return;
    // Read the shared switch for each request, including retries and reused workers.
    // Replace rather than mutate so turning Fast mode off cannot retain our previous tier.
    return { ...event.payload, service_tier: "priority" };
  });
}
