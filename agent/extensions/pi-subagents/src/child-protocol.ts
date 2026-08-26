/**
 * Child protocol: parse the child pi process's `--mode json` stdout
 * (JSONL events) and project the fields we care about: final assistant
 * output, model/provider, usage, turn/tool counts, and the terminal
 * watermark (`agent_settled` / `agent_end.willRetry`).
 *
 * Mirrors the reference extension's design: the child is a full pi
 * session, not a summarizer; the parent only reads events off the pipe.
 */
import { Buffer } from "node:buffer";

export interface ProtocolSnapshot {
  output: string;
  model?: string;
  provider?: string;
  totalTokens?: number;
  totalCost?: number;
  turnCount: number;
  toolCount: number;
  settled: boolean;
  willRetry: boolean;
}

interface JsonEvent {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    provider?: string;
    usage?: {
      totalTokens?: number;
      cost?: { total?: number };
    };
  };
  willRetry?: boolean;
  [key: string]: unknown;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      const text = (part as { text?: string }).text;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  }
  return parts.join("\n").trim();
}

export function createChildProtocol(): {
  push(chunk: Buffer | string): void;
  snapshot(): ProtocolSnapshot;
  getLineCount(): number;
} {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let output = "";
  let lastUsage: { totalTokens?: number; cost?: { total?: number } } | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  let turnCount = 0;
  let toolCount = 0;
  let settled = false;
  let willRetry = false;
  let lineCount = 0;

  function handleJson(obj: JsonEvent): void {
    switch (obj.type) {
      case "message_end": {
        const msg = obj.message;
        if (msg?.role === "assistant") {
          const text = extractText(msg.content);
          if (text) output = text;
          if (msg.model) model = msg.model;
          if (msg.provider) provider = msg.provider;
          if (msg.usage) lastUsage = msg.usage;
        }
        break;
      }
      case "turn_start":
        turnCount++;
        break;
      case "tool_execution_start":
        toolCount++;
        break;
      case "agent_end":
        willRetry = Boolean(obj.willRetry);
        break;
      case "agent_settled":
        settled = true;
        break;
      default:
        break;
    }
  }

  return {
    push(chunk: Buffer | string): void {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length === 0) return;
      buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);
      let nl: number;
      while ((nl = buffer.indexOf(0x0a)) !== -1) {
        const line = buffer.subarray(0, nl);
        buffer = buffer.subarray(nl + 1);
        lineCount++;
        const text = line.toString("utf-8").trim();
        if (!text) continue;
        try {
          handleJson(JSON.parse(text) as JsonEvent);
        } catch {
          // Non-JSON lines (pi warnings) are ignored by the protocol.
        }
      }
    },
    snapshot(): ProtocolSnapshot {
      return {
        output,
        model,
        provider,
        totalTokens: lastUsage?.totalTokens,
        totalCost: lastUsage?.cost?.total,
        turnCount,
        toolCount,
        settled,
        willRetry,
      };
    },
    getLineCount(): number {
      return lineCount;
    },
  };
}
