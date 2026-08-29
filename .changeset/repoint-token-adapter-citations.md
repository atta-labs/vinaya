---
"@attalabs/vinaya": patch
---

`aeg-root/roles/developer.md` and `aeg-root/tranche-model.md` cited the token
collection adapter by its repo-relative source path
(`packages/aeg-core/bin/report-tokens.ts`), which does not resolve in an
adopter checkout. The three citations now name `vinaya tokens`, the shipped
front door, and drop the "on this repo's toolchain" framing, which read from
this repo's own vantage as a claim about the adopter's.
