# Docs writing guide

How every page in `src/content/docs-tree/` is written. The model page is `1.2.4-gates.md` (live at `/docs/process/gates`). Read it before rewriting anything.

## Goal

Pages read like good product docs (CodeRabbit-grade): written for the person using Vinaya, task-first, scannable, short paragraphs. Not a spec dump.

## Hard rules

1. **Keep every fact, invent none.** Rewrite the wording and structure; never add a behaviour, command, flag, number, field or default that the current file does not state. If unsure, leave it out.
2. **No internal references.** Remove source-code paths, "Sources" sections, `Source` table rows, ADR numbers, spec section numbers, Linear tech-spec names and "the draft". A config file name (`vinaya.config.json`) or a command a user runs stays.
3. **No status prose.** Do not write "planned, not built" as a paragraph or table column. Status comes from the page badge (`src/content/docs-status.ts`, not edited by you). Where only part of a page is planned, say so once in a `callout-note`.
4. **Header lines stay.** Line 1 `# <number> · <Name> — definition`, then `Summary:` and `Parent:`. You may improve the Summary (one or two sentences, for a reader). You may add `Badges:` with 2–5 short descriptive tags separated by ` · ` (never status words).
5. **Links use docs routes** from `src/app/(site)/docs/_lib/portal-docs.ts` (`DOCS_NAV`). Only link to routes that exist there or to `/vinaya-process/demo/<complex|medium|simple|hot>`.
6. **Plain English.** Short sentences. Second person for how-to steps. Define a term on first use or link the Glossary (`/docs/process/glossary`).

## Sections

| Page kind | Sections, in order (omit one only if it has nothing true to say) |
| --- | --- |
| Part or feature page (has children) | About … · How it works · (the main subject) · Configuration · What gets logged · Troubleshooting · What's next |
| Child page | About … · How it works · (details, examples) · Configuration · What gets logged · What's next |
| Reference page (Events, checks) | Short intro · grouped entries (tables or one entry per item) · What's next |

"What's next" is a `cards` block with 2–4 links. A parent page shows its children as a `cards` block too (otherwise the page adds "In this section" by itself).

## Blocks

Use them where they help; do not decorate.

````text
```callout-note        neutral aside        (also callout-tip, callout-warning)
Text in Markdown.
```

```steps              numbered flow; each step is a ### heading then text
### First step
Text.
```

````tabs             alternatives (CLI vs config, add vs replace); four backticks
=== Label            when a tab contains a code block
Text.
```bash
command
```
````

```accordion          optional depth: troubleshooting, long lists, "when to use"
### Question
Answer.
```

```cards              links; one per line: - [Title](/route) one-line description
- [Title](/docs/...) Description
```

```json:vinaya.config.json     code with a file name; plain ```bash for commands
```
````

Tables are fine for reference data (keys, events, checks). For a check, keep a compact table per check: Refuses · Runs · Reads · Outcomes · Implements · Settings (no Source row).

## Done when

- The page renders at its route with no errors (`curl -s -o /dev/null -w '%{http_code}' http://localhost:3010<route>` gives 200).
- Every link in it resolves (200).
- No code paths, no "Sources", no status prose, no invented facts.
