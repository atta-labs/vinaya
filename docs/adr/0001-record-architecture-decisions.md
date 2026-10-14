# 0001. Record architecture decisions

**Status:** Accepted

**Date:** 2026-10-14

## Context

Significant decisions shape a repository long after the change that introduced them has merged. Pull requests preserve change-specific reasoning, but a new contributor also needs a small, discoverable account of the forces, alternatives and consequences behind the architecture that remains.

Michael Nygard's 2011 article, [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions), proposes short records that capture one decision's context, decision, status and consequences. [AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html) treats accepted records as immutable and replaces a reversed choice through supersession. [Google Cloud's guidance](https://docs.cloud.google.com/architecture/architecture-decision-records) recommends records for decisions with material architectural or cross-cutting consequences and for choices among meaningful alternatives.

## Decision

We will keep one short, numbered file for each architecturally significant decision. Records begin as Proposed and become Accepted when the decision is agreed. An Accepted record is immutable except that it may be marked Superseded and name the record that replaces it.

The repository will maintain an index listing every record by number, title and status. Specifications, doctrine and code will state their rules directly instead of citing a record.

## Considered options

- Keep reasoning only in pull requests. This preserves the history of each change but makes enduring architectural choices difficult to discover as a set.
- Maintain a single architecture document. This is easy to find, but unrelated decisions become coupled and the document is difficult to keep current.
- Keep short, numbered decision records. This preserves each decision's context independently, makes supersession explicit and keeps the collection easy to scan.

## Consequences

Contributors can find the reasons for enduring architectural choices without reconstructing them from change history. Each significant decision adds a small documentation obligation, and the index must remain synchronized with the folder. Reversals add a new record rather than rewriting the accepted history.

## Where it is applied

The records and their index live in `docs/adr`. The `decisionRecords.path` setting in `vinaya.config.json` enables the repository's record checks and creation command. Section 6, "Recording why," in `aeg-root/state-machine.md` defines how AEG roles use the records.
