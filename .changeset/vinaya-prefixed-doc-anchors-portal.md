---
'@vinaya/portal': patch
---

Documentation claim, quotes-file and vendor-example anchors are now written with the `VINAYA:` prefix, in docs and in source comments. The doc-claims, quoted-command, doctrine-portability and doctrine-no-procedures checks still accept the earlier spelling of each, taken from the one legacy-spelling module, so an adopter's documentation written before this change keeps its anchors enforced. The kernel's architecture ratchet reads the new spelling only. The process version is raised because the launched roles' doctrine files carry anchors.
