---
"@attalabs/vinaya": patch
---

A Principal ruling's own words no longer end a review round. `dev-review-loop`'s reviewer prompt is now assembled from labelled pieces — the fixed text this renderer writes, and the facts interpolated into it (an Issue's objectives, the rulings on the pull request, the head, the CI conclusion, the frozen brief's revision) — and the banned-framing lint reads only the driver-authored pieces. A ruling or an objective that happens to say "clearly" is carried through to the reviewer verbatim, where before it raised `renderReviewerPrompt produced banned framing` and paused the round as an infrastructure failure. The lint still refuses a banned phrase in the renderer's own fixed text, including one formed across two fixed strings sitting either side of a held-out fact, and the rendered prompt is byte-for-byte what it always was.
