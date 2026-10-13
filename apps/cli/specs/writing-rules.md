# Writing rules

A repository's writing rules are one rule set, run by two checks. The set
ships with defaults, and a repository configures it in `vinaya.config.json`
under `proseGates.rules`: it can switch a default off, retune where a default
reads and how hard it fails, and add rules of its own. The configuration is
read every time a check runs, so an edit takes effect on the next run with no
reinstall.

## Groups and the checks that run them

Every rule belongs to exactly one group, and each group has exactly one check:

| Group | Check | Scopes |
| --- | --- | --- |
| reader-resolvable | `reader-resolvable-prose` | `ships`, `reader-facing`, `product`, `spec`, `source-comment` |
| retired | `retired-vocabulary` | `repository` |

A rule's scopes decide its group. Each check runs only its own group, where
and when it always ran, so no finding is ever printed by both. Replacing
either check with a no-op (`vinaya new noop-check`) turns off exactly its
group and nothing else. `vinaya check --plan` prints, for each of the two
checks, the rules it runs and their scopes, or that the check was replaced and
its group does not run.

The published pass — the documentation gate's check that a published page
carries no token a stranger cannot resolve — keeps its own rules. Its one
setting is `proseGates.published.allow`, described below; `proseGates.rules`
does not configure it.

## Scopes

| Scope | What it reads |
| --- | --- |
| `ships` | Every markdown page under the doctrine root, except its archive. |
| `reader-facing` | The reader-facing pages, when `proseGates.readerFacingPrefix` and `proseGates.readerFacingSuffix` are both set. |
| `product` | The product class: `proseGates.productPaths`, or the shipped default set when unset. |
| `spec` | The spec class: a root `SPEC.md`, a root `CONTEXT.md`, every `.md` under `docs/adr/`, every `apps/<app>/specs/**/*.md`, and `proseGates.specPaths`. |
| `source-comment` | Comments in the `.ts` files under `proseGates.sourceComments.globs`. |
| `repository` | Every swept file under the doctrine root, line by line. |

Markdown code, fenced or inline, is never read as prose in the `ships`,
`reader-facing`, `product` and `spec` scopes. Comments are read as prose in
`product` and `source-comment`, and are not read in `ships`, `reader-facing`
and `spec`.

## Rule fields

A custom rule, under `proseGates.rules.custom`, takes:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | The rule's own name. A default rule's id is refused. |
| `pattern` | one of the two | A regular expression every scope of the rule uses. |
| `patterns` | one of the two | A map from scope to regular expression; it wins over `pattern` for the scopes it names. |
| `flags` | no | Regular-expression flags: only `i` and `u`. |
| `means` | yes | The message a finding prints. |
| `scopes` | yes | One or more scopes, all of one group. |
| `severity` | no | `"error"`, `"warning"`, or a map from scope to one of them. |
| `exempt` | no | Repository-relative files or folders this rule does not read. |

A finding from a custom rule prints the rule's id, the file and line, the
matched text and the rule's message:

```
SPEC.md:3: acme/leverage: say "use" instead ("Leverage")
```

With no `severity`, a custom rule warns, except in two scopes: in
`repository` it blocks, like every default the retired check runs, and in
`source-comment` it follows `proseGates.sourceComments.severity`.

## Defaults

The defaults live in the shared rule module and ship unchanged. The
reader-resolvable group carries a forge number (`forge-number`), an internal
tranche slug (`tranche-slug`), a task number (`task-number`, spec only), the
two source-comment citations (`source-comment-tranche-slug`,
`source-comment-forge-number`), and two built-in rules that compute their own
matches: the archived batch names (`legacy-batch-name`) and an undefined coined
term (`coined-term`). The retired group carries the retired-mechanism patterns,
`retired-vocabulary-1` onward. `vinaya check --plan` lists every id.

Under `proseGates.rules.defaults`, a default id maps to:

- `"off"` — the rule does not run.
- an object with any of:
  - `scopes` — replaces where the rule reads. A pattern rule may take any scope
    of its own group; a built-in rule may only narrow its shipped scopes.
  - `severity` — a severity, or a map from scope to severity, merged over the
    rule's shipped severities.
  - `exempt` — paths this rule does not read, on top of the exemptions it ships
    with.

A default's pattern and message are fixed. `proseGates.sourceComments.severity`
stays the default severity of the `source-comment` scope; a rule's own
`severity` for that scope overrides it.

`proseGates.rules.exempt` lists paths no rule reads, in either check.

## Product paths and published mechanics

`proseGates.productPaths` replaces the product class's file set. Unset, the
class reads the shipped default set: the CLI source, the workflows folder,
`.vinaya`, and the two package READMEs.

`proseGates.published.allow` lists literal text the published pass masks out
before any rule reads it — the protocol mechanics a reader is meant to learn,
such as the task branch convention. Unset, the shipped list applies; set, it
replaces that list.

With none of `proseGates.rules`, `proseGates.productPaths` and
`proseGates.published.allow` set, every finding is identical to the findings
before these keys existed.

## Validation

The configuration loader validates every key above when it loads, and each
refusal names the key it refuses. A refused configuration stops the check: a
malformed rule never falls back to no rule. The loader refuses:

- an unknown default id;
- a custom id equal to a default id, or to an earlier custom rule's id;
- a default override naming `pattern`, `patterns`, `flags` or `means`;
- a pattern that does not compile with the rule's flags;
- a custom rule with no `means`, or with no scope;
- an unknown scope, severity or flag;
- a custom rule whose scopes span both groups;
- a `patterns` map naming a scope the rule does not cover, or leaving one of
  its scopes with no pattern when there is no `pattern`;
- a built-in default moved to a scope it does not ship with;
- an exempt path or product path outside the repository — absolute, or
  climbing through `..`;
- a configured pattern longer than 200 characters;
- a configured pattern with star height above one, as the `safe-regex2`
  library decides it. Only star height decides: the library's cap on the
  number of repetitions is lifted, so a long but linear pattern passes.

The last two limits apply only to patterns a repository configures, never to
the shipped defaults. Three shipped patterns fail the star-height test — the
source-comment tranche slug and the published pass's batch-name and file
patterns — and keep running as shipped. A repository that copies one of them
into a custom rule is refused, and the refusal says why.
