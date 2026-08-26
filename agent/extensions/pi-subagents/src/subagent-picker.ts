/**
 * InlineSelectionCatcher — invisible key-capture overlay for inline selection.
 *
 * Ctrl+Up / Ctrl+Down on the prompt no longer opens a visible picker popup.
 * Instead the selection highlight is painted directly into the active-run
 * widget above the prompt (see refreshWidget in index.ts, which renders the
 * selected row with a full-width `selectedBg` background). This component is
 * the invisible overlay that owns the keyboard while selection is active:
 *
 *   - Ctrl+Up / Ctrl+Down (and plain Up/Down) walk the highlight one row at
 *     a time (first press anchors at the top for Ctrl+Down, bottom for
 *     Ctrl+Up — see selectRun in index.ts);
 *   - Enter confirms the highlighted run (the caller opens its herdr tab);
 *   - Esc / Ctrl+C cancels and returns focus to the prompt.
 *
 * It renders zero lines (`render` returns `[]`), so the TUI composites
 * nothing — the widget underneath is the only thing the user sees change.
 * Extension shortcuts only fire from the editor input path, so while this
 * overlay holds focus the keys above never double-fire the Ctrl+Up/Ctrl+Down
 * shortcuts that opened it.
 */
import { Key, matchesKey } from "@earendil-works/pi-tui";

export class InlineSelectionCatcher {
  private finished = false;
  private onMove: (delta: 1 | -1) => void;
  private onConfirm: () => void;
  private onCancel: () => void;

  constructor(options: {
    onMove: (delta: 1 | -1) => void;
    onConfirm: () => void;
    onCancel: () => void;
  }) {
    this.onMove = options.onMove;
    this.onConfirm = options.onConfirm;
    this.onCancel = options.onCancel;
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.finish();
      this.onCancel();
    } else if (matchesKey(data, Key.enter)) {
      this.finish();
      this.onConfirm();
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("up"))) {
      this.onMove(-1);
    } else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("down"))) {
      this.onMove(1);
    }
    // Any other key (printable text, etc.) is deliberately swallowed while
    // selection is active; the prompt editor regains it after Esc/Enter.
  }

  private finish(): void {
    this.finished = true;
  }

  render(): string[] {
    // Invisible: the widget above the prompt renders the actual list and
    // highlight. An empty array means the overlay composites no lines at all.
    return [];
  }

  invalidate(): void {
    // Nothing cached.
  }
}
