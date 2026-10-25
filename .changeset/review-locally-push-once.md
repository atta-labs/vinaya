---
'@attalabs/vinaya': minor
'@attalabs/aeg-core': minor
---

Review locally, push once. A refused push re-runs only the tests that failed plus the tests the fix affects. The pre-push hook gains a storage mode (cheap checks only, no tests, allowed only while no pull request is open) and a ready mode (the selected tests, measured against the default branch). A process may declare more than one flow, and `vinaya task run --flow v2` chooses the new flow on the Atta Engine runner; today's flow stays the default. The Log gains `storage_push`, `local_checks_run`, `ready_push`, `failed_tests_rerun`, `pr_opened`, `ci_result_read` and `phase_time`, and records which flow ran.
