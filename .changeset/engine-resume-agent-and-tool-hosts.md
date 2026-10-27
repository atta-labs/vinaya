---
'@attalabs/vinaya': patch
---

An Engine checkpoint resumes only on the agent it started with: a resume on another agent, or of a checkpoint that records no agent, is refused before any step runs, and the refusal names the fresh start. Each role's dev-tools host is replaced at its next dispatch boundary when its socket file was removed, on the same path and before the dispatch's capability is minted; a role whose dispatches lose the socket twice in a row stops the run with that reason.
