---
"@attalabs/vinaya": patch
---

Three surfaces where a verification tool could return a confident answer that was wrong.

- `vinaya review post` refuses unknown flags. A misspelled flag was silently dropped, so
  `--print-only` — which does not exist — posted a real verdict.
- A new gate refuses any tracked file that is binary to git. A source file invisible to
  `git grep` is a hole under every text-based verification in the repo.
- A new gate reports a name declared in more than one non-test source file of
  `@attalabs/aeg-core`. Its reach is that package, not the repo.
