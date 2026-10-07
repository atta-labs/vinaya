# Atta runtime and provider capability fit — the capability matrix and its decision record

Status: draft

Scope: whether every capability the Atta-backed developer-review workflow
needs fits the decided consumption boundary, who owns it, and what each
provider adapter must supply. It judges fit and names gaps. It does not
choose another packaging, runtime, orchestration framework or
provider-specific core, changes no production behavior, and designs no fix
for a gap it names. The governing contract is the Linear "Tech spec —
Developer-review on Atta Engine", revision 9. The workflow it judges is
`apps/cli/specs/dev-review-engine-state-machine.md`; the behaviors it traces
to are `apps/cli/specs/dev-review-invariants.md`'s register; the
confinement facts come from `apps/cli/specs/isolation.md`.

The data lives in
`apps/cli/tests/fixtures/dev-review-engine-capability-matrix.json`. Its
conformance test,
`apps/cli/tests/conformance/dev-review-engine-capability-matrix.test.ts`,
keeps the data mechanically complete. The structured matrix and that test
are the acceptance surface; this file explains them and claims nothing they
do not hold.

## The decision

<!-- AEG:CLAIM: apps/cli/tests/fixtures/dev-review-engine-capability-matrix.json contains:"id": "packed-public-runtime+injected-executor", -->
Vinaya consumes Atta's packed public runtime through its injected-executor
seam: the `@atta/agents`, `@atta/engine` and `@atta/executor-agent-spawn`
artifacts as built and packed at Atta commit
`249d8fc11e525bd015daf9b35cfbd9cfac66f44d`, on Atta's main branch. That
boundary is fixed. Every runtime row records it, cites Atta source pinned at
that commit with a line anchor, and concludes `fit` or a named gap.

At that commit every runtime capability the workflow needs fits: Flow and
Plan compilation, the external-consumer packaging proof, the injected node
executor, fan-out and join, checkpoint-backed continuation, halt and resume
without replay, a typed paused outcome for human input, the live event
stream, cancellation of a live child, typed run outcomes, refusal of an
undeclared role or action, the subscription-login invocation seam, and
redaction of observed and persisted output. None is a gap, so no Atta
capability is escalated. The limitations that come with each are recorded
on its row and are obligations Vinaya keeps, not gaps:

- **Legs of one run are serialised by the caller.** The runtime cannot stop
  two concurrent resumes of one run; Vinaya's one-driver-per-task lock is
  what does.
- **Resume carries no input value.** A human decision reaches the resumed
  node through Vinaya's prepared inputs, read by the injected executor.
- **A node in flight at a halt runs again on resume,** and the runtime keeps
  no effect ledger, so every effect inside a node is keyed and reconciled by
  Vinaya's effect executor.
- **The artifacts are private and unpublished.** Vinaya installs tarballs
  built from a recorded Atta commit, pinning the transitive `@atta` ranges
  to them as the external-consumer proof does.
- **Runtime outcome reasons are coarser than Vinaya's terminal outcomes**
  and there is no cancelled reason; the mapping is Vinaya's.

## Ownership

Four owners, one per row:

| Owner | Owns |
| --- | --- |
| `atta-engine` | Flow and Plan representation and validation; the packed artifact set. |
| `atta-runtime` | The LangGraph-backed runtime: scheduling, checkpoint-backed continuation, halts, joins, streaming and cancellation. |
| `vinaya` | Prepared inputs, legal transitions, review validity, convergence, budgets, terminal meaning, governed effects, Operator controls, Log production, and the five core ports. |
| `provider-adapter` | Invocation, session translation, sandbox, tool registration, structured output parsing, streaming, cancellation, usage and normalized errors, per adapter. |

The framework executes the graph; Vinaya owns policy, effects, review
semantics and the Log. A row never lets one stand in for the other.

## One core contract for every adapter

