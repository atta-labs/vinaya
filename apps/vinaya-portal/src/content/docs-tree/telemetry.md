# Telemetry — definition

Summary: The Log's record, counted: cost, time, review strictness, which checks catch most. vinaya sync reads stored events from your folder or server into a local cache, and a set of questions reads the cache.
Parent: Features
Badges: vinaya sync · Local cache · Ten questions, plus a confidence comparison · Unknown, never zero

## About Telemetry

Telemetry is the feature that reads what the [Log](/docs/features/log) stores and counts it. It needs no configuration of its own: it reads the Log's destination.

Reading is separate from delivery. Delivery sends events out of a process; Telemetry gathers what was stored and answers questions about it.

The read path has four steps: a **source** pages through stored lines, a **normaliser** turns each line into a row (or sets it aside), a **cache** keeps the rows, and **questions** read the rows. `vinaya sync` runs the first three. Every step is pure except the parts that open a folder, call a server or open a database.

## How it works

```steps
### Read a page from the source
The source is your folder or your server, whichever `logs` names. Each page returns lines with their positions, a cursor to resume from, and every gap the source knows it cannot fill. Reading never changes the source.

### Normalise each line
Each line becomes one dataset row or one quarantine record, using the same check the sender uses. There is no second validator.

### Store it in the cache
Rows are stored by the event's identity, so reading the same line twice adds nothing. The cache also keeps each source's cursor and every gap.

### Ask a question
A question reads the whole dataset and answers with a figure, or with "unknown" and the reason.
```

## Run a sync

```bash
vinaya sync
```

| Option or outcome | Behaviour |
| --- | --- |
| Destination | Resolved as for delivery: attended for you at your terminal, held to the default-branch rule when unattended; never forced unattended |
| Output | A summary as text, or as JSON with `--json`. A server destination also prints the lines it rejected on receipt. |
| Exit `0` | Completed, or stopped at the page limit |
| Exit `1` | Failed part way. Stored pages stay; run it again to resume. |
| Exit `2` | The destination is `none`, or a server has no usable `logs.readHeaders` |
| `--rebuild` | Deletes `cache.sqlite`, `cache.sqlite-wal` and `cache.sqlite-shm` only, then syncs from the start of what the destination still holds. Lines no longer held show as gaps. |
| Writes | Only its own cache folder. Never the Log folder, never the server (it only reads), never the forge. |

Each run is bounded: at most 50 pages of 1000 lines, with a look-back of 1000 lines. A run that stops at the page limit says more is available.

The summary counts pages, rows stored, duplicates, edits, deletions, gaps and quarantined lines, and says whether the run completed, whether more is available, and any failure.

### What a sync notices

- **It re-reads a little.** The stored cursor trails what was read by up to the look-back span, so each run re-reads that span.
- **It stores before it moves on.** Every page is stored first; the cursor moves only after all pages are stored. A failed run keeps its stored pages and the old cursor. A sync never throws for a lost, edited or quarantined line.
- **Edits.** A known event that comes back with different content is recorded next to the row it kept.
- **Deletions.** A known event inside the re-read span that the source no longer returns is listed in the summary. Rows are never removed. The span is counted in source positions per stream, never in event times.
- **Gaps.** Any span the source says it cannot fill, or a source whose head is behind the cursor. A run that saw any gap reports no deletions.


## Rows and quarantine

| Line | Becomes |
| --- | --- |
| Valid, schema 1, 2 or 3 | A dataset row |
| Unknown schema version | A quarantine record |
| Invalid, or not JSON | A quarantine record |

A quarantine record holds the reason, the redacted raw text, the identity and schema version when they can be read, and a sha256 of the raw text. It produces no row.

```accordion
### Every column of a row
| Column | From | In schema |
| --- | --- | --- |
| `identity` | `meta.event_id`; for schema 1, `<run_id>:<seq>` | all |
| `schema`, `kind`, `event` | the line | all |
| `time` | `meta.ts` | all |
| `runId`, `seq` | `meta.run_id`, `meta.seq` | all |
| `workRef` | `meta.work.ref` | 3 |
| `actor` | `meta.actor_id` | 2, 3 |
| `cliVersion`, `doctrine`, `host`, `repo` | `meta.vinaya`, `meta.doctrine`, `meta.host`, `meta.repo` | all |
| `flowId`, `flowVersion` | `meta.flow.id`, `meta.flow.version` | 3 |
| `provenance` | `meta.provenance` | 2, 3 |
| `trust` | the low-trust rule below | — |
| `issue`, `pr`, `round`, `commit`, `role`, `objectivesVersion` | `subject.*` (`commit` comes from `subject.sha`) | all |

Next to the columns, each row also has `header` (the full `meta` and `subject`), `payload` (every field outside `meta`, `subject`, `kind` and `event`, as JSON), `contentHash` (a sha256 of the redacted line) and `origin` (the source and position).
```

