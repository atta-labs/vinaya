---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

A pull-request body no longer carries a token table. `vinaya pr report --write` and `--push` write the `AEG:EVIDENCE` block and nothing else, `vinaya pr create` splices no row into the body it opens, and the registered `token-report` check — which refused a task pull request whose body carried no such row — is retired: a body without one now passes every check, and `vinaya check --all` and the generated CI workflows list no such name.

Token use is recorded as the Vinaya log's own `usage` event instead, one per dispatched attempt, collected from the agent host by the dispatch path with no step of the role's own in between. The collection behind those events is unchanged, as is `vinaya tokens`.

A body opened before this change keeps its table byte for byte: nothing rewrites it, nothing removes it, and the `--push` self-verification now treats it as prose the report does not own — a change inside it reads as real drift. The `--phase`, `--role`, `--model` and `--transcript` flags on `vinaya pr report` went with the row they shaped; `vinaya tokens` still accepts its own.

`ANCHOR_FIELDS` drops `TOKENS`, since the one writer of that anchor is gone and no gate reads it.
