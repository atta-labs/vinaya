---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

Creating or editing a task Issue is now refused when its body links to something outside `## Documentation` that the section does not also list, because every link a task gives the Developer is required reading; the repository's own Issue and pull-request links are exempt. Every link in the body, not only the Documentation ones, must answer an unauthenticated fetch with a success status. The Planner reference states how to reference rather than copy, and the Developer reference states that an unopenable reference stops the Developer with a `missing_access` blocked result.
