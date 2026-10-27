# Ready-gate probe (temporary)

Temporary fixture that verifies the approved-head ready-gate repair. It is not merged.

- Phase 1: `READY_PROBE_FAILS` is `true`, so the test passes in ordinary runs and fails when `VINAYA_PUSH_MODE=ready`. This failure is deliberate.
- Phase 2: after the ready gate names the failure, the Developer sets `READY_PROBE_FAILS` to `false`, and the test passes in ready mode.
