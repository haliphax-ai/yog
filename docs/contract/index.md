# Contract (v1)

The HTTP surface is four routes; everything else is a message `type`. This
is not a REST API (see AGENTS.md): clients bootstrap over the routes and do
everything else through the messages channel.

| Method | Path                         | Purpose                                                                                                                                                                                                                                                                                          |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/capabilities`           | Bootstrap discovery: contract version, models, tools, `features` (`["messages", "stream", …]`), the `messageTypes` dispatch table, and context-window sizes for the queried model.                                                                                                               |
| `POST` | `/v1/sessions`               | Bootstrap creation, optional body `{ title?, system? }` → `{ session: { id, … } }` (201). `system` seeds the first transcript message (role `system`) so it is part of every turn's context.                                                                                                     |
| `GET`  | `/v1/sessions/{id}/stream`   | The long-lived SSE event channel, opened once per session. Frames `stream.hello { streamId, sessionId }` on connect, then turn/ask/future events; replays any running turn's persisted events. A stream disconnect detaches, never aborts (unless a turn bound to it via `abortOnDisconnect`).   |
| `POST` | `/v1/sessions/{id}/messages` | Typed dispatch: `{ type, version?, requestId?, data? }` → `{ type, version, requestId?, data }` or `{ error: { code, message } }` (`requestId` echoed when supplied). Streaming types (`turn.start`) return `202 { accepted: true }` at once; progress and terminal events arrive on the stream. |

There is also `POST /v1/agent-cli`, the command endpoint the `/bin/yog` shim
in the FUSE mount calls; it is agent-facing plumbing, not part of the
client contract.

Message types are advertised as `messageTypes` on capabilities; an unknown
`type` or `version` answers `400 invalid_request`. Adding a feature means
adding a `type` and a handler, never a new HTTP route.

| Type                                                              | `data`                                              | Response `data`                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `session.get`                                                     | none                                                | `{ session }`                                                                                        |
| `session.detach`                                                  | `{ purge?: boolean }`                               | `{ session }`, or `{ ok, deleted, id }` with `purge: true` (advisory detach; hard delete with purge) |
| `transcript.get`                                                  | `{ afterSeq?, limit? }`                             | the rehydration dump `{ session, messages, turns? }`                                                 |
| `turn.get`                                                        | `{ turnId }`                                        | terminal turn state `{ turn }` (recovery/replay)                                                     |
| `turn.abort`                                                      | none                                                | `{ ok, status, aborted: { requested, sessionId, activeToolCall }, session }`                         |
| `compaction.run`                                                  | `{ kind: "compact" / "handoff", guidance? }`        | `{ ok, kind, summary, model, truncated, sessionId }`                                                 |
| `transcript.shake`                                                | none                                                | `{ ok, argsTruncated, resultsTruncated, contextSize, session }`                                      |
| `turn.start`                                                      | `{ prompt, model?, abortOnDisconnect?, streamId? }` | `202 { accepted: true }`; events on the stream (a dormant session is implicitly revived)             |
| `skills.list` / `skills.load` / `skills.unload` / `skills.status` | `{ name }` for load/unload                          | the skills subsystem's reply (500 `internal` when the daemon was built without it)                   |

Turn-start data is `{ "prompt": "...", "model": "..." }`. `prompt` is
required; `model` defaults to the server's model. **Clients never send
history.** The server owns the transcript: it hydrates prior context before
each turn and persists everything the turn produced, so a turn request
carries only the new prompt.

## Stream events

The SSE stream frames each self-describing envelope
(`{ id, type, version, ts, data }`) as `event:<type>` and
`data:<envelope-json>`:

| Event           | `data` payload                                                                                | Meaning                                                                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `turn.started`  | `{ turnId, model, ts }`                                                                       | turn accepted; streaming begins                                                                                                                                                                                                                                                                                                |
| `message.delta` | `{ text }`                                                                                    | assistant text chunk (print as it arrives)                                                                                                                                                                                                                                                                                     |
| `tool.call`     | `{ id, name, args }`                                                                          | model invoked a tool                                                                                                                                                                                                                                                                                                           |
| `tool.result`   | `{ id, name, ok, result?, usage?, promptDelta?, resultTokens? }`                              | tool outcome. `usage` is the round's real `{ prompt_tokens, completion_tokens, total_tokens }` when the provider reports it; `promptDelta` is the tokens the round added to the next request's context; `resultTokens` is the tokenx estimate of what this result adds to context (set per call, so it differs inside a batch) |
| `rate_limited`  | `{ attempt, maxAttempts, delayMs, retryAfterMs?, resetMs?, round, status, providerMessage? }` | non-terminal: the provider returned 429 for this round and the engine is backing off before resubmitting the same transcript (`delayMs` is the upcoming wait)                                                                                                                                                                  |
| `turn.finished` | `{ turnId, durationMs, usage?, stopReason?, rateLimitRetries? }`                              | normal end (`usage` when the provider reported it; `rateLimitRetries` counts the 429 backoffs the turn went through)                                                                                                                                                                                                           |
| `turn.aborted`  | `{ reason, usage? }`                                                                          | operator aborted the turn; transcript was healed (`usage` = totals as of the cut point when the provider reported any)                                                                                                                                                                                                         |
| `error`         | `{ code, message }`                                                                           | terminal failure (for example `provider_error`), with the same optional `usage`                                                                                                                                                                                                                                                |

## Abort

A `turn.abort` message ends the session's current turn. The abort is hard:
the stream frames the terminal `turn.aborted` at once; nothing waits for
the engine to unwind.

1. The model stream is dropped at once (remaining output is ignored, not
   consumed).
2. The tool call in flight is killed (a running bash script gets SIGTERM;
   the shell-state snapshot still lands via the wrapper's EXIT trap, so
   cwd/env persist). The engine finishes its bookkeeping in the background:
   heal, persist, settle the turn row. The wire never waits for it.
3. Any tool call the model announced but that never produced a result is
   healed in the transcript with a stub `tool` message
   (`{"error": "tool call aborted before a result was produced"}`), so the
   next turn hydrates a complete conversation and can be resumed.
4. The turn row settles with status `aborted`.

The response is `{ ok, status, session: { id }, aborted: { requested,
status, activeToolCall } }`. `status` is `aborted` when a live turn was
unwound and `idle` when the session had nothing to abort (still `ok: true`;
idempotent). `aborted.activeToolCall` names the tool call that was killed,
if any. Aborts are session-scoped: other sessions' turns are untouched.
Abort is a capability: `GET /v1/capabilities` advertises it under
`features`. Backoff waits are abortable too: a `turn.abort` during a 429
wait unwinds the turn immediately with no further provider request.

## Provider failure

A provider error mid-turn (a 429 that exhausted its retries, a timeout, any
non-abort failure) persists the partial batch exactly like an abort: the
user prompt and every completed round, with announced-but-unanswered tool
calls healed to stub `tool` messages, land in `transcript.get`. Quitting
and reopening no longer rewinds to the prior turn. The turn row settles as
`error` (not `aborted`), and that status rides the `turns[]` entries of
`transcript.get` and `turn.get`'s `turn.status`, so a client rehydrating
from the dump can mark the failed turn distinctly from an operator abort.
Persisting the partial output does not resume execution: the next turn is a
fresh turn that hydrates the healed transcript.

## Rate limits (429)

A 429 at the start of a tool-loop round is not terminal: the request was
rejected before any chunk was produced, so `messages` is unchanged and no
tool from that round has run. The engine backs off and resubmits the
identical transcript: no synthetic user message, no transcript healing, and
tools from earlier rounds are not re-executed.

Each backoff is signalled on the stream as a non-terminal `rate_limited`
event before the wait, so a client can render "rate limited, retrying in…"
instead of stalling silently; `turn.finished` then carries
`rateLimitRetries`. The wait honors the server's hints when present
(`Retry-After` / `retry-after-ms` and the `x-ratelimit-reset-*` windows,
the larger of tokens/requests governing) clamped to `rateLimitMaxDelayMs`;
with no usable hint it is exponential (`rateLimitBaseDelayMs`,
multiplied by `rateLimitBackoffFactor` per attempt, jittered). The OpenAI
SDK's own silent retries are disabled per request (`maxRetries: 0`) so every
backoff is the signalled one. After `rateLimitMaxAttempts` total tries for
a round the turn ends with a terminal `error { code: "rate_limited" }` and
the usual partial-batch persist/heal path. A failure after streaming has
begun (deltas already emitted, tool calls possibly announced) cannot be
retried transparently and stays terminal. The policy is configurable (see
[operations/configuration](../operations/index.md)); capabilities advertise
the `rate-limit-retry` feature.

## Disconnect policy

A disconnect detaches the stream, not the turn: the engine runs the turn to
its terminal state (events keep persisting, the turn row settles
`finished`/`aborted`/`error` as usual), and the terminal state stays
replayable from `turn.get`. Rehydrate from the transcript on the next
connect. This is how a UI quit, crash, or power loss mid-turn keeps the
turn alive: the server owns the turn, not the socket.

The legacy wire-tied behavior (disconnect aborts the in-flight turn) is
opt-in: pass `"abortOnDisconnect": true` together with the `streamId` of
the stream to bind it to in the `turn.start` data. While attached,
`turn.abort` remains the way to stop a turn.

Deltas are disposable; terminal states are authoritative. If the SSE
connection dies mid-turn, the client reads the `turnId` from
`turn.started` and recovers the terminal state from `turn.get`: it returns
the turn with its stored events, or a `404 unknown_session` envelope for an
unknown session/turn.

## Transcripts, resume, and session dormancy

`transcript.get` is the rehydration dump: it returns `{ session, messages,
turns? }`, where each message is `{ seq, turnId, ts, role, content,
toolCallId?, name?, toolCalls?, usage?, promptDelta?, resultTokens? }` with
a monotonic `seq` per session in conversation order. The optional `turns`
array carries per-turn metrics `{ turnId, status, usage?, durationMs? }`
(`status` is the settle status: `finished`, `aborted`, `error`, or
`interrupted`, plus `running` for an in-flight turn), so a client can
rebuild per-turn token summaries without replaying events. A tool row's
`usage` / `promptDelta` are the round attribution already carried by the
live `tool.result` envelope, and `resultTokens` rides each tool row
individually, so rehydration renders the same per-result counts. All fields
are additive and optional; older clients ignore them. The message accepts
`afterSeq`/`limit` pagination for clients holding partial state, and it
serves dormant sessions too: dormancy never blocks reads.

There is no terminal "closed" state short of retention. `session.detach`
detaches: status `open` → `dormant`, `detached_at` stamped, nothing
forfeited (transcript, turns, and events all stay); idempotent. A turn on a
dormant session implicitly revives it (status back to `open`,
`detached_at` cleared, retention clock reset). There is no reopen endpoint;
reusing the id IS the reopen. A pruned session is the only truly terminal
state: `session.detach` with `purge: true` deletes immediately, and dormant
sessions past the 30-day retention window are pruned at daemon startup.
Both are followed by `404 unknown_session` everywhere.

## Errors

Errors are `{ error: { code, message } }` JSON with a stable code→status
mapping: `invalid_request`/`unknown_model` → 400, `unauthorized` → 401,
`unknown_session` → 404, `rate_limited` → 429, `internal` → 500,
`provider_error` → 502. There is no `session_closed`: dormancy never
rejects a turn or a read. Set `apiToken` in the daemon's config to require
`Authorization: Bearer <token>` (the client forwards it).

`test/conformance.test.ts` (and its transcript extension,
`test/conformance.transcript.test.ts`) boots an ephemeral daemon and
exercises this contract exactly like an external client (plain `fetch`):
capabilities, session lifecycle, a full SSE turn transcript, server-owned
transcripts (multi-turn hydration, resume, dormancy, purge, pagination),
turn-status recovery, and the error-code mapping.
