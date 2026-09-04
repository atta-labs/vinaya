#!/usr/bin/env sh
# >>> vinaya:managed:track-transcript >>>
# Vinaya-managed Stop hook. Records this session's transcript_path (and
# session_id) so the token-report adapter can resolve it without scanning
# ~/.claude/projects/ for the newest file, which silently grabs another
# concurrent session's transcript when two worktrees are active at once.
node -e '
const fs = require("fs")
let data = ""
process.stdin.on("data", (c) => { data += c })
process.stdin.on("end", () => {
  let hook
  try {
    hook = JSON.parse(data)
  } catch {
    return
  }
  if (!hook.transcript_path) return
  const crypto = require("crypto")
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const tmpDir = process.env.TMPDIR || "/tmp"
  const digest = crypto.createHash("sha256").update(projectDir).digest("hex")
  const key = projectDir.replace(/[^A-Za-z0-9]+/g, "-") + "-" + digest
  const pointerPath = tmpDir + "/claude-transcript-" + key + ".txt"
  const content = (hook.session_id || "") + "\t" + hook.transcript_path + "\n"
  const scratchPath = pointerPath + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp"
  try {
    fs.writeFileSync(scratchPath, content, { mode: 0o600, flag: "wx" })
  } catch {
    return
  }
  try {
    fs.renameSync(scratchPath, pointerPath)
  } catch {
    try { fs.unlinkSync(scratchPath) } catch {}
  }
})
'
exit 0
# <<< vinaya:managed:track-transcript <<<
