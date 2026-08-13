/**
 * Test double for ToolCallBackend: replays scripted AssistantMessages with
 * native tool calls, recording every chat request so tests can assert what
 * the model was shown (transcript contents, secret scrubbing, call counts).
 */

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { BackendChatRequest, ToolCallBackend } from "../src/ai/piBackends";

function usage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

let callSeq = 0;

/** One scripted turn: the model calls `action` with `args` (native tool call). */
export function toolCallMessage(
  action: string,
  args: Record<string, unknown> = {},
  thought = "",
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      ...(thought ? ([{ type: "text", text: thought }] as const) : []),
      { type: "toolCall", id: `scripted_call_${++callSeq}`, name: action, arguments: args },
    ],
    api: "scripted",
    provider: "scripted",
    model: "scripted",
    usage: usage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

/** One scripted turn where the model answers with plain text (no tool call). */
export function textMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "scripted",
    provider: "scripted",
    model: "scripted",
    usage: usage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export class ScriptedBackend implements ToolCallBackend {
  readonly id: string;
  readonly name: string;
  private queue: (AssistantMessage | Error)[];
  callLog: BackendChatRequest[] = [];
  available = true;

  constructor(responses: (AssistantMessage | Error)[], id = "scripted", name = "Scripted") {
    this.queue = [...responses];
    this.id = id;
    this.name = name;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async chat(req: BackendChatRequest): Promise<AssistantMessage> {
    this.callLog.push(req);
    if (this.queue.length === 0) throw new Error("script exhausted");
    const next = this.queue.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }

  /** Everything this backend was shown, for contains-style assertions. */
  transcriptText(callIndex: number): string {
    return JSON.stringify(this.callLog[callIndex]?.messages ?? []);
  }
}

export class UnavailableBackend implements ToolCallBackend {
  readonly id = "off";
  readonly name = "Off";
  isAvailable(): boolean {
    return false;
  }
  async chat(): Promise<AssistantMessage> {
    throw new Error("never available");
  }
}

export class HangingBackend implements ToolCallBackend {
  readonly id = "hang";
  readonly name = "Hang";
  isAvailable(): boolean {
    return true;
  }
  chat(): Promise<AssistantMessage> {
    return new Promise(() => { /* never resolves */ });
  }
}
