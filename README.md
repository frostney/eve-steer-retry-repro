# A steer doesn't stop a retried model call when the failed attempt had started streaming a tool call's input

eve 1.5.0. A fresh `eve init` app whose model is scripted, so it runs without a provider or a key.

Message sends default to `turnPolicy: "steer"`. eve's docs (`concepts/execution-model-and-durability.mdx`, "Message
delivery and steering") say that before assistant output begins, eve stops pending model generation and applies the
new message in the same turn, and that reasoning doesn't count as output.

That holds for a first call, and for a retry after a stream that failed during reasoning. It doesn't hold for a retry
after a stream that failed while the call streamed a tool call's input. That retry can't be stopped, though it has
produced no output, and the steer waits until it finishes and its tool runs.

## Run it

```sh
npm install
npm exec -- eve dev --no-ui --no-default-extensions    # wait for "[DEV] ready at http://127.0.0.1:2000/"
node scripts/steer.ts control      # in another terminal
node scripts/steer.ts cut-early
node scripts/steer.ts retry
```

`DUMP=1` prints every session event. `EVE_URL` overrides the server's address.

## The three scenarios

The scripted model (`agent/lib/scripted-model.ts`) streams over time and picks its behaviour from the first message.
In every scenario, `scripts/steer.ts` sends the steer on the first reasoning delta of the call it should stop. That
call reasons for 12 s, with no text and no tool call input, before it writes anything.

eve emits no "steered" marker for the stopped call: it settles as `completed` with `finishReason: "other"`. A call
counts as stopped here when it settles without finishing its script: no reply text, and no `write_note` call.

| Scenario | The call the steer should stop | Stopped | Steer admitted after it was sent |
| --- | --- | --- | --- |
| `control` | the turn's first call | 4 of 4 runs | 1.97–2.03 s |
| `cut-early` | a retry, after the first attempt's stream failed (retryable) during reasoning | 4 of 4 runs | 0.44–1.19 s |
| `retry` | a retry, after the first attempt's stream failed (retryable) while streaming a `write_note` call's input | **0 of 5 runs**: the retry reasons for the full 12 s, calls `write_note`, the tool runs, and only then is the steer admitted | 12.04–12.67 s |

The two retries are the same: 12 s of reasoning, then a `write_note` call. Only the failed first attempts differ:
`retry`'s streamed 12 `call.input` events before failing, and `cut-early`'s streamed none.

`results/` keeps every run behind these numbers (`<scenario>-<n>.txt`), a `retry` run with every event
(`retry-events.txt`), and the dev server's `EVE_LOG_LEVEL=debug` log for all of them, with the app's local path
replaced by `<app>`. The `retry` run with every event, shortened:

```
  0.55s  · model.started {"attempt":0,"modelId":"steer-repro/scripted","runId":"run_0"}
  1.00s  · call.input {"callId":"c1","delta":"{\"text\":\"","kind":"tool","name":"write_note"}
  1.25s  · call.input {"callId":"c1","delta":"xxxx"}
         … 12 call.input events for c1 in all
  4.04s  · model.settled {"outcome":"abandoned","runId":"run_0"}
  4.73s  · model.started {"attempt":1,"modelId":"steer-repro/scripted","runId":"run_1"}
  4.73s  >> steer sent (turnPolicy "steer", the default)
         … run_1 streams reasoning deltas only
 16.82s  · call.requested {"callId":"c2","capability":{"kind":"tool","name":"write_note"},...}
 16.84s  · call.settled {"callId":"c2","outcome":"completed","output":{"written":200}}
 16.84s  · model.settled {"finishReason":"tool-calls","outcome":"completed","runId":"run_1"}
 16.96s  delivery.admitted (steer), 12.23 s after it was sent
 16.97s  · content.completed {"kind":"text","phase":"reply","runId":"run_2","value":"Steer applied."}
```

## Why, from eve's source

Paths under `packages/eve/src/`, lines at the `eve@1.5.0` tag:

- `harness/kernel.ts:69` makes one `GenerationSteering` per step, seeded with the turn's projected
  `assistantOutputStarted`.
- `GenerationSteering.beforeEvent` (`harness/generation-steering.ts:53`) sets `outputStarted` on any `call.input`
  event (line 63). `onSteering` (line 84) never aborts once it's set.
- `ModelCaller.call()` (`harness/model-call/call.ts:150`) retries a failed attempt inside the same step and under the
  same `GenerationSteering`, through `runModelCallWithRetries` (line 160). Neither `prepareRetry` (line 184) nor
  `GenerationSteering.begin()` (`generation-steering.ts:38`) resets `outputStarted`.
- So the retry is treated as if it had started output.

The `call.input` rule came from vercel/eve#6257, for #5929. Its description says: "The protection covers only the
call that is streaming the input. … a later call that has produced nothing can still be cut." A retry is such a later
call. The docs give the rule's reason as "so the model doesn't write the input again", and a retry writes it again
anyway.

**A local check of the fix:** in a copy of this app, `begin()` in eve's bundled `generation-steering.js` was changed to
reset `outputStarted` to the value the step started with. `retry` was then stopped in 3 of 3 runs, with the steer
admitted 3.78–4.03 s after it was sent. `control` was unchanged (2.04–2.12 s). That patch isn't in this repository.

## Where it came from

I first hit this on eve 1.4.0 with a real provider. AI Gateway cut a stream (`gateway_stream_terminated`, "Upstream
stream ended before terminal chunk") while the model wrote a long tool call. A steer sent during that call was
admitted only after the retry finished, about 6 minutes after it was sent. The retry alone reasoned for 2 min 42 s
before it wrote anything. The code above is the same in 1.4.0.
