import { describe, expect, it } from 'bun:test'
import { defaultTaskCancelHandler } from '../../../src/lib/task-tools/cancel.js'
import { taskEscalationReadHandler, taskStatusHandler } from '../../../src/lib/task-tools/handlers.js'
import { routeTaskToolIntent } from '../../../src/lib/task-tools/router.js'
import { defaultTaskResumeHandler } from '../../../src/lib/task-tools/resume.js'
import { defaultTaskStartHandler } from '../../../src/lib/task-tools/start.js'

/**
 * Held-out prompts (O3) — none of these are the literal keywords the
 * router's own regexes name; each is a natural way an Operator might phrase
 * the same intent, proving the router generalizes rather than echoing its
 * own word list back.
 */

describe('routeTaskToolIntent — read intents', () => {
  it('routes a status question to task_status', () => {
    expect(routeTaskToolIntent('how is task-operator-v1 task 1 coming along?')).toBe('task_status')
    expect(routeTaskToolIntent('check on the state of Issue 558')).toBe('task_status')
    expect(routeTaskToolIntent('is the dev-review-loop for #558 still running?')).toBe('task_status')
  })

  it('routes an escalation question to task_escalation_read, not task_status', () => {
    expect(routeTaskToolIntent('why did task 558 get stuck?')).toBe('task_escalation_read')
    expect(routeTaskToolIntent('what does the escalation packet say for the paused run?')).toBe('task_escalation_read')
    expect(routeTaskToolIntent('this task seems blocked on something, what does it need?')).toBe('task_escalation_read')
  })
})

describe('routeTaskToolIntent — mutating intents', () => {
  it('routes a fresh-dispatch request to task_start', () => {
    expect(routeTaskToolIntent('kick off task-operator-v1 task 2')).toBe('task_start')
    expect(routeTaskToolIntent('please launch the next task in the tranche')).toBe('task_start')
  })

  it('routes a continue/resume request to task_resume, never task_start', () => {
    expect(routeTaskToolIntent('pick the paused run back up')).toBe('task_resume')
    expect(routeTaskToolIntent('carry on with issue 558')).toBe('task_resume')
    expect(routeTaskToolIntent('unpause it')).toBe('task_resume')
  })

  it('routes a stop/cancel request to task_cancel, never task_resume', () => {
    expect(routeTaskToolIntent('kill the run for task 558')).toBe('task_cancel')
    expect(routeTaskToolIntent('please abort this task, it is no longer needed')).toBe('task_cancel')
  })

  it('a cancel phrased alongside a status word still routes to task_cancel, not task_status', () => {
    expect(routeTaskToolIntent('the task is stuck running forever, just stop it')).toBe('task_cancel')
  })
})

describe('routeTaskToolIntent — unrecognized', () => {
  it('returns null for an utterance naming no tool intent at all', () => {
    expect(routeTaskToolIntent('what is the weather like today?')).toBeNull()
  })
})

describe('routing never reaches the wrong handler', () => {
  const HANDLERS = {
    task_start: defaultTaskStartHandler,
    task_status: taskStatusHandler,
    task_escalation_read: taskEscalationReadHandler,
    task_resume: defaultTaskResumeHandler,
    task_cancel: defaultTaskCancelHandler
  } as const

  it('a read-intent prompt never resolves to a mutating handler', () => {
    const name = routeTaskToolIntent('check on the state of Issue 558')
    expect(name).toBe('task_status')
    expect(HANDLERS[name!]).toBe(taskStatusHandler)
    expect(HANDLERS[name!]).not.toBe(defaultTaskStartHandler)
    expect(HANDLERS[name!]).not.toBe(defaultTaskResumeHandler)
    expect(HANDLERS[name!]).not.toBe(defaultTaskCancelHandler)
  })

  it('a cancel-intent prompt never resolves to a read handler', () => {
    const name = routeTaskToolIntent('please abort this task, it is no longer needed')
    expect(name).toBe('task_cancel')
    expect(HANDLERS[name!]).toBe(defaultTaskCancelHandler)
    expect(HANDLERS[name!]).not.toBe(taskStatusHandler)
    expect(HANDLERS[name!]).not.toBe(taskEscalationReadHandler)
  })
})
