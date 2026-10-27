# Ready-gate probe

Status: Temporary verification fixture.

This fixture exercises the review loop's selected ready-gate failure and repair
without changing production behavior.

In the first phase, the exported `readyGateProbe` constant is `true`. The ordinary
Bun test passes, while `VINAYA_PUSH_MODE=ready` requires the constant to be `false`
and deliberately fails. Publish this phase for review without repairing it.

After the controller returns the failing test to the Developer, the second phase
changes only the constant to `false`. The ready-mode test must then pass. Do not
skip the test, bypass hooks, or merge this temporary probe PR.
