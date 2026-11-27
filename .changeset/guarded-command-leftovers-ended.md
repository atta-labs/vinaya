---
"@attalabs/vinaya": patch
---

A command run through the check guard or the driver's tool guard no longer leaves processes behind. When the command returns with processes still in its process group, the watcher sends them the termination signal, returns the command's own exit status once the group is empty, and sends the kill signal when the grace period ends. When the caller is killed, a process that ignores the termination signal is now killed at the end of the grace period even though the command itself already exited. A command that leaves nothing behind still returns at once.
