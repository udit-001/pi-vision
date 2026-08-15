/**
 * VisionModelPicker — searchable, paginated TUI picker for `/vision-setup`.
 *
 * Mirrors pi's own ModelSelectorComponent (search `Input` over a windowed
 * list, `fuzzyFilter` matching, PgUp/PgDn pagination, ✓ on the current model).
 *
 * Thin renderer per codebase-design: all selection/windowing logic lives in
 * the pure `*ModelSelection` state machine in vision-core.ts; this component
 * only maps state → TUI rows and forwards keys. The fuzzy filter is the
 * production adapter for the injected `ModelFilter` seam.
 */

import { Container, fuzzyFilter, Input, Spacer, Text } from "@earendil-works/pi-tui";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  createModelSelection,
  filterModelSelection,
  modelRef,
  moveModelSelection,
  visibleWindow,
  type ModelFilter,
  type ModelLike,
  type ModelSelectionState,
} from "./vision-core.ts";

const MAX_VISIBLE = 10;

const filter: ModelFilter = (models, query) =>
  fuzzyFilter(models, query, (m) => `${modelRef(m)} ${m.name ?? ""}`);

export class VisionModelPicker extends Container {
  private searchInput = new Input();
  private listContainer = new Container();
  private state: ModelSelectionState;
  private currentRef?: string;
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private onSelect: (ref: string) => void;
  private onCancel: () => void;

  constructor(
    models: ModelLike[],
    currentRef: string | undefined,
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    onSelect: (ref: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.state = createModelSelection(models, currentRef);
    this.currentRef = currentRef;
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.onSelect = onSelect;
    this.onCancel = onCancel;

    this.addChild(
      new Text(
        theme.fg("muted", "Type to filter · ↑/↓ navigate · PgUp/PgDn page · Enter select · Esc cancel"),
        0,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);

    // Enter on the search box selects the highlighted row.
    this.searchInput.onSubmit = () => {
      const item = this.state.filtered[this.state.selectedIndex];
      if (item) this.onSelect(modelRef(item));
    };

    this.refresh();
  }

  private refresh(): void {
    this.renderList();
    this.tui.requestRender();
  }

  private move(delta: number, wrap: boolean): void {
    this.state = moveModelSelection(this.state, delta, wrap);
    this.refresh();
  }

  private setFilter(query: string): void {
    this.state = filterModelSelection(this.state, query, filter);
    this.refresh();
  }

  private renderList(): void {
    this.listContainer.clear();
    const { filtered, selectedIndex } = this.state;
    if (filtered.length === 0) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", "No models match the filter."), 1, 0),
      );
      return;
    }
    const { start, end } = visibleWindow(filtered.length, selectedIndex, MAX_VISIBLE);
    for (let i = start; i < end; i++) {
      const m = filtered[i];
      const isSelected = i === selectedIndex;
      const check = modelRef(m) === this.currentRef ? this.theme.fg("success", " ✓") : "";
      let line: string;
      if (isSelected) {
        line =
          this.theme.fg("accent", "→ ") +
          this.theme.fg("accent", m.id) +
          this.theme.fg("muted", ` [${m.provider}]`) +
          check;
      } else {
        line = "  " + this.theme.fg("muted", m.id) + this.theme.fg("dim", ` [${m.provider}]`) + check;
      }
      this.listContainer.addChild(new Text(line, 0, 0));
    }
  }

  handleInput(keyData: string): void {
    const kb = this.keybindings;
    if (kb.matches(keyData, "tui.select.up")) {
      this.move(-1, true);
    } else if (kb.matches(keyData, "tui.select.down")) {
      this.move(1, true);
    } else if (kb.matches(keyData, "tui.select.pageUp")) {
      this.move(-MAX_VISIBLE, false);
    } else if (kb.matches(keyData, "tui.select.pageDown")) {
      this.move(MAX_VISIBLE, false);
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      const item = this.state.filtered[this.state.selectedIndex];
      if (item) this.onSelect(modelRef(item));
    } else if (kb.matches(keyData, "tui.select.cancel")) {
      this.onCancel();
    } else {
      this.searchInput.handleInput(keyData);
      this.setFilter(this.searchInput.getValue());
    }
  }
}
