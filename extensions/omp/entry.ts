import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installChildServiceTier } from "./service-tier.ts";

/** Children need the request hook, not the scheduler, renderers or settings UI. */
export default async function ompEntry(pi: ExtensionAPI): Promise<void> {
  if (process.env.PI_OMP_CHILD === "1") { installChildServiceTier(pi); return; }
  const { default: omp } = await import("./index.ts");
  omp(pi);
}