Rules every row follows:

- **Any family works.** `kind` and `event` are plain text, and nothing on the read path depends on the family. New families and custom events need no code change.
- **Identity is the event's**, never its position in a file.
- **Unknown, never default.** A field the line's schema never had is `null` and listed in the row's `unknown` map with a reason. Nothing defaults to `0`, `''` or `false`. A measured value is either known with a value, or unknown with a reason.
- **Low trust.** A row written by a CLI older than `0.33.0`, or with an unreadable `meta.vinaya`, has `trust: 'low'`. Otherwise `trust` is the header's provenance. A schema 1 row at or above that version has unknown trust.

## The cache

Storing a row is idempotent by identity:

| Case | Effect |
| --- | --- |
| New identity | Inserted |
| Same identity, same content | A duplicate; nothing added |
| Same identity, different content | The first row is kept; one edit is recorded for each distinct content offered |

Quarantine records are keyed by the hash of their raw text. Gaps are stored once each. The dataset returns rows ordered by `time` then `identity`, gaps in the order they were recorded, and quarantined lines in the order they were first stored.

The cache lives in `<runtimeDir>/logs-cache/cache.sqlite`, never inside the repository or a Log folder.

```accordion
### How the cache file behaves
- It is a SQLite database, loaded only when needed.
- It carries its own schema version. A file from a newer version is refused; an older one is migrated in one transaction.
- A write transaction opens on the first stored row or gap and commits when the cursor is saved or the cache closes.
- It uses a busy timeout and write-ahead logging.
- It is indexed on `kind` and `event`, `runId`, `workRef` and `time`. `payload` reads back as parsed JSON.
- A missing or unwritable folder, or a file that is not SQLite, is refused and left untouched.
```

## Questions

A question reads the dataset and selects rows by comparing `kind` and `event` as text. A unit of work is `workRef`. Answers describe what happened; they never claim a cause.

| Key | Question |
| --- | --- |
| `q1` | Does a cheaper model finish? |
| `q2` | Are reviewers strict? |
| `q3` | What does a unit of work cost? |
| `q4` | Where does the time go? (develop, review, check, wait; summed and elapsed) |
| `q5` | Does the product catch anything? |
| `q6` | Which check catches most? |
| `q7` | Are checks deterministic? (always unknown, with the reason) |
| `q8` | Which findings recur? |
| `q9` | Is the instruction version the problem? |
| `q10` | What change size converges? (bands: at most 3, 4 to 10, 11 or more; at least 5 samples) |
| `confidence` | Does stated confidence predict the review outcome? (`number: null`) |

Every answer says how much it rests on: rows read, low-trust rows left out, rows with no known unit, rows used, gaps, quarantined lines and unknowns.

```callout-note
Some figures need human labels: a `false_rejection`, a `reversal` or an `incident`, for a unit of work, with a free-text note of where the label came from. Labels are passed in when you ask; they are never stored as rows. Without them, those figures read unknown with "no labels recorded".
```

Every question is tested end to end over sample lines, a real folder and a stand-in server, synced into real SQLite caches, including rebuilds.

## Configuration

| Key | Effect |
| --- | --- |
| `logs.folder` or `logs.url` | Which source `vinaya sync` reads |
| `logs.readHeaders` | The server's read credential (`${VAR}` filled from the environment) |
| `runtimeDir` | Parent of `logs-cache/` |

## What's next

```cards
- [Log](/docs/features/log) The record Telemetry reads
- [Studio](/docs/features/studio) The readers of the record
- [Self-improvement](/docs/features/self-improvement) How runs become proposals
- [Events](/docs/process/events) What each row's `kind` and `event` mean
- [Redaction and trust](/docs/features/log/redaction-and-trust) Where trust and provenance come from
```
