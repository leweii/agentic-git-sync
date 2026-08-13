// Minimal `obsidian` stand-in for the vitest environment. The real
// module is provided by Obsidian at runtime and has no npm package.
// Only the surface the test path touches needs to exist here.

export const Platform = {
  isDesktop: true,
  isMobile: false,
};

export function requestUrl(): never {
  throw new Error("requestUrl is not available in the test environment.");
}

// UI surface — import-time stand-ins so modules like settings.ts load in
// tests. None of these are functional; tests exercising real UI would need
// the actual Obsidian runtime.
export class App {}
export class Modal {
  app: unknown;
  constructor(app: unknown) { this.app = app; }
  open(): void {}
  close(): void {}
}
export class Notice {
  constructor(_msg?: string, _timeout?: number) {}
}
export class PluginSettingTab {
  app: unknown;
  constructor(app: unknown, _plugin: unknown) { this.app = app; }
}
export class Setting {
  constructor(_el: unknown) {}
  setName(): this { return this; }
  setDesc(): this { return this; }
  addText(): this { return this; }
  addDropdown(): this { return this; }
  addToggle(): this { return this; }
  addButton(): this { return this; }
  addExtraButton(): this { return this; }
  addSlider(): this { return this; }
  settingEl = { addClass: () => {} };
}
export class TextComponent {}
export function setIcon(): void {}
