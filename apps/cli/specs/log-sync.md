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

`kind` and `event` are plain text and the body is untyped JSON. Nothing on this path switches over the family or the event name, so a family added later — a consumer's own declared `custom` events included — is stored and read back without a code change here. The same holds for an event a family adds or stops recording: a `gate` `summary` (a check run's counts, failing check names and total time) and the single `effect` `verified` line a forge write records become rows like any other, their fields in `payload`.

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

## The server source

`createServerLogSource` (`apps/cli/src/lib/log-sync-server-source.ts`) is the `LogSource` that reads a log server over its wire contract (`apps/log-server/specs/server.md` § 5): the read route (`GET events?after=&limit=`, paged by `seq`, bounded at 1000 lines a request — the server's own maximum), the stats route (the server's head position and stored event count) and the rejected route (why lines were refused). It takes `fetch` itself, the destination's events URL and the raw `logs.readHeaders` as constructor arguments — never a resolved destination — so a fake `fetch` proves every behaviour with no network. On the wire, an empty page's response header repeats the `after` that was asked for (§ 5); the source translates that into this contract's own `next: null` ("nothing followed", above) rather than passing the repeated position through, so a caller that stops on `next === null` actually stops.

**Credential.** The read credential is `logs.readHeaders`, always separate from the ingest credential (`logs.headers`): the server refuses the ingest token on a read route (§ 5), and this source's dependencies hold no code path that could reach it. A `${VAR}` reference unset in this process's environment is caught before any request leaves it; a server-reported `401` on any route is the same case. Either way the failure names the `${VAR}` to set and never the resolved value.

**What the server retains.** `retention()` reads the stats route and states the server's head (`last_seq`) and stored event count as a `Measured<number>` pair, plus the gap between them: rows are never deleted on this server (`apps/log-server/specs/server.md` § 4), so a stored count below the head is a gap, never a deletion.

**Look-back.** `lookback(cursor, span)` reads the `span` positions immediately before `cursor` with the same read route, by computing its own start position (`cursor - span`, clamped at zero) rather than a second route. `readPage` and `lookback` together report every row read so far on the instance, so a run's own cost is visible against the server's daily read allowance (`apps/log-server/specs/server.md` § 2).

**Lost events.** `rejected()` reads the rejected route and reports its reasons and counts as a diagnostic. A server with no rejected route (a `404`, predating this route) is reported `available: false`, never as zero lost events.

**Failure.** A page, a look-back, a retention read or a rejected read each fail with a reason naming one of: a refused credential, an unreachable server, a timeout, or a server error — never losing the caller's position, so a retry resumes from the same cursor.

## The folder source

`createFolderLogSource` (`apps/cli/src/lib/log-sync-folder-source.ts`) is the `LogSource` that reads a log folder's own layout — `<folder>/<owner>-<repo>/<work>.ndjson`, rotated once at 8 MiB into a single overwritten `<work>.1.ndjson` slot (`log-sink.ts`). It is scoped to one repository: the directory it lists is the same one `outboxPathFor` (imported from the sink, never re-derived) already names for that repository, so a sibling repository's own files sharing the same folder root are never opened, listed or touched.

**The stream.** Each `.ndjson` file directly inside that one directory, apart from a `.1.ndjson` rotation slot, is a stream, named by its file's own basename — the work reference the sink used, or the literal `none` for work with no tracker item, read like any other. A stream appearing or disappearing between runs is discovered fresh on every `readPage` call; nothing is cached between calls beyond the cursor below.

**The cursor.** Opaque JSON: a map from stream name to the byte offset read so far into what is, at rest, the LIVE file, and a sha256 fingerprint of that live file's own first complete line. The fingerprint is what tells a rotation from a truncation once the same byte offset can name different bytes: a live file smaller than the recorded offset, or one whose first line no longer hashes to the recorded fingerprint, has rotated.

**Complete lines only.** The sink's append writes a line and its trailing newline in one write, but a reader can still observe a half-written one while the writer is mid-write. A line with no `\n` yet — always the last bytes read — is never returned as a line and never quarantined; the cursor stops short of it, so the next run reads it once it is whole.

**Rotation, followed.** Once a rotation is detected, the source reads the rotated slot from the recorded offset onward — *if* the slot's own first-line fingerprint still matches what was recorded, proving the slot holds that same generation's unread tail — then continues into the new live file from its own start. A slot that no longer matches (overwritten by a second rotation before this reader reached it) or does not exist at all (a bare truncation, not a rotation the sink performed) is a **retention gap**: a `SourceGap` naming the stream and the offset it trailed off at as its lower bound, no upper bound and no count — the overwritten bytes are gone, and only the sink itself could have counted them at the moment of rotation. Reading still continues into whatever is live now; the loss is reported, never fatal.

