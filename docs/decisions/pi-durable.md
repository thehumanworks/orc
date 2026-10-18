# Decision: retain ORC's session and workflow durability

Status: **skip pi-durable**, 2026-10-18.

## Decision and scope

Keep ORC's actor, mailbox, journal, process ownership and workflow records. Consolidate production
execution on the Pi CLI/RPC integration plus the existing Claude CLI integration. Do not add
`@earendil-works/pi-durable` or migrate storage in this change.

The decision follows the intended architecture, not a claim that pi-durable is unsuitable for
durable agents. It is an embedded agent harness that calls models and runs tools itself. ORC
controls independently running Pi and Claude CLIs. Keeping those interfaces leaves the difficult
ORC responsibilities in place and introduces a second durable state machine and adapters.

## Versions inspected

ORC baseline: `8fc7548cbac435eefd09ca6ba5bb1c7497311916`. Its dedicated Codex harness embedded
`pi-ai` and `pi-agent-core` **1.2.0**; its separate Pi adapter used **Pi CLI 1.2.0** over RPC.
Those are distinct integrations. This change retains the Pi CLI interface and removes the
embedded harness dependencies.

Inspected upstream Pi tags:

| Version | Commit | Role in this decision |
| --- | --- | --- |
| 1.2.0 | `06a466935536f8c9bcacb2d5efc0fc021be1bdff` | ORC's documented Pi interface; pi-durable at the same release |
| 1.3.0 | `71023aec1546d6d677a65669c5665c0927ce0dd0` | Latest published release checked on 2026-10-18; comparison against maintained upstream |

Both versions identify pi-durable as experimental and state that its API can change without
notice. The [changelog][changelog] records its initial release on 2026-10-01 and breaking changes
in 1.0.3, 1.0.4, 1.1.0 and 1.2.0, including tool result types, storage error handling and task
schemas. The 1.3.0 fixes and extensive recovery tests are evidence of active maintenance, but
not a stable compatibility commitment.

## Guarantees ORC already owns

The required contract comes from code and tests, rather than interpreting “durable” as a general
guarantee:

| Responsibility | Existing implementation and regression evidence |
| --- | --- |
| One actor and journal writer per session; PID reuse checks, lease expiry, stale provider cleanup before restart | `src/runtime/actor-state.ts`, `actor-main.ts`, `client.ts`, `process.ts`; `test/runtime-actor.test.ts`, `test/lock.test.ts` |
| Any client can exit after a durable enqueue; queued messages survive actor failure; one turn at a time in mailbox order | `src/runtime/inbox.ts`, `actor-main.ts`; `test/runtime-kernel.test.ts`, `test/runtime-actor.test.ts` |
| Same message ID deduplicates; different text with that ID fails; intent precedes the provider write; acknowledgement precedes a known delivery result | `src/session.ts` (`send`), `src/runtime/client.ts`, `derive.ts`; `test/session-actor.test.ts`, `test/runtime-actor.test.ts` |
| A dispatch cut before acknowledgement has an **unknown** outcome and is never automatically sent again | `src/runtime/actor-main.ts` (`boot`), `derive.ts` (`verdictFor`); crash-before-ack tests in `test/runtime-actor.test.ts` |
| Kill/takeover stay stopped, interrupt cannot spill into a future incarnation, and native CLI takeover retains history | `src/runtime/stop.ts`, `client.ts`, `src/session.ts`; `test/runtime-reopen.test.ts`, `test/session-actor.test.ts` |
| Workflow plan/digest persisted before effects; revision/CAS and runner ownership; bounded DAG concurrency; adopt in-flight children and require explicit retry for uncertain delivery | `src/runs.ts`, `workflow.ts`, `workflow-scheduler.ts`; `test/workflow-durable.test.ts`, `test/workflow-adoption.test.ts`, `test/workflow-runner.test.ts`, `test/workflow-concurrency.test.ts` |

An actor restart recovers control and the provider's saved conversation. It closes an unfinished
ORC turn as interrupted; it does not resume an arbitrary instruction inside a tool or re-execute
the old prompt. A previously acknowledged turn retains an acknowledged delivery verdict after
recovery; a turn without acknowledgement remains unknown. Workflow adoption never resends the
instruction just because the runner died. Neither ORC's files nor provider transcripts make
shell commands, remote requests or other external effects exactly once.

## What adoption would remove, retain and add

| Area | Potential replacement | What remains or must be introduced |
| --- | --- | --- |
| Transcript and model/tool checkpointing | Durable's entries, generation and tool tasks provide this for its own harness | Pi CLI sessions and Claude transcripts still need their current readers and native takeover. Using Durable's built-in generation instead would replace Pi CLI execution and require rebuilding CLI settings, extensions, tools and authentication integration. |
| Generic atomic storage | Durable storage can atomically commit entries, documents and tasks | ORC needs a schema and migration for registry IDs, spawn specs, inbox items, journal sequences and run records. Wrapping current records without removing their semantics duplicates storage. |
| Ownership and client delivery | Durable serializes mutations within one open storage | Upstream explicitly supplies **no cross-process locking**. ORC must retain actor locks/leases, wake, stale-process cleanup and a mailbox or new IPC service for independent clients. |
| Message receipts | Durable `requestId` deduplicates submissions | ORC still needs `queued`/`acknowledged`/`unknown` receipt semantics across CLI pipes. Durable's [`admitSubmission`][submissions] checks an existing request's type, not equal prompt content; ORC's conflict check remains necessary. |
| Workflows | Durable custom tasks could represent portions of scheduling | Claude/Pi process adapters, plan digests, attempt history, success verification, artifacts, lineage, execution policy, ownership-safe cancellation and uncertain-delivery adoption remain ORC-specific. |

