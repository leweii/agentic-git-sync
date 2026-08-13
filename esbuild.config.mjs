import esbuild from "esbuild";
import process from "process";
import path from "node:path";
import { builtinModules } from "node:module";

const builtins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

const prod = process.argv[2] === "production";

// pi agent SDK: bypass both packages' index barrels.
//  - pi-agent-core's index re-exports its whole coding-agent harness (yaml,
//    diff, ignore, …); we only use the Agent loop in dist/agent.js.
//  - pi-ai's index registers every provider SDK; the agent loop only needs
//    three small utilities, re-exported by src/ai/piAiSlim.ts.
// Type-only imports still resolve against the real package index — aliases
// only affect what lands in the bundle.
const piAlias = {
  "@earendil-works/pi-agent-core": path.resolve(
    "node_modules/@earendil-works/pi-agent-core/dist/agent.js",
  ),
  "@earendil-works/pi-ai": path.resolve("src/ai/piAiSlim.ts"),
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  alias: piAlias,
  platform: "node",
  format: "cjs",
  // es2020: typebox (pulled in by pi-ai's tool-argument validation) uses
  // BigInt literals, which es2018 can't represent. Obsidian's Electron
  // runtime is far past es2020.
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
