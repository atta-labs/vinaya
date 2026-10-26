---
'@attalabs/vinaya': patch
---

A Developer launch that ended before binding a vendor session — stopped by a signal, or an agent that exited on a sign-in failure — no longer blocks its task: the next run dispatches a fresh Developer session and records the prior attempt's outcome and failure reason in the driver log. A prior launch still running is still never raced, and a launch that bound a session still resumes that exact session.
