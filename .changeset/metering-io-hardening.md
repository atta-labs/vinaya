---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Harden the transcript-pointer read every `resolveMeteringCapability` caller shares — `vinaya tokens`, `doctor`, and `quickstart` no longer follow a symlink, hang on a FIFO, or trust a file owned by another local user at the predictable `$TMPDIR` pointer path, mirroring the write-side CWE-59 hardening already shipped for this path. Also neutralizes a `|` in an attacker-controlled `model` field in the `Tokens: …` line output, matching the escaping the markdown table row renderer already applied.
