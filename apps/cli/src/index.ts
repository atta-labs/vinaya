#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archiveCommand, archiveTrancheCommand } from './commands/archive.js'
import { auditCommand } from './commands/audit.js'
import { briefRenderCommand } from './commands/brief.js'
import { checkCommand } from './commands/check.js'
import { commitMsgCommand } from './commands/commit-msg.js'
import { demoBreakCommand } from './commands/demo.js'
import { dispatchCommand } from './commands/dispatch.js'
import { doctorCommand } from './commands/doctor.js'
import { doctrineCommand } from './commands/doctrine.js'
import { ejectCommand } from './commands/eject.js'
import { initCommand, initProductCommand } from './commands/init.js'
import { issueCreateCommand, issueEditCommand } from './commands/issue.js'
import { issueObjectivesEditCommand } from './commands/issue-objectives.js'
import { logFlushCommand } from './commands/log.js'
import {
  milestoneAdoptCommand,
  milestoneCloseCommand,
  milestoneCreateCommand,
  milestoneEditCommand
} from './commands/milestone.js'
import { newCheckCommand } from './commands/new-check.js'
import { newNoopCheckCommand } from './commands/new-noop-check.js'
import { newRoleCommand } from './commands/new-role.js'
import { prCreateCommand, prEditCommand } from './commands/pr.js'
import { prRuleCommand } from './commands/pr-rule.js'
import { prReportCommand } from './commands/pr-report.js'
import { prVerifyEvidenceCommand } from './commands/pr-verify-evidence.js'
import { quickstartCommand } from './commands/quickstart.js'
import { releaseCommand } from './commands/release.js'
import { reviewPostCommand } from './commands/review-post.js'
import { reviewStatusCommand } from './commands/review-status.js'
import { runStudio } from './commands/studio.js'
import { tokensCommand } from './commands/tokens.js'
import { upgradeCommand } from './commands/upgrade.js'
import { waiverCommand } from './commands/waiver.js'
import { printJson } from './lib/envelope.js'
import { printHelp } from './lib/output.js'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'))
  return pkg.version
}

const [, , command, ...args] = process.argv

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp()
  process.exit(0)
}

