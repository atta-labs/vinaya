---
'@attalabs/vinaya': patch
---

The after-turn confinement check now excuses a concurrently-dispatched sibling reviewer's same-round scratch copies (`reviewer-scratch` / `security-scratch`, with their `-retry<n>` forms), not only its work directory. Before, a sibling's scratch copy appearing or being swept while the other reviewer's turn ran was blamed on that turn as a protected-path change, pausing the loop as infrastructure. The shared `candidate`, every other round's folders and every third role's folders stay protected.
