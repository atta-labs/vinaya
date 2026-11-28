---
"@attalabs/vinaya": patch
---

A driver whose claim recorded a paused task's resume resolution now continues the run, also when a cancel takes a newer ownership number before the claim's transition is written. The claim returns its resolution and reports the refused transition on stderr, and the ruling watch recognises a resume resolution holding the author and source it passed to its own claim. A cancel after a recorded resume is refused as before.