For the retained CLI architecture, there is no demonstrated production module that can simply be
deleted by installing pi-durable. A generic storage rewrite could replace pieces of `inbox.ts`,
`journal.ts` or run persistence only by adding schema/receipt adapters and migrating every
consumer. Keeping a Durable harness around a CLI turn would still need a durable intent,
acknowledgement and uncertain-delivery reconciliation: the external CLI does not participate in
Durable's storage transaction. This is additional maintenance rather than a supported shortcut.

The interface distinction is visible in upstream [generation source][generation]: it resolves a
pi-ai model and calls `runtime.models.streamSimple()`. It does not attach to `pi --mode rpc` or
restore the Pi CLI's `SessionManager` file. The retained Claude integration cannot use those
generation checkpoints either.

## Recovery, ordering and external effects

Durable's [recovery tests][recovery] resend a model request interrupted before completion, recover
committed partial output, and resume deferred-response polling. Its [tool recovery tests][tools]
rerun a tool only when both its stored policy and current declaration say it is replay-safe.
Otherwise they record an interrupted result, including the possibility of partial execution.
An effectful tool marked replay-safe still needs application-level idempotency. These are useful
semantics for a harness that owns the model/tool loop, not a guarantee about a foreign CLI's
unknown prompt acknowledgement.

Durable also distinguishes cancellation of a wait from cancellation of work, has configurable
steer/follow-up queues and owner-based task cancellation. ORC would need to map those to its
single-turn mailbox, stale-interrupt cutoff, sticky stop, native takeover and workflow cascade
rules. Durable's live watches may coalesce frames for slow readers; they do not replace ORC's
append-only journal history. Preserve these contracts explicitly in any future proposal.

## Runtime, dependencies and migration cost

The [package manifest][manifest] declares MIT and Node >=22.19.0. At 1.2.0 its internal Pi
dependencies are version ranges; at 1.3.0 they are exact versions. Dependencies include Chord,
pi-ai, pi-codemode, Photon, diff and TypeBox. Code mode in turn depends on QuickJS WASI. These
would add a dependency tree to ORC after removal of the dedicated harness; unused optional
features need not be loaded, but their installation and release compatibility still need review.
Skipping adds no dependency or licensing obligation.

The [storage documentation][storage] explicitly supports the portable core on Bun with a
compatible asynchronous SQLite facade or filesystem. Therefore Bun is not a reason to reject
it outright. However, its provided Node SQLite adapter imports `node:sqlite`; ORC would need to
verify that adapter on its exact Bun runtime or supply a `bun:sqlite` facade, and validate the
four compiled macOS/Linux targets plus Nix packaging. That compatibility has not been claimed
or experimentally established here.

Storage defaults differ: SQLite uses WAL with `synchronous = NORMAL`, and JSONL defaults to no
fsync and keeps history in memory. ORC explicitly fsyncs mailbox writes and critical journal
events. An adoption would need a deliberate persistence policy and failure tests, not an
assumption that default storage settings preserve every host-failure guarantee.

There is no demonstrated importer for ORC journals/workflow schemas or Pi CLI sessions in the
evaluated API. Importing transcript entries alone cannot reconstruct an in-flight computation
or decide whether an external effect occurred. Keeping native readable history, or supplying a
validated one-way importer with archived source data and no automatic replay, would be necessary.
The current change leaves ORC storage in place; Codex-session continuation is documented in
[the integration migration guide](../MIGRATION-pi.md).

## Acceptance and future reconsideration

No feasibility prototype is needed to resolve this decision: source inspection establishes the
interface mismatch and the retained ownership/delivery work. An embedded echo agent would prove
Durable works, but would not demonstrate deletion of ORC's shared Pi/Claude responsibilities.
This assessment uses upstream code and recovery-test inspection, not a claimed live-provider or
cross-platform Durable experiment.

Reconsider if upstream offers stable support for externally managed CLI sessions and native
transcript interchange, or if ORC intentionally chooses to own a model/tool harness instead of
using Pi CLI. Require a small adapter to delete substantial existing code, preserve Claude and
the contracts above, and pass crash/uncertain-delivery and compiled-platform checks before
migrating persisted data.

[changelog]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/CHANGELOG.md
[generation]: https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/durable/src/harness/generation.ts
[submissions]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/submissions.ts
[recovery]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/harness-generation-recovery.test.ts
[tools]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/harness-tools-recovery.test.ts
[manifest]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/package.json
[storage]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md#storage
