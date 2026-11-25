// Starts a session, sends a steer while a model call is in progress, and prints when eve admits it.
//   node scripts/steer.ts retry     the steer is sent after a cut stream, while the retry reasons with no output
//   node scripts/steer.ts cut-early   the same, but the stream was cut before any tool call input
//   node scripts/steer.ts control   the steer is sent while a first call reasons with no output
// EVE_URL defaults to http://127.0.0.1:2000.
import { Client } from "eve/client";

const scenario = ["control", "cut-early"].includes(process.argv[2] ?? "") ? process.argv[2]! : "retry";
const client = new Client({ baseUrl: process.env.EVE_URL ?? "http://127.0.0.1:2000" });
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s`;

type Ev = { type: string; data?: Record<string, any> };

const { session } = await client.sessions.create({ message: `${scenario} ${t0}` });
let steerSentAt: number | undefined;
let reasoningRun: string | undefined;
let lastRun: string | undefined;
let retried = false;

const sendSteer = async () => {
  steerSentAt = Date.now();
  console.log(`${at()}  >> steer sent (turnPolicy "steer", the default)`);
  await session.send("STEER: stop and apply this message");
};

for await (const raw of session.stream()) {
  const e = raw as unknown as Ev;
  const d = e.data ?? {};
  if (process.env.DUMP && e.type !== "content.delta") console.log(`${at()}  · ${e.type} ${JSON.stringify(d).slice(0, 160)}`);
  switch (e.type) {
    case "model.started":
      lastRun = d.runId;
      console.log(`${at()}  model.started   ${d.runId} attempt ${d.attempt}`);
      break;
    case "model.settled":
      console.log(`${at()}  model.settled   ${d.runId} ${d.outcome}`);
      if (d.outcome === "abandoned") retried = true;
      break;
    case "content.delta":
      // the steer goes in once the call whose generation should stop is reasoning
      if (d.kind === "reasoning" && reasoningRun === undefined && (scenario === "control" || retried)) {
        reasoningRun = lastRun;
        console.log(`${at()}  ${lastRun} is reasoning, no assistant output yet`);
        void sendSteer();
      }
      break;
    case "call.requested":
      console.log(`${at()}  call.requested  ${d.capability?.name ?? ""}`);
      break;
    case "delivery.admitted":
      if (steerSentAt !== undefined)
        console.log(`${at()}  delivery.admitted (steer), ${((Date.now() - steerSentAt) / 1000).toFixed(2)} s after it was sent`);
      break;
    case "content.completed":
      if (d.kind === "text") console.log(`${at()}  reply: ${JSON.stringify(d.value)}`);
      break;
    case "turn.settled":
      console.log(`${at()}  turn.settled ${d.outcome}`);
      if (steerSentAt !== undefined) process.exit(0);
      break;
  }
}