try {
  switch (command) {
    case 'version': {
      const version = readVersion()
      if (args.includes('--json')) {
        printJson({ version })
      } else {
        process.stdout.write(`${version}\n`)
      }
      break
    }
    case 'studio': {
      const code = await runStudio(process.cwd(), args)
      process.exit(code)
      break
    }
    case 'init': {
      const [subcommand, ...rest] = args
      if (subcommand === 'product') {
        await initProductCommand(rest)
      } else {
        await initCommand(args)
      }
      break
    }
    case 'eject': {
      await ejectCommand(args)
      break
    }
    case 'doctor': {
      await doctorCommand(args)
      break
    }
    case 'doctrine': {
      doctrineCommand(args)
      break
    }
    case 'upgrade': {
      await upgradeCommand(args)
      break
    }
    case 'check': {
      await checkCommand(args)
      break
    }
    case 'commit-msg': {
      commitMsgCommand(args)
      break
    }
    case 'archive': {
      const [subcommand, ...rest] = args
      if (subcommand === 'tranche') {
        await archiveTrancheCommand(rest)
      } else {
        await archiveCommand(args)
      }
      break
    }
    case 'audit': {
      await auditCommand(args)
      break
    }
    case 'new': {
      const [subcommand, ...rest] = args
      if (subcommand === 'check') {
        newCheckCommand(rest)
      } else if (subcommand === 'noop-check') {
        newNoopCheckCommand(rest)
      } else if (subcommand === 'role') {
        newRoleCommand(rest)
      } else {
        console.error(`Unknown 'new' subcommand: ${subcommand ?? '(none)'} (expected 'check', 'noop-check', or 'role')`)
        process.exit(2)
      }
      break
    }
    case 'brief': {
      const [subcommand, ...rest] = args
      if (subcommand === 'render') {
        await briefRenderCommand(rest)
      } else {
        console.error(`Unknown 'brief' subcommand: ${subcommand ?? '(none)'} (expected 'render')`)
        process.exit(2)
      }
      break
    }
    case 'pr': {
      const [subcommand, ...rest] = args
      if (subcommand === 'create') {
        await prCreateCommand(rest)
      } else if (subcommand === 'edit') {
        prEditCommand(rest)
      } else if (subcommand === 'report') {
        await prReportCommand(rest)
      } else if (subcommand === 'verify-evidence') {
        await prVerifyEvidenceCommand(rest)
      } else if (subcommand === 'rule') {
        prRuleCommand(rest)
      } else {
        console.error(
          `Unknown 'pr' subcommand: ${subcommand ?? '(none)'} (expected 'create', 'edit', 'report', 'verify-evidence', or 'rule')`
        )
        process.exit(2)
      }
      break
    }
    case 'issue': {
      const [rawSubcommand, ...rest] = args
      // `objectives edit` is one two-word subcommand, not a nested dispatch
      // level: the router folds the second argv token into one literal so
      // `issue objectives edit` reads as a single `subcommand === '<value>'`
      // branch, the same shape every other multi-word command already uses
      // (`new noop-check`, `pr verify-evidence`) — never a second switch.
      const subcommand = rawSubcommand === 'objectives' && rest[0] === 'edit' ? 'objectives edit' : rawSubcommand
      const passthrough = subcommand === 'objectives edit' ? rest.slice(1) : rest
      if (subcommand === 'create') {
        issueCreateCommand(passthrough)
      } else if (subcommand === 'edit') {
        issueEditCommand(passthrough)
      } else if (subcommand === 'objectives edit') {
        issueObjectivesEditCommand(passthrough)
      } else {
        console.error(
          `Unknown 'issue' subcommand: ${rawSubcommand ?? '(none)'} (expected 'create', 'edit', or 'objectives edit')`
        )
        process.exit(2)
      }
      break
    }
    case 'log': {
      const [subcommand, ...rest] = args
      if (subcommand === 'flush') {
        await logFlushCommand(rest)
      } else {
        console.error(`Unknown 'log' subcommand: ${subcommand ?? '(none)'} (expected 'flush')`)
        process.exit(2)
      }
      break
    }
    case 'milestone': {
      const [subcommand, ...rest] = args
      if (subcommand === 'create') {
        await milestoneCreateCommand(rest)
      } else if (subcommand === 'adopt') {
        await milestoneAdoptCommand(rest)
      } else if (subcommand === 'edit') {
        await milestoneEditCommand(rest)
      } else if (subcommand === 'close') {
        await milestoneCloseCommand(rest)
      } else {
        console.error(`Unknown 'milestone' subcommand: ${subcommand ?? '(none)'} (expected create/adopt/edit/close)`)
        process.exit(2)
      }
      break
    }
    case 'review': {
      const [subcommand, ...rest] = args
      if (subcommand === 'post') {
        await reviewPostCommand(rest)
      } else if (subcommand === 'status') {
        await reviewStatusCommand(rest)
      } else {
        console.error(`Unknown 'review' subcommand: ${subcommand ?? '(none)'} (expected post/status)`)
        process.exit(2)
      }
      break
    }
    case 'demo': {
      const [subcommand, ...rest] = args
      if (subcommand === 'break') {
        await demoBreakCommand(rest)
      } else {
        console.error(`Unknown 'demo' subcommand: ${subcommand ?? '(none)'} (expected 'break')`)
        process.exit(2)
      }
      break
    }
    case 'waiver': {
      await waiverCommand(args)
      break
    }
    case 'release': {
      await releaseCommand(args)
      break
    }
    case 'quickstart': {
      await quickstartCommand(args)
      break
    }
    case 'tokens': {
      tokensCommand(args)
      break
    }
    case 'dispatch': {
      await dispatchCommand(args)
      break
    }
    default:
      console.error(`Unknown command: ${command}`)
      printHelp()
      process.exit(2)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Error: ${message}`)
  process.exit(1)
}
