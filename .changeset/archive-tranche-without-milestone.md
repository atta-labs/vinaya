---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

A finished tranche is now archived even when its last task is closed by hand or its Issues carry no Milestone, so the Planner's gate no longer stops on a tranche that never archived itself.

The generated `vinaya-archivist.yml` gains an `issue-closed` job: when an Issue labeled `vinaya/tranche:<slug>` is closed without a merge (dropped, replaced or closed by hand), it runs `vinaya archive tranche <slug> --yes`, reading the slug from the Issue's own label and never from a branch name. The job runs on the default token with `issues: write` as its only write permission and never runs pull-request code; the daily scheduled run also calls the new `vinaya archive tranches --yes`.

`vinaya archive tranche <slug>` on a finished tranche none of whose task Issues carry a Milestone used to print that there was no Milestone to write into and change nothing, so the tranche could never read as archived. It now creates a Milestone titled with the slug (or reuses one already so titled), attaches the tranche's closed task Issues to it, records the retrospective and closes it. An Issue already on a Milestone is never moved, and a tranche with some Issues on a Milestone keeps its existing path. `vinaya archive tranches` archives every tranche label with no open task Issue and no closed Milestone carrying its retrospective. Running either command a second time on an archived tranche changes nothing and says it is already archived.

Run `vinaya upgrade` to regenerate the workflow.
