import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebSearch } from "./websearch.ts";

/** Children must not load the scheduler, renderers or settings UI. */
export default async function ompEntry(pi: ExtensionAPI): Promise<void> {
  if (process.env.PI_OMP_CHILD === "1") {
    registerWebSearch(pi);
    return;
  }
  const { default: omp } = await import("./index.ts");
  omp(pi);
}
