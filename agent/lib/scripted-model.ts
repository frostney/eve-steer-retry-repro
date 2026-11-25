import { MockLanguageModelV4 } from "ai/test";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type LanguageModelV4StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

// A scripted model that streams over time, so a steer can arrive mid-call. The first user message picks the scenario:
//
// "retry ...": the first call reasons briefly, starts streaming a `write_note` tool call's input, and then the stream
//   fails with a retryable error partway through the input, the way a provider's stream gets cut. The retry reasons
//   for REASONING_MS with no output, then writes the tool call.
// "cut-early ...": like "retry", but the stream is cut during reasoning, before any tool call input.
// "control ...": the first call reasons for REASONING_MS with no output, then replies.
//
// Once a message containing "STEER" is in the prompt, the model replies "Steer applied." at once.

const REASONING_MS = 12_000;
const TICK_MS = 250;

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const callsBySession = new Map<string, number>();

function userTexts(prompt: readonly { role: string; content: unknown }[]): string[] {
  return prompt
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as { type: string; text?: string }[])
            .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
            .join(""),
    );
}

type Step =
  | { kind: "part"; part: LanguageModelV4StreamPart }
  | { kind: "wait"; ms: number }
  | { kind: "fail"; error: Error };

function reasoning(id: string, ms: number): Step[] {
  const steps: Step[] = [{ kind: "part", part: { type: "reasoning-start", id } }];
  for (let t = 0; t < ms; t += TICK_MS) {
    steps.push({ kind: "part", part: { type: "reasoning-delta", id, delta: "thinking… " } });
    steps.push({ kind: "wait", ms: TICK_MS });
  }
  steps.push({ kind: "part", part: { type: "reasoning-end", id } });
  return steps;
}

function reply(text: string): Step[] {
  return [
    { kind: "part", part: { type: "text-start", id: "t" } },
    { kind: "part", part: { type: "text-delta", id: "t", delta: text } },
    { kind: "part", part: { type: "text-end", id: "t" } },
    { kind: "part", part: { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } } },
  ];
}

const NOTE = JSON.stringify({ text: "x".repeat(200) });

function script(texts: string[], hasToolResult: boolean, call: number): Step[] {
  const first = texts[0] ?? "";
  if (texts.some((t) => t.includes("STEER"))) return reply("Steer applied.");
  if (hasToolResult) return reply("Note written.");
  if (first.startsWith("control")) return [...reasoning("r", REASONING_MS), ...reply("Done, no steer seen.")];
  if (call === 1 && first.startsWith("cut-early")) {
    const cut = Object.assign(new Error("Upstream stream ended before terminal chunk"), { isRetryable: true });
    return [...reasoning("r", 1_000).slice(0, -1), { kind: "fail", error: cut }];
  }
  if (call === 1) {
    // starts the tool call's input, then the stream is cut
    const steps: Step[] = [...reasoning("r", 500)];
    steps.push({ kind: "part", part: { type: "tool-input-start", id: "c1", toolName: "write_note" } });
    for (let i = 0; i < 12; i++) {
      steps.push({ kind: "part", part: { type: "tool-input-delta", id: "c1", delta: i === 0 ? '{"text":"' : "xxxx" } });
      steps.push({ kind: "wait", ms: TICK_MS });
    }
    const cut = Object.assign(new Error("Upstream stream ended before terminal chunk"), { isRetryable: true });
    steps.push({ kind: "fail", error: cut });
    return steps;
  }
  // the retry: reasoning with no output, then the whole tool call
  return [
    ...reasoning("r", REASONING_MS),
    { kind: "part", part: { type: "tool-call", toolCallId: "c2", toolName: "write_note", input: NOTE } },
    { kind: "part", part: { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } } },
  ];
}

export const scriptedModel = new MockLanguageModelV4({
  provider: "steer-repro",
  modelId: "scripted",
  doStream: async (options) => {
    const texts = userTexts(options.prompt as never);
    const hasToolResult = options.prompt.some(
      (m) => m.role === "tool" || (Array.isArray(m.content) && m.content.some((p) => p.type === "tool-result")),
    );
    const key = texts[0] ?? "";
    const call = (callsBySession.get(key) ?? 0) + 1;
    callsBySession.set(key, call);
    const steps = script(texts, hasToolResult, call);
    const signal = options.abortSignal;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const step of steps) {
          if (signal?.aborted) {
            controller.error(signal.reason);
            return;
          }
          if (step.kind === "part") controller.enqueue(step.part);
          else if (step.kind === "fail") {
            controller.error(step.error);
            return;
          } else await new Promise((r) => setTimeout(r, step.ms));
        }
        controller.close();
      },
    });
    return { stream };
  },
});
