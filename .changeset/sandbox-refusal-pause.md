---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

A dispatch refused because the agent's sandbox cannot run a command on the host now pauses once with `sandbox_refused`, addressed to the Operator. Its escalation packet carries the probe's own error and the host remedy. The loop no longer files it as an infrastructure pause: it spends no retry, and the watching driver never restarts it, so a host that cannot change by itself is no longer retried until the retry budget runs out. Once the host is repaired, `vinaya task run` continues the task with no ruling and records the pause's resolution once. Transient dispatch failures keep their current infrastructure pause and bounded retry.
