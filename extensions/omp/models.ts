import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Pi's session scope is the authoritative enabled-model list when present. */
export function availableChildModels(ctx: ExtensionContext, available = ctx.modelRegistry.getAvailable()) {
  if (!ctx.scopedModels?.length) return available;
  const enabled = new Set(ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`));
  return available.filter((model) => enabled.has(`${model.provider}/${model.id}`));
}
