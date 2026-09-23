import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Input, SelectList, SettingsList, truncateToWidth, visibleWidth, type SelectItem, type SettingItem } from "@earendil-works/pi-tui";
import { readConfig, THINKING_LEVELS } from "./config.ts";
import { MAIN_AGENT_NAMES, ROLES, ROLE_NAMES } from "./roles.ts";
import { availableChildModels } from "./models.ts";

const INHERIT = "Inherit";
const INHERIT_THINKING = "Inherit";
const SETTING_SEPARATOR = " · ";

export const roleSettingValue = (model: string, thinking: string): string => `${model}${SETTING_SEPARATOR}${thinking}`;
export function parseRoleSettingValue(value: string): { model: string; thinking: string } | undefined {
  const separator = value.lastIndexOf(SETTING_SEPARATOR);
  if (separator < 0) return undefined;
  return { model: value.slice(0, separator), thinking: value.slice(separator + SETTING_SEPARATOR.length) };
}

export interface SettingsActions {
  /** Applies a selected setting (may throw). */
  apply(id: string, value: string, ctx: ExtensionCommandContext): Promise<void>;
}

export function getSettingsRows(): SettingItem[] {
  const config = readConfig();
  return [
    { id: "default", label: "Default main agent", currentValue: config.defaultAgent, description: "Default role for the main session; does not change Pi's current model." },
    ...ROLE_NAMES.filter((name) => name !== "orchestrator" && name !== "council").map((name) => ({
      id: `role:${name}`, label: name,
      currentValue: roleSettingValue(config.models[name] ?? INHERIT, config.thinking[name] ?? INHERIT_THINKING),
      description: `${ROLES[name].description}. Choose the model, then the thinking level.`,
    })),
  ];
}

export function getChoices(id: string, ctx: ExtensionCommandContext): string[] {
  if (id === "default") return [...MAIN_AGENT_NAMES];
  if (id.startsWith("thinking:")) return [INHERIT_THINKING, ...THINKING_LEVELS];
  const available = availableChildModels(ctx).map((model) => `${model.provider}/${model.id}`).sort();
  return [INHERIT, ...available];
}