**Look-back.** `lookback(cursor, span)` — this source's own extension over the `LogSource` contract, mirroring the server source's identically-named method above — re-reads, independently of the stored cursor, the last `span` complete lines of each stream the cursor already knows, with their CURRENT on-disk content: an edited line comes back edited, and a stream whose live file has vanished returns nothing for the identities the cache holds inside that span, rather than inventing an empty record or throwing. It never advances or mutates the cursor; it is a side read, not a resumption point.

**Refusal.** Every file this source opens — a live file, a rotated slot — is opened `O_NOFOLLOW`, so a symlink is refused atomically rather than raced against a separate `lstat`; the open descriptor is then confirmed a regular file before anything is read. Neither check throws: a symlinked or non-regular entry is simply excluded from the stream listing, or, for a rotated slot, treated as a missing slot — a retention gap, not a crash. This source never writes, renames or deletes anything in the folder it reads.

<!-- AEG:CLAIM: apps/cli/src/lib/log-sync-folder-source.ts contains:export function createFolderLogSource(deps: FolderSourceDeps): FolderLogSource { -->
<!-- AEG:CLAIM: apps/cli/src/lib/log-sync-folder-source.ts contains:lookback(cursor: SourceCursor | null, span: number): Promise<SourcePage> -->

## The sync run

`syncSource(source, cache, options)` (`engine.ts`) is the one algorithm that moves a source's lines into a cache. It is pure policy: a function over the source and cache it is handed, with the clock (`now`) and the bounds passed in `options`, no I/O and no clock read of its own. It returns a `SyncSummary` and never throws for a lost, edited or quarantined line — it reports them.

**The cursor is the look-back anchor.** The cursor the cache stores for a source is not the head of what was consumed but a point that **trails** it by at most the look-back span. A run reads pages forward from that cursor, so the one read serves two ends at once: it resumes after a failure, and it re-reads the trailing look-back span every run. A forward-only cursor could never discover a line edited or deleted behind it; trailing the cursor is what makes every run re-read enough to find them.

**Store, then advance.** Each page's rows and quarantine records are stored in the cache before anything else happens; the cursor is advanced to the new anchor only once the whole run's pages are stored, and a run that fails part way leaves the cursor where it was. A failure therefore keeps every page stored before it and never advances past a line it did not store — the next run resumes from the last stored cursor and ends in the same cache as an uninterrupted run. The overlap a resumed or repeated run re-reads deduplicates by identity (the cache's `put`), so a replayed page leaves one row per identity.

**Edits and deletions.** Across the re-read span the run compares each line with what the cache holds. A held identity offered with different content is an **edit**, recorded beside the kept first row (`put` again). A held identity that lay inside the re-read span and the source no longer returns — judged within the time span the run actually re-read, so a row older or newer than the span is untouched — is a **deletion**, listed in the summary. Neither removes or overwrites the stored row: the cache is derived evidence and a rebuild cannot recover a deleted source line.

**Gaps, never guessed.** The engine tells a deletion from a retention loss by asking the source, never by guessing. A span the source reports it cannot fill — rotated away, past retention, rejected, or a skip in its positions — is recorded as a **gap** with its bounds. A source whose head has fallen behind the stored cursor (it retained nothing from where the cache resumes) is itself recorded as a gap. A run that saw any gap reports no deletion for that run: a missing span is always a gap, never a deletion.

**Bounds.** A run is bounded, because a server's daily read budget is finite: it reads at most `maxPages` pages (default 50) of at most `pageLimit` lines (default 1000), and re-reads at most a `lookback` span (default 1000 positions). A run that stops on its page bound reports `moreAvailable` and leaves its cursor trailing the last stored page, so the next run continues. All three bounds are options of the run, not constants of the algorithm.

**The summary.** `SyncSummary` reports the run's pages read, rows stored, duplicates seen, edits, deletions, gaps and quarantined lines, whether the run completed (reached the source's end without a failure) and whether more is available, and the failure when one ended it early. Because the cache keeps no deletion record, the summary is where a deletion is reported.

## The questions

A question is a pure function over a `Dataset` (`packages/aeg-core/src/log/questions/`): no I/O, no clock, and no switch over the event families — it picks rows by comparing `kind` and `event` as text. Its answer is built from `Measured`, so a figure the log cannot state is unknown with the reason, never a number that looks measured.

**A unit of work is the work reference** (`workRef`). A row that names none cannot be attributed to a unit; it is left out of every unit figure and counted in the coverage.

**Every answer states its coverage** (`Coverage`, `questions/common.ts`):

- `rowsRead` — every row the dataset holds;
- `lowTrustLeftOut` — rows of the low-trust rule, left out of every figure and counted out loud, never mixed in;
- `unitUnknown` — trusted rows of the kinds the question reads whose unit is unknown;
- `rowsUsed` — the trusted rows of those kinds with a known unit, which the figures are built from;
- `gaps` and `quarantined` — what the dataset itself could not hold;
- `unknowns` — each figure the answer could not compute, with the reason.

An answer is descriptive. It reports what the log recorded and never that one choice caused another.

**The map.** `QUESTIONS` (`questions/index.ts`) holds one entry per question under its number — `q1`, `q3`, `q4` — each with its number, its title and the function that answers it over a dataset. A question not in the map is not yet answered.

### Question 1 — does a cheaper model finish?

`completionByModel`. For each model, over the units of work it took part in:

- **model** — the model a `dispatch` or a `role_attempt` line names. A unit that used two models counts under both. A unit none of whose lines names a model is reported as unknown, never attributed;
- **started** — units with such a line;
- **green** — units whose loop recorded the `green` stop condition; **paused** — units whose loop paused at least once (a unit can be both); **escalated** — units whose loop recorded the `escalated` stop condition;
- **roundsToGreen** — for the green units, how many went green in one round, in two, and so on, ascending;
- **timeToGreenMs** — the loop's own `time_to_green_ms` of each green unit, ascending, taken from the unit's last `journal_finalized` line. It is unknown, with the reason, when no unit went green or none recorded one; a green unit without one is named in `unknowns`.

### Question 3 — what does a unit of work cost?

`usageByUnitAndRole`. Usage by unit of work and by role, with the totals for each role across units. Retries and failed attempts are part of the cost: a failed or timed-out dispatch, and every attempt of a role, counts.

Three kinds of record state usage, and each is counted by its own rule:

- a **`usage` observation** states its units (`input`, `output`, `cache`) and whether it is `cumulative` or `delta`. A cumulative observation is a running total, so per run and model only the **last** one stands for all of them — cumulative observations are never added to each other. Delta observations are **additions**, each one counted. A cumulative total and a delta are never added to each other;
- a **`dispatch`** line that ends a dispatch (`outcome_received`, `dispatch_failed`) and a **`role_attempt`** line each carry the usage of one attempt. A dispatch and the role attempt it ran share an effect id, so one attempt is one figure, taken from whichever line states it. These records have no cache count, so a cache total that includes one is unknown.

A figure is the sum of its terms and is **known only when every term states it**. When any term does not, the figure is unknown with the reason (`2 of 6 observations record no input`); it is never counted as zero. A stated zero is a number. A role is the `target_role` of a dispatch, otherwise the role the line itself names; a line that names none reads `unattributed`.

### Question 4 — where does the time go?

`timeByUnit`. For each unit of work, four durations, each built from intervals:

- **develop** — a developer dispatch, from its `dispatched` line to the `outcome_received` or `dispatch_failed` line that ends it (matched by effect id);
- **review** — the same for a `code-reviewer` or `security` dispatch. A dispatch of any other role is in neither;
- **check** — a check run's own total time (the `duration_ms` of its `gate` `summary` line), measured backwards from that line. The per-check `checked` lines are not used, so a run is not counted twice;
- **wait** — a pause, from the `paused` line to the `resumed` or `cancelled` line that ends it.

**Elapsed and summed are different things.** Work overlaps — two dispatches can run at once — so each duration is reported twice: `summedMs`, every interval's length added together, and `elapsedMs`, the length of the union of the intervals, which counts an overlap once. They are equal only when nothing overlapped. Neither is ever presented as the other.

A category with no complete interval is unknown, with the reason — nothing recorded, or intervals that never ended (a dispatch with no outcome line, a pause never resumed, a check run with no duration). A category with some complete intervals reports them and counts the ones it could not measure in `incomplete`. A duration is never zero unless a line states it.

<!-- AEG:CLAIM: packages/aeg-core/src/log/sync/engine.ts contains:export async function syncSource(source: LogSource, cache: LogCache, options: SyncOptions): Promise<SyncSummary> { -->
<!-- AEG:CLAIM: packages/aeg-core/src/log/sync/normalize.ts contains:const classified = classifyStoredLine(raw, '') -->
<!-- AEG:CLAIM: packages/aeg-core/src/log/sync/row.ts contains:export const LOW_TRUST_BELOW_VERSION = '0.33.0' -->
<!-- AEG:CLAIM: apps/cli/src/lib/log-sync-server-source.ts contains:export const SERVER_SOURCE_PAGE_MAX = 1000 -->
<!-- AEG:CLAIM: apps/cli/src/lib/log-sync-server-source.ts contains:export const SERVER_SOURCE_TIMEOUT_MS = 10_000 -->
