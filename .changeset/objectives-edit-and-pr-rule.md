---
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": minor
---

`vinaya issue objectives edit <n> --add "<sentence>" | --drop O<k> | --replace O<k> "<sentence>" --reason "<text>"` rewrites a task Issue's `## Objectives` section through the same validated `issue edit` write path (`writeValidatedIssueEdit`, extracted from `apps/cli/src/commands/issue.ts` into `apps/cli/src/lib/forge-write.ts`), then posts one comment marked `<!-- aeg:objectives:v<k> -->` carrying the previous list, the new list, the reason, and the new version hash. `--drop` never renumbers the survivors; a drop that leaves the list non-contiguous from `O1` is refused with the parser's own message.

`vinaya pr rule <pr> --file <ruling.md>` posts a Principal ruling as its own marked comment (`<!-- aeg:principal:ruling:<pr>-<k> -->`), refusing a file that carries verdict grammar or reads as an escalation so a ruling is never mistaken for a code-review or security verdict.
