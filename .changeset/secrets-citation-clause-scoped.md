---
'@attalabs/vinaya': patch
---

A security reviewer's `SECRETS: none found` line is no longer rejected when it cites the passing `atta-labs/secret-scan` check in a clean clause but trails that citation with honest explanatory prose. Before, `noneFoundClaimCitesScanCheck` weighed the pass/fail words across the whole `SECRETS:` value, so a single physical line of several sentences — "… atta-labs/secret-scan passed. I did not run a scanner myself; no live credential, not a real secret." — tripped the negation guard on the unrelated "not"/"no" and failed the report parse, pausing the loop `infrastructure` on a report that was in fact correctly backed.

The pass/fail test now runs per clause (split on newline, period, semicolon and em-dash — never the hyphen inside the check name), so each occurrence of the check is weighed only against the words beside it, which is what "a clause naming the check beside a failing conclusion backs nothing" always meant. A negation in the same clause as the check still rejects, and the loop and `vinaya review post` apply the one rule unchanged.
