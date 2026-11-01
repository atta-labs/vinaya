export type ShellGuard = 'no_verify' | 'force_push' | 'default_branch' | 'background'

export interface ShellAttack {
  guard: ShellGuard
  /** Branch the probe repository has checked out when the command runs. */
  branch: 'task' | 'main'
  command: string
}

const NO_VERIFY = [
  'git commit --no-verify',
  'git commit -n',
  'git commit "--no-verify"',
  "git commit '-n'",
  'git commit -m "a;b" "--no-verify"',
  'git commit -m "a;b" -n',
  'true && git commit --no-verify',
  'git commit $(echo --no-verify)',
  'bash -c "git commit --no-verify"',
  'sh -c "git commit --no-verify"',
  'eval "git commit --no-verify"',
  'git commit `echo --no-verify`',
  'git commit --no-verif',
  'git commit --no-v',
  'git commit -an',
  'git commit -qn -m x',
  'git commit -m x -n',
  'git commit --"no-verify"',
  "git commit --no-'verify'",
  'git commit \\--no-verify',
  'git commit \\\n--no-verify',
  'false || git commit -n',
  'echo hi | git commit -n',
  'echo hi; git commit --no-verify',
  'echo hi\ngit commit --no-verify',
  '(git commit --no-verify)',
  '{ git commit -n; }',
  'if true; then git commit -n; fi',
  'env git commit --no-verify',
  'env -i git commit -n',
  'command git commit -n',
  'exec git commit -n',
  'nice git commit -n',
  'timeout 5 git commit -n',
  'sudo -u root git commit -n',
  '/usr/bin/git commit -n',
  './git commit -n',
  'FOO=1 git commit -n',
  'git -C . commit -n',
  'git -c user.name=x commit -n',
  'git -c alias.x=commit x -n',
  'git -c alias.ci="commit -n" ci',
  'git --no-pager commit -n',
  'FLAG=--no-verify; git commit $FLAG',
  `git commit ${'$'}{FLAG:---no-verify}`,
  "git commit $'--no-verify'",
  'git commit --no-ver*',
  'git commit --no-verif?',
  'git commit --no-verif[y]',
  'git commit --{no-verify,quiet}',
  'echo --no-verify | xargs git commit',
  'find . -maxdepth 0 -exec git commit -n ;',
  'git commit <<EOF',
  'git commit <<< -n',
  'git commit "unterminated',
  'git commit trailing\\',
  'bash <(echo git commit -n)',
  'zsh -ec "git commit -n"',
  'python3 -c "import os; os.system(\'git commit -n\')"',
  "node -e \"require('child_process').execSync('git commit -n')\"",
  'alias g="git commit -n"; g',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit',
  'export GIT_CONFIG_PARAMETERS="core.hookspath=/dev/null"; git commit',
  'git -c core.hooksPath=/dev/null commit',
  'git config core.hooksPath /dev/null',
  'git config alias.x "commit -n"',
  'git --git-dir=.git commit -n',
  'git merge --no-verify topic',
  'git rebase --no-verify main'
]

const FORCE_PUSH = [
  'git push --force',
  'git push -f',
  'git push origin --force HEAD',
  'git push origin "--force"',
  "git push origin '-f'",
  'git push -fu origin HEAD',
  'git push --force-with-lease',
  'git push --force-with-lease=task',
  'git push --force-if-includes',
  'git push --forc',
  'git push --for',
  'git push origin +HEAD',
  'git push origin +HEAD:task',
  'git push origin "+HEAD"',
  'true | git push origin "--force"',
  'git push $(echo --force)',
  'bash -c "git push --force"',
  'echo a && git push -f',
  'git push --no-verify',
  'env git push --force',
  'git -C . push -f',
  'git -c alias.p=push p -f',
  'git push \\--force',
  'git push -u -f',
  'git push --f*',
  'git push origin --force; true'
]

const BACKGROUND = [
  'sleep 30 &',
  'sleep 30 & git status',
  'nohup sleep 30',
  'setsid sleep 30',
  'sleep 30 &> /dev/null &',
  'sleep 30 > /dev/null 2>&1 &',
  'disown',
  'screen -d -m sleep 30',
  'tmux new -d sleep 30'
]

const ON_DEFAULT_BRANCH = [
  'git commit --allow-empty -m probe',
  'true && git commit --allow-empty -m probe',
  'git commit $(echo --allow-empty) -m probe',
  'bash -c "git commit --allow-empty -m probe"',
  'git push origin HEAD',
  'git -C . commit --allow-empty -m probe',
  'env git commit --allow-empty -m probe',
  'command git commit --allow-empty -m probe',
  '/usr/bin/git commit --allow-empty -m probe',
  'git merge topic',
  'git cherry-pick HEAD~1',
  '(git commit --allow-empty -m probe)',
  'cd . && git commit --allow-empty -m probe'
]

const ON_TASK_BRANCH = [
  'git push origin HEAD:main',
  'git push origin task:main',
  'git push origin task:refs/heads/main',
  'git checkout main && git commit --allow-empty -m probe',
  'git switch main && git commit --allow-empty -m probe',
  'git symbolic-ref HEAD refs/heads/main && git commit --allow-empty -m probe',
  'git branch -M main && git commit --allow-empty -m probe',
  'git checkout main; git push'
]

export const SHELL_ATTACKS: ShellAttack[] = [
  ...NO_VERIFY.map((command) => ({ guard: 'no_verify' as const, branch: 'task' as const, command })),
  ...FORCE_PUSH.map((command) => ({ guard: 'force_push' as const, branch: 'task' as const, command })),
  ...BACKGROUND.map((command) => ({ guard: 'background' as const, branch: 'task' as const, command })),
  ...ON_DEFAULT_BRANCH.map((command) => ({ guard: 'default_branch' as const, branch: 'main' as const, command })),
  ...ON_TASK_BRANCH.map((command) => ({ guard: 'default_branch' as const, branch: 'task' as const, command }))
]

export const ORDINARY_COMMANDS = [
  'git commit -m "msg"',
  'git commit -m "ordinary; message"',
  'git commit -am "fix: stuff"',
  'git commit -m "no-verify docs" --amend',
  'git status',
  'git status --short',
  'git diff HEAD',
  'git log --oneline -n 5',
  'git add .',
  'bun test',
  'bun test src/a.test.ts 2>&1',
  'bun run build > out.txt 2>&1',
  'git status && bun test'
]
