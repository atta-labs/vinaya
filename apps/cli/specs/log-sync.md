# Reading the Vinaya Log — sources, the cache and the dataset

Status: draft

The Vinaya Log is written one line per event (`log.md`). Reading it back — to answer questions about how work went — is a separate path with its own contracts, all in `packages/aeg-core/src/log/sync/`: a **source** that pages stored lines out of wherever the log was delivered, one **normaliser** that turns each line into a dataset row or a quarantine record, a **cache** that holds the rows between reads, and a **dataset** that a query reads. Every one of them is pure policy (`surface.md` "The rule"); the effects that open a folder, call a server or open a database file live in `apps/cli/src/lib`.

The sender's queue contract, `LogStore` (`packages/aeg-core/src/log/store.ts` — append, read a page, acknowledge), is a different thing and stays separate: it is how events leave a process, not how a reader gathers them.

## The normalised row

`normalizeStoredLine(raw, origin)` (`normalize.ts`) turns one stored line into **exactly one** of:

- a **row** (`DatasetRow`, `row.ts`) — the line validated under a schema version this build knows (`1`, `2` or `3`);
- a **quarantine record** (`QuarantineRecord`) — the line names a schema version this build does not know, or fails validation under the one it names, or is not JSON at all. It holds the reason, the raw text with the same redaction every read applies (a secret in a line that failed validation never reaches a cache), the identity when one can be read, the schema version when one can be read, and the sha256 of the raw text. It produces no row.

Validation, version handling and redaction are `classifyStoredLine`'s (`store.ts`), called with an empty home directory; the normaliser only maps its three outcomes (`ok` to a row, `unknown_version` and `invalid` to quarantine). There is no second validator.

A row carries, as columns:

| Column | From | Present in |
| --- | --- | --- |
| `identity` | `meta.event_id`; for schema 1, `<run_id>:<seq>` | every schema |
| `schema`, `kind`, `event` | the line | every schema |
| `time` | `meta.ts` | every schema |
| `runId`, `seq` | `meta.run_id`, `meta.seq` | every schema |
| `workRef` | `meta.work.ref` | schema 3 |
| `actor` | `meta.actor_id` | schema 2 and 3 |
| `cliVersion`, `doctrine`, `host`, `repo` | `meta.vinaya`, `meta.doctrine`, `meta.host`, `meta.repo` | every schema |
| `flowId`, `flowVersion` | `meta.flow.id`, `meta.flow.version` | schema 3 |
| `provenance` | `meta.provenance` | schema 2 and 3 |
| `trust` | see "The low-trust rule" | — |
| `issue`, `pr`, `round`, `commit`, `role`, `objectivesVersion` | `subject.issue`, `.pr`, `.round`, `.sha`, `.role`, `.objectives_version` | every schema |

and, beside the columns:

- `header` — the line's `meta` and `subject` exactly as validated, so a header field with no column (lineage, input versions, runtime, the rest of `work`) is never lost;
- `payload` — every field of the event outside `meta`, `subject`, `kind` and `event`: the family body, as JSON;
- `contentHash` — the sha256 of the line as the read boundary serialises it after redaction (`classifyStoredLine`'s `postLine`), so the same event read from two places hashes the same;
- `origin` — the source id and the line's position in it.

`kind` and `event` are plain text and the body is untyped JSON. Nothing on this path switches over the family or the event name, so a family added later — a consumer's own declared `custom` events included — is stored and read back without a code change here.

**Identity is the event's, never its position.** Two sources can hold the same event — a folder and the server it was forwarded to — so a row's position in its source is provenance (`origin`), never part of its identity or its hash.

## The unknown rule

A field a line's schema never had reads as **unknown**, never as a default. A schema 1 line has no `event_id`, no actor, no work reference, no flow and no provenance; a schema 2 line has no work reference and no flow. Each such column is `null` **and** named in the row's `unknown` map with the reason (`a schema 1 header has no actor_id`). A column not named in `unknown` carries the line's own value — `null` included, when the writer recorded that it had nothing to say (a schema 3 line whose caller named no work reference). A subject field the line simply omits (`pr`, `round`, `sha`, `objectives_version` are optional in every schema) reads `null` and is not unknown.

Nothing is defaulted to `0`, `''` or `false`.

`Measured<T>` (`measured.ts`) is the same rule for an answer: `{ known: true, value }` or `{ known: false, reason }`. A question the log cannot answer — because a field is unknown, a gap covers the period, or a line is quarantined — returns the reason rather than a number that looks measured.

## The low-trust rule

A row written by a CLI older than `0.33.0` (`LOW_TRUST_BELOW_VERSION`, `row.ts`), or by a line whose `meta.vinaya` is not a readable version, has `trust: 'low'` whatever its header declares: attribution before that version was not recorded reliably. Versions compare numerically by major, minor and patch; a pre-release of `0.33.0` counts as below it (`isLowTrustVersion`). Every other row's `trust` is the provenance its header declares — `parent_attributed`, `env_correlated`, `self_reported` or `unavailable`. A schema 1 row from a version at or above the threshold declares no provenance, so its `trust` is unknown.

## The three contracts

All three are types in `contracts.ts`, exported from the log module.

**Source** (`LogSource`) — where stored lines come from, a log folder or a log server. `id` is stable across runs for the same place and keys everything stored about it. `readPage(cursor, limit)` returns at most `limit` lines, each with its opaque position, the cursor to resume from (`null` when nothing followed), and every **gap** the source knows it cannot fill: a stretch rotated away, expired from a server's retention, or rejected on receipt, with its bounds and — as a `Measured` count — how many lines it lost. A gap is reported, never skipped silently. Reading never writes to the source.

**Cache** (`LogCache`) — where normalised rows live between reads. `put` is idempotent by identity:

- a new identity is inserted;
- the same identity with the same `contentHash` is a duplicate and adds nothing;
- the same identity with a different `contentHash` keeps the **first** row, adds no second row, and records one **edit** (`RowEdit`: the kept hash, the offered hash, where it was read) per distinct offered content.

A quarantine record is keyed by the hash of its raw text. The cache also stores each source's cursor and every recorded gap, recording the same gap twice keeps one, and every one of them reads back exactly as written.

**Dataset** (`Dataset`) — what a query reads: every row exactly once, ordered by `time` then `identity`; every gap, in the order recorded; every quarantined line, in the order first stored. The ordering is fixed so two backends holding the same content give identical answers.

## The shared cache contract

The cache's behaviours are written once, as a list of cases (`cacheContractCases`, `cache-contract.ts`) that throw on the first broken expectation and import no test framework. Every backend's own test runs every case against a fresh instance of that backend. `createMemoryCache` (`memory-cache.ts`) is the in-memory backend — no I/O, no clock — that passes them and that every reader is tested against; a durable backend passes the same list.

<!-- AEG:CLAIM: packages/aeg-core/src/log/sync/normalize.ts contains:const classified = classifyStoredLine(raw, '') -->
<!-- AEG:CLAIM: packages/aeg-core/src/log/sync/row.ts contains:export const LOW_TRUST_BELOW_VERSION = '0.33.0' -->
