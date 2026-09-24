import { truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

export interface PinnedScrollState { listTop: number; detailTop: number; focusedListRow?: number }

/** Bound the fixed widget while inserting a scrollable detail below its task row. */
export function scrollablePinnedCard(
  list: Component,
  detail: Component | undefined,
  insertAfterRow: number | undefined,
  terminalRows: number,
  state: PinnedScrollState,
  requestRender: () => void,
  hint: (text: string) => string,
  setInlineRange?: (label: string | undefined) => boolean,
): Component {
  const maxRows = Math.max(1, Math.floor(terminalRows * 0.65));
  let listHeight = 0;
  let detailHeight = 0;
  let listContentRows = 0;
  let detailContentRows = 0;
  let listScreenRows = 0;
  let detailScreenRows = 0;
  let detailStart = 0;
  let viewportWidth = 0;
  const clamp = (top: number, height: number, contentRows: number) =>
    Math.max(0, Math.min(top, height - contentRows));
  const region = (lines: string[], budget: number, top: number, width: number, footer = true) => {
    if (budget <= 0) return { lines: [], top: 0, contentRows: 0 };
    if (lines.length <= budget) return { lines, top: 0, contentRows: lines.length };
    const contentRows = budget - (footer ? 1 : 0);
    const position = clamp(top, lines.length, contentRows);
    const first = position + 1;
    const last = Math.min(lines.length, position + contentRows);
    return {
      lines: [
        ...lines.slice(position, position + contentRows),
        ...(footer ? [hint(truncateToWidth(`  ↕ ${first}–${last}/${lines.length} · scroll`, width))] : []),
      ],
      top: position,
      contentRows,
    };
  };
  return {
    render(width) {
      viewportWidth = width;
      const listLines = list.render(width);
      const detailLines = detail?.render(width) ?? [];
      listHeight = listLines.length;
      detailHeight = detailLines.length;
      // Reserve up to four rows for an open detail when the task list is long.
      const listBudget = detail ? Math.min(listHeight, Math.max(1, maxRows - Math.min(4, detailHeight))) : maxRows;
      const listVisibleContent = listHeight > listBudget ? Math.max(0, listBudget - 1) : listHeight;
      if (state.focusedListRow !== undefined && listVisibleContent > 0) {
        if (state.focusedListRow < state.listTop) state.listTop = state.focusedListRow;
        else if (state.focusedListRow >= state.listTop + listVisibleContent) {
          state.listTop = state.focusedListRow - listVisibleContent + 1;
        }
      }
      const visibleList = region(listLines, listBudget, state.listTop, width);
      state.listTop = visibleList.top;
      state.focusedListRow = undefined;
      listContentRows = visibleList.contentRows;
      listScreenRows = visibleList.lines.length;
      const visibleDetail = region(detailLines, maxRows - listScreenRows, state.detailTop, width, false);
      state.detailTop = visibleDetail.top;
      detailContentRows = visibleDetail.contentRows;
      detailScreenRows = visibleDetail.lines.length;
      detailStart = detail ? Math.max(0, Math.min(listContentRows, (insertAfterRow ?? listHeight) - state.listTop)) : listScreenRows;
      const range = detail && detailHeight > detailContentRows && detailContentRows > 0
        ? ` ↕ ${state.detailTop + 1}–${Math.min(detailHeight, state.detailTop + detailContentRows)}/${detailHeight}`
        : undefined;
      if (setInlineRange?.(range)) {
        // The range belongs to the task row itself, so its hover and card
        // background are rendered by the same components as the task name.
        visibleList.lines = region(list.render(width), listBudget, state.listTop, width).lines;
      }
      return [
        ...visibleList.lines.slice(0, detailStart),
        ...visibleDetail.lines,
        ...visibleList.lines.slice(detailStart),
      ];
    },
    invalidate() { list.invalidate(); detail?.invalidate(); },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      const inDetail = !!detail && event.y >= detailStart && event.y < detailStart + detailScreenRows;
      const inList = !inDetail;
      const regionTop = inList ? state.listTop : state.detailTop;
      const regionHeight = inList ? listHeight : detailHeight;
      const regionContentRows = inList ? listContentRows : detailContentRows;
      const target = inList ? list : detail;
      const localY = inList
        ? event.y - (event.y >= detailStart + detailScreenRows ? detailScreenRows : 0)
        : event.y - detailStart;
      if (event.type === "wheel") {
        // When all task rows fit, wheel motion anywhere scrolls the detail.
        const scrollDetail = !!detail && (inDetail || listHeight <= listScreenRows);
        const key = scrollDetail ? "detailTop" : "listTop";
        const height = scrollDetail ? detailHeight : listHeight;
        const contentRows = scrollDetail ? detailContentRows : listContentRows;
        if (height > contentRows && contentRows > 0) {
          const previous = state[key];
          state[key] = clamp(previous + (event.wheelDelta ?? 0), height, contentRows);
          if (state[key] !== previous) requestRender();
          return { handled: true, render: state[key] !== previous };
        }
        return undefined;
      }
      if (!target || localY < 0 || localY >= regionContentRows) return undefined;
      const result = target.handleMouse?.({
        ...event,
        y: localY + regionTop,
        width: viewportWidth || event.width,
        height: regionHeight,
      });
      if (inList && event.type === "click" && result?.handled) state.focusedListRow = localY + regionTop;
      return result;
    },
  };
}