The core is the five ports — `AgentRuntime`, `ToolCatalog`,
`SourceProvider`, `EffectExecutor`, `RunControl` — plus one node contract,
role grants and subscription-only login. No core row names a vendor. Every
adapter, today `claude-code` and `codex` and any future one, fills the same
eleven required adapter capabilities exactly once: invocation, structured
output, event stream, session continuation, tool registration, tool grants,
unattended permissions, cancellation, usage, normalized errors and role
context. A capability only one provider has is recorded as a
provider-specific cell owned by that adapter (Claude Code's lifecycle hooks,
Codex's protected paths), never as a core field.

Every adapter cell cites that adapter's own CLI or sandbox documentation.
The OpenAI Agents SDK guides and the Claude API platform pages describe
other products; they ground pattern rows only (code-orchestrated control,
the trace hierarchy) and never an adapter cell.

One adapter cell is a named gap. **GAP-ADP-01, Codex cancellation
semantics undocumented** (owning layer: the Codex provider adapter): the
runtime's process termination stops a `codex exec` child, but the cited
Codex sections say nothing about interrupting a run or what a resumed
session holds afterwards. It stays unaccepted until a primary Codex source
covers it.

## Confinement

One confinement row per adapter and platform names the vendor sandbox, the
refusal when confinement is missing or fails on first use, and publication
through the tools the driver runs:

| Adapter | Platform | Vendor sandbox | Refusal |
| --- | --- | --- | --- |
| Claude Code | macOS | Built-in sandbox, Seatbelt | `failIfUnavailable` ends a run whose sandbox cannot start; an unwritable settings file refuses before spawn. |
| Claude Code | Linux | Built-in sandbox, bubblewrap and socat | Refuses before spawn when `bwrap` or `socat` is missing; `failIfUnavailable` as on macOS. |
| Codex | macOS | `workspace-write`, Seatbelt, network proxy | Refuses before spawn when the sandbox, proxy or staged `CODEX_HOME` is unavailable, or staging fails. |
| Codex | Linux | `workspace-write`, bwrap and seccomp, network proxy | Refuses before spawn when `bwrap` is missing. |

On every row the worker holds no forge credential and publishes, opens and
reads its pull request and runs checks only through `publish_changes`,
`open_pull_request`, `update_pull_request_body`, `refresh_evidence`,
`read_pull_request` and `run_checks`, run by the driver outside the sandbox.

Three confinement gaps are named, each with its owning layer, and none is
designed away here:

- **GAP-CONF-01, driver-run code executes outside the sandbox** — owning
  layer: the Vinaya driver's governed effects and driver-run tools.
  Publication and checks run with the driver's authority, including
  repository hooks and checks the worker's own commits can change.
- **GAP-CONF-02, tool-socket reach between processes of the same user** —
  owning layer: the Vinaya tool catalog's driver-run tools server.
  Confinement hides the socket root from sandboxed tool calls only; an
  unconfined process of the same user can still reach another task's
  socket.
- **GAP-CONF-03, the copied Codex login** — owning layer: the Codex provider
  adapter's session and credential staging. The copied `auth.json` is a
  durable bearer token any repository command the confined Codex runs can
  read.

## Sources

Every citation carries a pinned URL and a section anchor. Atta and in-repo
sources are GitHub blob URLs at a full commit with a line anchor; in-repo
spec anchors are real headings of that spec. Documentation pages are cited
by the section headings read from the live pages on 2026-10-06, never by a
summary of them. Each row also traces to the invariant register's product
guarantees and named defects it bears on, or says why it has none.

## Running the test

```
bun test apps/cli/tests/conformance/dev-review-engine-capability-matrix.test.ts
```

It prints the matrix-row, owner, fit, gap, provider, confinement-row,
confinement-gap and citation counts. Empty owner cells, citations lacking a
pinned URL plus section anchor, and adapter cells citing the OpenAI Agents
SDK or the Claude API platform pages must all read zero.

## Changing this matrix

A new Atta commit is a new pin: re-read the cited source at that commit,
update every Atta URL and line anchor together, and re-judge each runtime
row. A new adapter is a new entry in `adapters` and one cell per required
capability; parity fails until every cell exists. A gap closes only when a
cited primary source shows the capability, and the row then reads `fit`
with that citation.
