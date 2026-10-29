#!/bin/sh
# A stand-in for the generated pre-push hook's progress steps, around a fake
# test run: the same helper calls, the same capture, copier, bounded drain and
# removal, in the same order. The helper and the fake test run come from the
# test's environment:
#   VINAYA_FAKE_PROGRESS_HELPER  the helper's entrypoint (run with bun)
#   VINAYA_FAKE_TEST_SCRIPT      a shell script printing Bun-shaped output
#   VINAYA_FAKE_SELECTED         how many files the fake selection holds
#   VINAYA_FAKE_RECORD           where the failure record copy is written
#   VINAYA_FAKE_RECEIPT          where the receipt (the capture's size) is written
P="bun $VINAYA_FAKE_PROGRESS_HELPER"
VINAYA_PROGRESS="$($P dir 2>/dev/null)" || VINAYA_PROGRESS=""
cat > /dev/null
VINAYA_STEP_STARTED=$(date +%s)
if true; then VINAYA_STEP=pass; else VINAYA_STEP=fail; fi
[ -z "$VINAYA_PROGRESS" ] || $P check lint "$VINAYA_STEP" "$VINAYA_STEP_STARTED" >/dev/null 2>&1 || true
[ "$VINAYA_STEP" = pass ] || exit 1
echo "fake hook: lint passed"
VINAYA_STEP_STARTED=$(date +%s)
if true; then VINAYA_STEP=pass; else VINAYA_STEP=fail; fi
[ -z "$VINAYA_PROGRESS" ] || $P check typecheck "$VINAYA_STEP" "$VINAYA_STEP_STARTED" >/dev/null 2>&1 || true
VINAYA_TEST_LOG="$(mktemp "${TMPDIR:-/tmp}/fake-hook-capture.XXXXXX")"
VINAYA_PROGRESS_COPIER=""
if [ -n "$VINAYA_PROGRESS" ]; then
  $P follow "$VINAYA_TEST_LOG" "tests-$$" "$VINAYA_FAKE_SELECTED" </dev/null >/dev/null 2>&1 &
  VINAYA_PROGRESS_COPIER=$!
fi
sh "$VINAYA_FAKE_TEST_SCRIPT" > "$VINAYA_TEST_LOG" 2>&1
VINAYA_TEST_STATUS=$?
if [ -n "$VINAYA_PROGRESS_COPIER" ]; then
  kill "$VINAYA_PROGRESS_COPIER" 2>/dev/null
  wait "$VINAYA_PROGRESS_COPIER" 2>/dev/null
  $P finish "$VINAYA_TEST_LOG" "tests-$$" "$VINAYA_FAKE_SELECTED" </dev/null >/dev/null 2>&1 || true
fi
cat "$VINAYA_TEST_LOG"
if [ "$VINAYA_TEST_STATUS" -ne 0 ]; then
  cp "$VINAYA_TEST_LOG" "$VINAYA_FAKE_RECORD"
  rm -f "$VINAYA_TEST_LOG"
  echo "fake hook: refused"
  exit 1
fi
wc -c < "$VINAYA_TEST_LOG" | tr -d ' ' > "$VINAYA_FAKE_RECEIPT"
rm -f "$VINAYA_TEST_LOG"
echo "fake hook: all green"
