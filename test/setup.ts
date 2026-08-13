/**
 * Vitest runs in a Node environment, but plugin code follows Obsidian's
 * `prefer-window-timers` lint rule (window.setTimeout & co. for popout-window
 * compatibility). Node has the same timer functions on globalThis — expose
 * them under `window` so timer-using code paths run in tests.
 */
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as { window?: unknown }).window = globalThis;
}

export {};
