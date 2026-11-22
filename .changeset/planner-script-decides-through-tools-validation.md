---
"@attalabs/vinaya": patch
---

The Planner's standalone Issue script refuses what the Planner tools refuse: its validate-only run, create, edit and dependency-edge amendment decide through the validation the Planner tools call, print each finding with its check name, and write nothing when one blocks. A task Issue that leaves an importer of a pinned file undecided is now refused by the script, and a test proves a task whose Issue lists an in-repository Documentation source the checkout lacks does not start.
