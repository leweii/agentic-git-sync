/**
 * Build-time stand-in for the `@earendil-works/pi-ai` package root.
 *
 * esbuild and vitest alias `@earendil-works/pi-ai` to this file (see
 * esbuild.config.mjs / vitest.config.ts). pi-ai's real index barrel drags in
 * provider SDKs (@anthropic-ai/sdk, openai, @google/genai, AWS Bedrock, …)
 * that must never reach the plugin bundle — we do our own HTTP via Obsidian's
 * `requestUrl` in piBackends.ts. The agent runtime only needs these three
 * utilities, so we re-export exactly them from their deep dist paths.
 *
 * `@earendil-works/pi-agent-core/dist/agent-loop.js` imports `EventStream`
 * and `validateToolArguments` from the pi-ai root; our own code imports
 * `createAssistantMessageEventStream`. Type-only imports from the real
 * package are unaffected (erased at compile time).
 */

export {
  EventStream,
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "../../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";
export {
  validateToolCall,
  validateToolArguments,
} from "../../node_modules/@earendil-works/pi-ai/dist/utils/validation.js";
export { uuidv7 } from "../../node_modules/@earendil-works/pi-ai/dist/utils/uuid.js";
