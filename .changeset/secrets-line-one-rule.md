---
'@attalabs/vinaya': patch
---

The security doctrine, the review loop and `vinaya review post` now state one rule for the `SECRETS:` line: the secret scan is the required `atta-labs/secret-scan` CI check, and a security pass cites its result instead of running a scanner or pasting its output.

The doctrine already told a reviewer not to run the scanner, yet a later paragraph still required "the secret scanner's pasted output" above `SECRETS:`; the loop's verdicts carried no secrets evidence at all, while `review post` demanded an evidence file holding scanner output. A dispatched security pass is now told to read the check's result and write `SECRETS: none found — atta-labs/secret-scan passed`, and a report whose `none found` cites no such check, or cites it beside a failing, missing, skipped or pending conclusion, is refused. `vinaya review post --secrets "none found"` still needs `--secrets-evidence-file`, now holding the check's result, and refuses a file that does not show `atta-labs/secret-scan` passing — its refusal text states the rule. A "none found" with no evidence is refused on both paths.
