import { truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

export interface PinnedScrollState { top: number }

/** Keep the fixed widget within the terminal while preserving mouse targets. */
export function scrollablePinnedCard(
  content: Component,
  terminalRows: number,
  state: PinnedScrollState,
  requestRender: () => void,
  hint: (text: string) => string,
): Component {
  const maxRows = Math.max(1, Math.floor(terminalRows * 0.65));
  let contentHeight = 0;
  let visibleRows = maxRows;
  let viewportWidth = 0;
  const clamp = () => { state.top = Math.max(0, Math.min(state.top, contentHeight - visibleRows)); };
  return {
    render(width) {
      viewportWidth = width;
      const lines = content.render(width);
      contentHeight = lines.length;
      if (contentHeight <= maxRows) {
        state.top = 0;
        visibleRows = maxRows;
        return lines;
      }
      visibleRows = Math.max(0, maxRows - 1);
      clamp();
      const first = state.top + 1;
      const last = Math.min(contentHeight, state.top + visibleRows);
      return [
        ...lines.slice(state.top, state.top + visibleRows),
        hint(truncateToWidth(`  ↕ ${first}–${last}/${contentHeight} · scroll`, width)),
      ];
    },
    invalidate() { content.invalidate(); },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.type === "wheel" && contentHeight > maxRows) {
        const previous = state.top;
        state.top += event.wheelDelta ?? 0;
        clamp();
        if (state.top !== previous) requestRender();
        return { handled: true, render: state.top !== previous };
      }
      if (event.y < 0 || event.y >= visibleRows) return undefined;
      const targetRow = event.y + state.top;
      const result = content.handleMouse?.({
        ...event,
        y: targetRow,
        width: viewportWidth || event.width,
        height: contentHeight,
      });
      // A row opened near the bottom should reveal the first lines below it.
      if (event.type === "click" && result?.handled && contentHeight > maxRows) {
        const nextTop = Math.max(state.top, targetRow + 4 - visibleRows);
        if (nextTop !== state.top) { state.top = nextTop; requestRender(); }
      }
      return result;
    },
  };
}
