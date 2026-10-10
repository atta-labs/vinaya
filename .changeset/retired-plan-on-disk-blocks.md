---
'@attalabs/aeg-core': minor
'@attalabs/vinaya': minor
---

The `retired-vocabulary` check now blocks: a finding prints at `error` severity and exits `1`, failing `check --all`. It also recognises the retired plan-on-disk layout — the tranche topology file, the directory that held it, and the per-project state directory — exempting only the tranche model, whose retirement section records them. The front door, the role router, the state machine and the model documents now describe a plan as a Milestone plus labeled Issues, name the Planner's two acts and the Operator's task tools, and route each agent to its role through the directory it reads. `doctrine-portability` treats the shared agent-skills and second-host command directories as adopter-owned.
