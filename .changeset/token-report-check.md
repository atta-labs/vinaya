---
"@attalabs/vinaya": minor
---

New core check: `token-report` (ring 1, `requiresOpenPr`). Fails a pull request whose "Token report" section is missing, or carries a blank/non-numeric Tokens in/out cell, whenever the host running the check is metering-capable (`resolveMeteringCapability`, `@attalabs/aeg-core`) — an incapable host, or a run with no PR body yet, passes silently. Proves presence and shape only, never that the reported figures are true; the `Cost` cell is exempt in every case. Never treats a probe that itself fails to run as a clean incapable verdict — that distinction surfaces as `status: 'error'`, not a silent pass.
