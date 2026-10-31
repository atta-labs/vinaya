# processes/vinaya/evals

Evaluations of the Vinaya process. Belongs to the "Any Process, One Harness" project.

## structure-proof

The frozen halt, inspect, resume and cancel proof every structural move of this process reruns, on the Engine runner
with both agents.

- `proof-list.json` names each proof test by its file and full name, describe block included, one entry per agent.
  A move that relocates or renames a listed test updates its entry there; the tests themselves stay where they are.
- `run-proof.ts` runs the listed tests and fails when any of them fails, is skipped, or no longer exists under its
  listed name. `--packed` adds the packed leg: the shipped-command lifecycle against a pack of this working tree.
  Run it from this process folder: `bun evals/structure-proof/run-proof.ts`.
- `pre-move-checkpoint.test.ts` resumes a checkpoint the Engine runtime wrote before any move, committed as rows in
  `fixtures/pre-move-checkpoint.json` with the command and default-branch commit that wrote it.
- `drain-check.ts` lists every local run a path move could cross, on the host it runs on, and exits non-zero while
  any is live or resumable.
- `live-proof.md` is the Principal's live procedure, on Claude Code and on Codex against the sandbox repository.