/** Terminal UI is one settings screen, with a searchable model picker per row. */
async function showTui(ctx: ExtensionCommandContext, actions: SettingsActions): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    const rows = getSettingsRows();
    const listTheme = {
      label: (s: string, selected: boolean) => theme.fg(selected ? "accent" : "text", selected ? theme.bold(s) : s),
      value: (s: string, selected: boolean) => theme.fg(selected ? "accent" : "text", selected ? theme.bold(s) : s),
      description: (s: string) => theme.fg("text", s),
      get cursor() { return theme.fg("accent", "→ "); },
      hint: (s: string) => theme.fg("muted", s),
    };
    const selectTheme = {
      selectedPrefix: (s: string) => theme.fg("accent", s),
      selectedText: (s: string) => theme.fg("accent", theme.bold(s)),
      description: (s: string) => theme.fg("muted", s),
      scrollInfo: (s: string) => theme.fg("muted", s),
      noMatch: (s: string) => theme.fg("warning", s),
    };
    let busy = false;
    let activeSearch: Input | undefined;
    let isFocused = true;
    let feedback = "Enter: choose setting · Type to search models · Esc: back/close";
    const items: SettingItem[] = rows.map((row) => ({
      ...row,
      submenu: (current, close) => {
        const itemsFor = (id: string): SelectItem[] => getChoices(id, ctx).map((value) => ({
          value, label: value, description: value === INHERIT
            ? id.startsWith("thinking:") ? "Use the current Pi session's thinking level" : "Use the current Pi session's model"
            : undefined,
        }));
        const makePicker = (choices: SelectItem[], initial: string, onSelect: (value: string) => void, onCancel: () => void) => {
          const picker = new SelectList(choices, Math.min(Math.max(choices.length, 1), 13), selectTheme);
          const selected = choices.findIndex((item) => item.value === initial);
          if (selected !== -1) picker.setSelectedIndex(selected);
          picker.onSelect = (item) => onSelect(item.value);
          picker.onCancel = onCancel;
          return picker;
        };
        if (row.id === "default") return makePicker(itemsFor("default"), current, (value) => close(value), () => close());
        const role = row.id.slice(5);
        const selected = parseRoleSettingValue(current);
        let model = selected?.model ?? INHERIT;
        let thinking = selected?.thinking ?? INHERIT_THINKING;
        const modelChoices = itemsFor(`model:${role}`);
        const thinkingChoices = itemsFor(`thinking:${role}`);
        let phase: "model" | "thinking" = "model";
        const newSearch = () => {
          const input = new Input({ prompt: "Search models: ", placeholder: "Enter provider or model name" });
          input.focused = isFocused;
          activeSearch = input;
          return input;
        };
        let search = newSearch();
        const selectModel = (value: string) => {
          model = value;
          phase = "thinking";
          activeSearch = undefined;
          picker = makePicker(thinkingChoices, thinking, (choice) => {
            thinking = choice;
            close(roleSettingValue(model, thinking));
          }, () => {
            phase = "model";
            search = newSearch();
            picker = makePicker(modelChoices, model, selectModel, () => close());
          });
        };
        let picker = makePicker(modelChoices, model, selectModel, () => close());
        return {
          render(width: number) {
            return phase === "model"
              ? [...search.render(width), "", ...picker.render(width), truncateToWidth(theme.fg("muted", "  Choose model · Enter next · Esc back"), width)]
              : [truncateToWidth(theme.fg("accent", `${role} thinking · ${model}`), width), "", ...picker.render(width), truncateToWidth(theme.fg("muted", "  Choose thinking · Enter save · Esc model"), width)];
          },
          invalidate() { if (phase === "model") search.invalidate(); picker.invalidate(); },
          handleInput(data: string) {
            const kb = getKeybindings();
            if (phase === "thinking" || kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down") ||
                kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel")) {
              picker.handleInput(data);
            } else {
              search.handleInput(data);
              const query = search.getValue().toLowerCase().trim();
              picker = makePicker(modelChoices.filter((item) => item.value.toLowerCase().includes(query)), model, selectModel, () => close());
            }
          },
          handleMouse(event) {
            if (phase === "model" && event.y === 0) return search.handleMouse(event);
            if (event.y >= 2) return picker.handleMouse({ ...event, y: event.y - 2 });
          },
        };
      },
    }));
    const list = new SettingsList(items, 9, listTheme, (id, value) => {
      if (busy) return;
      busy = true;
      feedback = "Saving…";
      tui.requestRender();
      void (async () => {
        try {
          await actions.apply(id, value, ctx);
          feedback = "Saved";
        } catch (err) {
          feedback = `Could not save: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          try {
            for (const row of getSettingsRows()) list.updateValue(row.id, row.currentValue);
          } catch (err) {
            feedback = `Could not read config: ${err instanceof Error ? err.message : String(err)}`;
          }
          busy = false;
          tui.requestRender();
        }
      })();
    }, () => { if (!busy) done(); }, { enableSearch: false });
    return {
      get focused() { return isFocused; },
      set focused(value: boolean) { isFocused = value; if (activeSearch) activeSearch.focused = value; },
      render(width: number) {
        // SettingsList reserves a fixed label column; compact labels leave room for values.
        const compact = width < 58;
        items.forEach((item, index) => {
          const row = rows[index];
          item.label = compact && index === 0 ? "Main agent" : row.label;
          item.description = compact ? `Current: ${item.currentValue}. ${rows[index].description}` : rows[index].description;
        });
        const lines = list.render(width);
        return [
          truncateToWidth(theme.fg("accent", theme.bold("OMP · Main agent / specialist settings")), width),
          "",
          ...lines.map((line) => visibleWidth(line) > width ? truncateToWidth(line, width) : line),
          truncateToWidth(theme.fg(busy ? "warning" : feedback.startsWith("Could not") ? "error" : feedback === "Saved" ? "success" : "muted", feedback), width),
        ];
      },
      invalidate() { list.invalidate(); },
      handleInput(data: string) { if (!busy) list.handleInput(data); tui.requestRender(); },
      handleMouse(event) { if (!busy && (event.y >= 2 || event.type === "wheel")) return list.handleMouse({ ...event, y: event.y - 2 }); },
    };
  });
}

/** RPC has dialogs but not custom terminal components: keep the same setting picker. */
async function showDialogs(ctx: ExtensionCommandContext, actions: SettingsActions): Promise<void> {
  while (true) {
    const rows = getSettingsRows();
    const choices = rows.map((row) => `${row.label}  →  ${row.currentValue}`);
    const selected = await ctx.ui.select("OMP · Main agent / specialist settings (cancel to close)", choices);
    if (!selected) return;
    const row = rows[choices.indexOf(selected)];
    if (!row) return;
    if (row.id === "default") {
      const value = await ctx.ui.select(row.label, getChoices("default", ctx));
      if (value) await actions.apply(row.id, value, ctx);
      continue;
    }
    const role = row.id.slice(5);
    const model = await ctx.ui.select(`${role} model`, getChoices(`model:${role}`, ctx));
    if (!model) continue;
    const thinking = await ctx.ui.select(`${role} thinking`, getChoices(`thinking:${role}`, ctx));
    if (!thinking) continue;
    await actions.apply(row.id, roleSettingValue(model, thinking), ctx);
  }
}

export async function showSettingsUi(ctx: ExtensionCommandContext, actions: SettingsActions): Promise<void> {
  if (ctx.mode === "tui") return showTui(ctx, actions);
  if (ctx.hasUI) return showDialogs(ctx, actions);
  ctx.ui.notify("/omp settings require an interactive Pi or RPC UI", "warning");
}

export { INHERIT, INHERIT_THINKING };
