---
"@attalabs/aeg-core": minor
---

Adds `## Documentation` as a fifth Issue-native judgment section, alongside `## Surface`/`## Parts`/`## Test plan`/`## Stop conditions`: a bullet list naming each normative source (a doc URL, an in-repo spec) against the mechanism it governs, or the explicit `None` sentinel. `parseIssueDocumentation` is the new parser (`IssueDocumentation`/`IssueDocumentationSource` are the new types); `checkIssueBriefSections` folds its presence into the same gate, on its own later cutover (`DOCUMENTATION_SINCE_ISSUE`, #626) so no existing Issue is invalidated. `renderBrief` copies the section verbatim into the rendered brief, right after Objectives.
