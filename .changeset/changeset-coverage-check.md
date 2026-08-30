---
"@attalabs/vinaya": minor
---

New core check: `changeset-coverage` (report-only). For each member of `.changeset/config.json`'s `fixed` group, a changed path counts as SHIPPED iff it falls under that member's own `package.json` `files` allowlist, read live — never hardcoded. A diff that hits a shipped path with no `.changeset/*.md` entry in the same diff prints a `warning` finding naming the shipped paths; the check's own exit code always stays `0`, so installing it cannot newly redden an existing repo's CI. The Changesets-release branch itself is exempt by construction.

`aeg-root/roles/developer.md`'s commit conventions gain the matching obligation: a published-package change carries its changeset in the same PR.
