import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { addUsage, emptyUsage, sessionUsage, type ChildUsageLedger } from "./usage.ts";

const fmt = (n: number) => n < 1000 ? `${Math.round(n)}` : n < 1_000_000
  ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;
const clean = (text: string) => stripTerminalSequences(text).replace(/[\r\n\t]/g, " ");

/** Replaces Pi's built-in footer; extension statuses still share the existing status row. */
export function installUsageFooter(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  children: ChildUsageLedger,
  liveUsage: () => Usage,
): () => void {
  let requestRender: (() => void) | undefined;
  if (!ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui.setFooter !== "function") return () => {};
  ctx.ui.setFooter((tui, theme, footerData) => {
    requestRender = () => tui.requestRender();
    const unsubscribe = footerData.onBranchChange(() => requestRender?.());
    let cachedSession: string | undefined;
    let cachedLeaf: string | null | undefined;
    let cachedModel: ExtensionContext["model"];
    let main = emptyUsage();
    let context: ReturnType<ExtensionContext["getContextUsage"]>;
    return {
      invalidate() {},
      dispose() { unsubscribe(); requestRender = undefined; },
      render(width: number): string[] {
        const session = ctx.sessionManager.getSessionId();
        const leaf = ctx.sessionManager.getLeafId();
        if (session !== cachedSession || leaf !== cachedLeaf || ctx.model !== cachedModel) {
          main = sessionUsage(ctx.sessionManager.getEntries());
          context = ctx.getContextUsage();
          cachedSession = session;
          cachedLeaf = leaf;
          cachedModel = ctx.model;
        }
        const total = addUsage(addUsage(addUsage(emptyUsage(), main), children.total), liveUsage());
        const stats = [`Σ${fmt(total.totalTokens)}`, `↑${fmt(total.input)}`, `↓${fmt(total.output)}`];
        if (total.cacheRead) stats.push(`R${fmt(total.cacheRead)}`);
        if (total.cacheWrite) stats.push(`W${fmt(total.cacheWrite)}`);
        if (total.cost.total) stats.push(`$${total.cost.total.toFixed(3)}`);
        const window = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const percent = context?.percent == null ? "?" : `${context.percent.toFixed(1)}%`;
        const color = (context?.percent ?? 0) > 90 ? "error" : (context?.percent ?? 0) > 70 ? "warning" : "dim";
        stats.push(theme.fg(color, `ctx ${percent}/${fmt(window)}`));
        const left = truncateToWidth(stats.join(" "), width);
        const model = ctx.model;
        const thinking = model?.reasoning ? ` • ${pi.getThinkingLevel()}` : "";
        let right = `${clean(model?.id ?? "no-model")}${thinking}`;
        if (model && footerData.getAvailableProviderCount() > 1 &&
          visibleWidth(left) + 2 + visibleWidth(`(${model.provider}) ${right}`) <= width)
          right = `(${clean(model.provider)}) ${right}`;
        const available = width - visibleWidth(left) - 2;
        right = available > 0 ? truncateToWidth(right, available, "") : "";
        const statsLine = right ? left + " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right))) + right : left;
        const cwd = ctx.sessionManager.getCwd();
        const relative = path.relative(os.homedir(), cwd);
        const displayCwd = relative === "" ? "~" : relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative) ? `~${path.sep}${relative}` : cwd;
        const branch = footerData.getGitBranch();
        const name = ctx.sessionManager.getSessionName();
        const location = `${clean(displayCwd)}${branch ? ` (${clean(branch)})` : ""}${name ? ` • ${clean(name)}` : ""}`;
        const lines = [truncateToWidth(theme.fg("dim", location), width), theme.fg("dim", statsLine)];
        const statuses = [...footerData.getExtensionStatuses()].sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => text.replace(/[\r\n\t]/g, " "));
        if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width));
        return lines;
      },
    };
  });
  return () => requestRender?.();
}
