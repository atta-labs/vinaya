---
'@attalabs/vinaya': patch
---

The live result proof (`vinaya task-tools result-proof`) no longer asks an agent for a value the turn's schema forbids, and stops any case after five minutes. The "missing required source" and "unknown finding id" cases now ask for the valid value, check without the agent that the per-turn schema rejects the invalid one, and check live that the driver accepts the valid one. A case that runs past five minutes has its agent process group stopped, is reported FAIL as "timed out after 5 minutes", and the proof goes on to the next case.
