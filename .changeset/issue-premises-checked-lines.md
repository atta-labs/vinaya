---
'@attalabs/aeg-core': minor
'@attalabs/vinaya': minor
---

A task Issue may now carry a `## Premises` section: one line per fact about the code the plan rests on, written `` `<path>` contains `<text>` ``. `vinaya issue create` and `vinaya issue edit` evaluate every premise against the checkout and refuse the Issue naming the premise the file does not hold, and the dispatch render evaluates every premise again against the default branch and refuses preparation the same way. The rendered brief lists them under their own `## Premises` heading, so a Developer reads them as checked facts rather than as more of the Boundary's prose.

A premise prefixed `after #<n>:` states a fact a task that has not merged yet will make true. It is accepted when the Issue is cut only if the Issue also declares `Depends-on` on that number, and is not evaluated then — by either the content gate or the pre-write brief render both commands run — because dispatch is the first moment it can be asserted at all.

A Boundary that states the code's current shape — the whole words `already`, `currently` or `wired` — is refused unless the Issue carries at least one premise. The Boundary is read with its inline code spans intact, since that is the shape the claim is actually written in ("the signal is `already wired`, inert"); a fenced or indented block is still exempt, because a trigger word in a worked example is not a claim about the task's surface. A false "already wired" Boundary cost one task about 20 hours across five review rounds and two Principal rulings; the refusal asks for the claim to be written as a premise, not deleted.

Issues that carry no `## Premises` section and whose Boundary uses none of those words behave exactly as before, and every brief already posted is unaffected — the heading renders only when the Issue has premises.
