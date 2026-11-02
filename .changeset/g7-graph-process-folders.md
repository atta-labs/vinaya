---
'@attalabs/vinaya': patch
---

The registry gates' seventh rule now builds its import graph from the process folders' non-test sources as well as the CLI's, so a check program that reaches the Log through a file living in a process folder is seen as reaching a producer; files under a `tests` folder there, and every `.test.ts` file, stay out.
