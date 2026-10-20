/**
 * RPC end-to-end test for pi-answer: runs `pi --mode rpc`, sends `/answer --agent`,
 * responds to extension UI requests, and prints the conversation + consolidated reply.
 * Run with: bun rpc-e2e.ts
 */
import { spawn } from "node:child_process";

const pi = spawn("pi", ["--mode", "rpc", "--no-session"], {
  cwd: "/tmp",
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
let done = false;
const saw: Array<Record<string, unknown>> = [];

// RPC mode emits nothing until it receives a command, so kick off after a
// short startup delay rather than waiting for output.
setTimeout(() => {
  console.log(">>> sending /answer --agent");
  send({ type: "prompt", id: "t1", message: "/answer --agent --text \"1. What is 2+2?\n2. What is 3+3?\"" });
}, 1000);

pi.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    handle(ev);
  }
});

function send(obj: unknown) {
  pi.stdin.write(JSON.stringify(obj) + "\n");
}

function handle(ev: Record<string, unknown>) {
  if (ev.type === "extension_ui_request") {
    // Respond to every UI request (notify/setStatus are fire-and-forget, but
    // respond anyway so awaited ones (editor) unblock).
    send({ type: "extension_ui_response", id: ev.id, data: { value: null } });
    return;
  }
  if (ev.type === "prompt_result" || ev.type === "response") return;

  if (ev.type === "message_end" && ev.message) {
    const msg = ev.message as { role: string; content: Array<{ type: string; text: string }> | string };
    const text =
      typeof msg.content === "string"
        ? msg.content
        : (msg.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (text.trim()) {
      saw.push({ role: msg.role, text: text.trim() });
      if (msg.role === "assistant") {
        console.log(`\n>>> assistant: ${text.trim().slice(0, 400)}`);
        if (!done) {
          done = true;
          setTimeout(() => pi.kill(), 500);
        }
      }
    }
    return;
  }

  if (ev.type === "agent_settled") {
    // After the turn triggered by our command settles, we're done.
    if (done) return;
    done = true;
    setTimeout(() => pi.kill(), 800);
  }
}

setTimeout(() => {
  console.log("\n=== TIMEOUT — events seen so far ===");
  console.log(JSON.stringify(saw, null, 2).slice(0, 2000));
  pi.kill();
  process.exit(1);
}, 120_000);
