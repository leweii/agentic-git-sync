import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // `obsidian` has no real npm package — alias to a test stub so
      // modules that transitively import it (e.g. node-builtins) load.
      obsidian: path.resolve(__dirname, "test/obsidian-stub.ts"),
    },
  },
});
