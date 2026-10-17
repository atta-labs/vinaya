---
'@attalabs/vinaya': patch
---

The evaluation harness gains a process-neutral layer G: a validated neutral case with a key-order-stable digest, nine neutral outcomes each carrying a fact status, ten generic code graders that read only a neutral case and its outcomes, and a banned-terms checker for neutral task statements. Every grader identity now declares `layer: G` or `layer: P`, and the existing suite graders are `P`.
