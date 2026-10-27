# Temporary ready-gate probe

Status: Temporary verification fixture.

This fixture exercises the approved-head ready gate without changing production behavior.
In the first phase, the exported `readyGateProbe` constant is `true`: ordinary Bun test
invocations pass, while `VINAYA_PUSH_MODE=ready` deliberately requires `false` and fails.
The initial publication preserves this failure so the controller can return the named
test to the Developer after review.

In the repair phase, change the constant to `false` without skipping the test or
changing hooks. The ready-mode assertion then passes. Do not merge this probe PR.
