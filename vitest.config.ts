import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
  test: {
    // Shims `window` timers onto globalThis — plugin code follows Obsidian's
    // prefer-window-timers rule, and vitest's node env has no window.
    setupFiles: [path.resolve(__dirname, "test/setup.ts")],
  },
  resolve: {
    alias: {
      // `obsidian` has no real npm package — alias to a test stub so
      // modules that transitively import it (e.g. node-builtins) load.
      obsidian: path.resolve(__dirname, "test/obsidian-stub.ts"),
      // pi agent SDK: same barrel-bypass aliases as esbuild.config.mjs —
      // keep the runtime module graph identical between tests and bundle.
      "@earendil-works/pi-agent-core": path.resolve(
        __dirname,
        "node_modules/@earendil-works/pi-agent-core/dist/agent.js",
      ),
      "@earendil-works/pi-ai": path.resolve(__dirname, "src/ai/piAiSlim.ts"),
    },
  },
});
