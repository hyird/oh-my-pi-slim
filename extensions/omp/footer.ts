import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { mergeModelUsage, sessionModelUsage, type ChildUsageLedger, type ModelUsage } from "./usage.ts";

export const OMP_STATUS_KEY = "1:omp";

const fmt = (n: number) => n < 1000 ? `${Math.round(n)}` : n < 1_000_000
  ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;
const clean = (text: string) => stripTerminalSequences(text).replace(/[\r\n\t]/g, " ");

/** Replaces Pi's built-in footer; extension statuses still share the existing status row. */
export function installUsageFooter(
  ctx: ExtensionContext,
  children: ChildUsageLedger,
  liveUsage: () => ModelUsage,
  getThinkingLevel: ExtensionAPI["getThinkingLevel"],
  configuredModels: () => readonly string[] = () => [],
): () => void {
  let requestRender: (() => void) | undefined;
  if (!ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui.setFooter !== "function") return () => {};
  ctx.ui.setFooter((tui, theme, footerData) => {
    requestRender = () => tui.requestRender();
    const unsubscribe = footerData.onBranchChange(() => requestRender?.());
    let cachedSession: string | undefined;
    let cachedLeaf: string | null | undefined;
    let cachedModel: ExtensionContext["model"];
    let main: ModelUsage = new Map();
    let context: ReturnType<ExtensionContext["getContextUsage"]>;
    return {
      invalidate() {},
      dispose() { unsubscribe(); requestRender = undefined; },
      render(width: number): string[] {
        const session = ctx.sessionManager.getSessionId();
        const leaf = ctx.sessionManager.getLeafId();
        if (session !== cachedSession || leaf !== cachedLeaf || ctx.model !== cachedModel) {
          const fallback = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
          main = sessionModelUsage(ctx.sessionManager.getEntries(), fallback);
          context = ctx.getContextUsage();
          cachedSession = session;
          cachedLeaf = leaf;
          cachedModel = ctx.model;
        }
        const totals = new Map<string, Usage>();
        mergeModelUsage(totals, main);
        mergeModelUsage(totals, children.byModel);
        mergeModelUsage(totals, liveUsage());
        const total = [...totals.values()].reduce((sum, usage) => sum + usage.totalTokens, 0);
        const active = ctx.model ? [`${ctx.model.provider}/${ctx.model.id}`] : [];
        const models = [...new Set([...active, ...configuredModels(),
          ...[...totals].filter(([, usage]) => usage.totalTokens > 0).map(([model]) => model)])];
        const ids = models.map((model) => model.slice(model.indexOf("/") + 1));
        const stats = [`Σ${fmt(total)}`, ...models.map((model, index) => {
          const label = ids.filter((id) => id === ids[index]).length > 1 ? model : ids[index]!;
          return `${clean(label)} ${fmt(totals.get(model)?.totalTokens ?? 0)}`;
        })];
        const window = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const percent = context?.percent == null ? "?" : `${context.percent.toFixed(1)}%`;
        const color = (context?.percent ?? 0) > 90 ? "error" : (context?.percent ?? 0) > 70 ? "warning" : "dim";
        const right = theme.fg(color, `${percent}/${fmt(window)}`);
        const available = width - visibleWidth(right) - 3;
        const left = available > 0 ? truncateToWidth(stats.join(" · "), available) : "";
        const statsLine = left ? `${left} · ${right}` : truncateToWidth(right, width);
        const cwd = ctx.sessionManager.getCwd();
        const relative = path.relative(os.homedir(), cwd);
        const displayCwd = relative === "" ? "~" : relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative) ? `~${path.sep}${relative}` : cwd;
        const branch = footerData.getGitBranch();
        const name = ctx.sessionManager.getSessionName();
        const location = `${clean(displayCwd)}${branch ? ` (${clean(branch)})` : ""}${name ? ` • ${clean(name)}` : ""}`;
        const model = ctx.model;
        const modelName = model ? clean(ids.filter((id) => id === model.id).length > 1
          ? `${model.provider}/${model.id}` : model.id) : "no-model";
        const current = truncateToWidth(`${modelName}${model?.reasoning ? ` • ${getThinkingLevel()}` : ""}`, width);
        const locationWidth = width - visibleWidth(current) - 2;
        const locationLeft = locationWidth > 0 ? truncateToWidth(location, locationWidth) : "";
        const locationLine = `${locationLeft}${" ".repeat(Math.max(0,
          width - visibleWidth(locationLeft) - visibleWidth(current)))}${current}`;
        const lines = [theme.fg("dim", locationLine), theme.fg("dim", statsLine)];
        const statuses = [...footerData.getExtensionStatuses()].sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => text.replace(/[\r\n\t]/g, " "));
        if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width));
        return lines;
      },
    };
  });
  return () => requestRender?.();
}
