---
"@attalabs/aeg-forge-state": patch
---

`parseRationaleDeps` now reads dependency edges from a field's **labelled span only**. Previously it scanned every inline-code span in an Issue body's "Dependency rationale" section left-to-right, attributing each unlabelled span to whichever field label preceded it, however far back — so any id-shaped span in that paragraph became a declared edge. Two real bodies show the cost: one whose fields both read `—` was parsed as conflicting with the three task ids its prose merely named, and one whose trailing `` `1` `` (ordinary prose naming a task) was read as a dependency on task `1`, which on that tranche's own task `1` is a self-dependency.

The grammar is now: `` `Depends-on: 1, 2` `` / `` `Conflicts-with: <slug> 25` `` — one labelled, comma-separated span per field, which is the topology file's own cell convention and exactly what `amendRationaleDeps` writes. Every other span in the section is prose and contributes nothing.

**Behaviour change for adopters.** The previously-tolerated multi-span convention — a labelled first span followed by bare continuation spans holding further values — is no longer read. An Issue body written that way now declares only its labelled span's ids; state the rest in that span, comma-separated. `vinaya issue amend-deps` is the sanctioned way to rewrite one: it already emits the single labelled comma-joined form, so its output round-trips through the narrowed reader unchanged. Slug inheritance (a bare id after a slug-qualified one adopting its qualifier, one step) is unchanged but now applies within a single labelled span. The four exported grammar constants (`SECTION_HEADER`, `NEXT_HEADER`, `FIELD_LABEL`, `ID_TOKEN`) and `amendRationaleDeps` itself are untouched.
