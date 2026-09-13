---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

`checkDispatchReadiness` and `checkD1`/the other coherence checks now tag every blocker/failure they produce with a machine-readable class (`DispatchBlockerClass` on `DispatchResult.blockerDetails`, `CoherenceFailureCode` on `CheckFailure.code`) beside the existing human message string. `check-dispatch-readiness`'s and `check-coherence`'s `recoveryPromptFor` now switch on that class/code exhaustively (a `never`-typed default arm), so a new blocker/failure class that ships with no matching `case` fails typecheck instead of silently falling through to generic or wrong advice. `checkD1` now distinguishes `d1-self-dependency` (escalate — a self-dependency can never be closed) from `dispatched-on-unmet-deps` (an ordinary unmet dependency — close it), which previously shared the single `D1` check code and could route a self-dependency to "close the dependency."
