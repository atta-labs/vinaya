# Rewriting old markers on open Issues and pull requests

`rewrite-open-threads.ts` is a one-time repository-maintenance program. It
rewrites the retired marker spellings on every **open** Issue and **open** pull
request of one repository — their bodies and their conversation comments — to
the current spelling. It is run from source with `bun`, like the release
scripts, and is not shipped as a packaged program.

## What it rewrites

The old-to-new mapping is imported from the legacy-spelling module,
`harness/processes/vinaya-strict/tools/legacy-markers.ts` — the same module
every reader takes its accepted spellings from. This program restates no
spelling of its own, so it and the readers can never disagree. Four marker
families move:

- body regions — the `<!-- <prefix>:<FIELD>:START -->` / `:END -->` pairs;
- the provenance heading — a line that starts with the old heading;
- documentation anchors — the claim, quotes-file and vendor-example anchors in
  their `<!-- … -->` form;
- forge comment markers — `<!-- <prefix>:<family>… -->` for every comment-marker
  family the module names (frozen brief, round and stop records, published and
  paused records, rulings, objectives versions, deferred-findings tracker).

Only the old spelling itself is replaced: every other byte of the body or
comment stays as it was.

**Code is left unchanged.** A marker quoted inside fenced, indented or inline
code is an example, not a marker — every reader masks code before matching —
so the program masks code the same way and never rewrites inside it.

**Closed history keeps its text.** Closed Issues and closed or merged pull
requests are never listed, never read for rewriting and never changed. Review
comments on diff lines carry no marker and are not read.

## How it talks to the forge

Only `gh api` over REST, never the GraphQL-backed `gh issue` / `gh pr`
subcommands:

- `GET /repos/{owner}/{repo}/issues?state=open` with `--paginate` lists open
  Issues and pull requests (a pull request carries the `pull_request` key);
- `GET /repos/{owner}/{repo}/issues/{n}/comments` with `--paginate` lists a
  thread's conversation comments;
- `PATCH /repos/{owner}/{repo}/issues/{n}` edits a body, and
  `PATCH /repos/{owner}/{repo}/issues/comments/{id}` edits a comment in place,
  so its author, link and order stay. Nothing is re-posted.

## When to run it

Once, after every reader accepts the new spelling — that is, after the tasks
that moved the old spellings into the legacy-spelling module have merged.
Before then a rewritten marker could be invisible to a reader still on the old
spelling.

## How to run it

From the repository root, with a `gh` login that may edit Issues, pull
requests and their comments:

```
bun scripts/marker-rewrite/rewrite-open-threads.ts --dry-run
bun scripts/marker-rewrite/rewrite-open-threads.ts
bun scripts/marker-rewrite/rewrite-open-threads.ts --dry-run
```

1. The first dry run changes nothing. Per thread it prints the body and each
   comment it would rewrite, with how many markers in each. Read the list.
2. The real run makes those edits and prints what it rewrote.
3. The last dry run should print `nothing to rewrite on open Issues and pull
   requests`.

`--repo owner/name` points it at another repository; without it the program
reads the `origin` remote.

## Exit codes

- `0` — every pending rewrite was made (with `--dry-run`, listed).
- `1` — at least one body or comment the token may not edit was skipped; each
  is printed as `skipped <link>: …`. Edit those by hand or rerun with a token
  that may.
- `2` — the run stopped: the REST rate limit answered (the program stops and
  reports rather than retrying), a read failed, or the arguments were wrong.
  Rerun after the limit resets; edits already made are not repeated.
