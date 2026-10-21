# harness/dev-process/logging

How a process records what it did. Belongs to the "Any Process, One Harness" project.

`translate.ts` turns a run of a process's Flow into Log events. The Engine reports each node starting, completing or failing; the actions it runs record what they returned; a leg of the run ends in an outcome. The translator hands each of those to the producers the process supplies (`legStarted`, `nodeStarted`, `nodeCompleted`, `nodeFailed`, `runEnded`) and passes the events they return, in order, to an injected emit function. It names no process: which events exist and what they carry is the producers' business, and an event leaves the translator without its envelope, which the caller completes and writes.

Wiring, by the code that runs the process:

- `createLogTranslator(producers, emit)` builds it; `translator.onEvent` is the run's `onEvent`.
- `recordingActions(actions, translator)` wraps the action registry so each step's result is recorded before the node completes. An action that throws can keep the output it produced by attaching `stdout` to its error.
- `translator.beginLeg({ resumed })` before a leg and `translator.endLeg(outcome, { cancelled })` after it.

No agent step is given the emit function or a tool that writes to the Log; the events come from deterministic code reading the run.
