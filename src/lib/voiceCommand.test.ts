import { describe, expect, it } from 'vitest'

import type { JevAnswer, JevDecision } from './tauri/jev'
import {
  needsConfirmation,
  planFromDecision,
  planWarnings,
  toJevContext,
  type VoiceWorkspace,
} from './voiceCommand'

function answer(choice: string, confidence: number): JevAnswer {
  return { choice, confidence, probabilities: { [choice]: confidence } }
}

function decision(overrides: Partial<JevDecision> = {}): JevDecision {
  return {
    action: answer('new_terminal', 0.95),
    agent: answer('none', 0.2),
    project: answer('none', 0.2),
    terminal: answer('none', 0.2),
    prompt: '',
    promptConfidence: 0,
    tasks: [],
    leadCount: 0,
    multiTask: 0,
    parallel: 0,
    howMany: 0,
    addressedToApp: 0.95,
    destructive: 0.02,
    latencyMs: 900,
    costUsd: 0.00014,
    ...overrides,
  }
}

const workspace: VoiceWorkspace = {
  projects: [
    { id: 'p1', name: 'Portfolio', path: 'D:/repos/Portfolio' },
    { id: 'p2', name: 'summon', path: 'D:/repos/summon' },
  ],
  terminals: [
    {
      id: 't1',
      projectId: 'p1',
      projectName: 'Portfolio',
      ptyId: 'pty-1',
      agent: 'claude',
      cwd: 'D:/repos/Portfolio',
      busy: false,
      name: 'Claude Code',
    },
    {
      id: 't2',
      projectId: 'p2',
      projectName: 'summon',
      ptyId: null,
      agent: 'codex',
      cwd: 'D:/repos/summon',
      busy: true,
      name: 'Codex',
    },
  ],
  agents: ['claude', 'codex'],
  focusedProjectId: 'p1',
  focusedTerminalId: 't1',
}

describe('voice command routing', () => {
  it('spawns in the chosen project with the chosen agent', () => {
    const plan = planFromDecision(
      decision({
        project: answer('p2', 0.97),
        agent: answer('codex', 0.91),
        prompt: 'arrumar o header',
        promptConfidence: 0.88,
      }),
      workspace,
    )
    expect(plan).toMatchObject({
      kind: 'spawn',
      projectId: 'p2',
      jobs: [{ agent: 'codex', prompt: 'arrumar o header' }],
    })
  })

  it('falls back to the focused project when the choice is not confident', () => {
    const plan = planFromDecision(decision({ project: answer('p2', 0.31) }), workspace)
    expect(plan).toMatchObject({ kind: 'spawn', projectId: 'p1' })
  })

  it('keeps the skill preference out of it and never invents an agent', () => {
    const plan = planFromDecision(decision({ agent: answer('cursor', 0.99) }), workspace)
    expect(plan).toMatchObject({ kind: 'spawn', jobs: [{ agent: 'claude' }] })
  })

  it('reuses a terminal that is already open', () => {
    const plan = planFromDecision(
      decision({
        action: answer('reuse_terminal', 0.93),
        terminal: answer('t1', 0.88),
        prompt: 'continua o que voce estava fazendo',
        promptConfidence: 0.8,
      }),
      workspace,
    )
    expect(plan).toMatchObject({ kind: 'reuse', terminalId: 't1', ptyId: 'pty-1' })
  })

  it('refuses to reuse a terminal with no live pty', () => {
    const plan = planFromDecision(
      decision({
        action: answer('reuse_terminal', 0.93),
        terminal: answer('t2', 0.9),
        prompt: 'roda os testes',
        promptConfidence: 0.8,
      }),
      workspace,
    )
    expect(plan).toEqual({ kind: 'blocked', reason: 'noLiveTerminal' })
  })

  it('refuses to reuse without a prompt worth handing over', () => {
    const plan = planFromDecision(
      decision({ action: answer('reuse_terminal', 0.93), terminal: answer('t1', 0.9) }),
      workspace,
    )
    expect(plan).toEqual({ kind: 'blocked', reason: 'noPrompt' })
  })

  it('ignores a sentence that was not addressed to the app', () => {
    const plan = planFromDecision(decision({ addressedToApp: 0.08 }), workspace)
    expect(plan).toEqual({ kind: 'blocked', reason: 'notACommand' })
  })

  it('stops short of adding a project, which needs a folder', () => {
    const plan = planFromDecision(decision({ action: answer('new_project', 0.9) }), workspace)
    expect(plan).toEqual({ kind: 'blocked', reason: 'needsFolder' })
  })

  it('scales the fleet only when parallel work was asked for', () => {
    const one = planFromDecision(decision({ parallel: 0.2, howMany: 0.9 }), workspace)
    const three = planFromDecision(decision({ parallel: 0.9, howMany: 0.9 }), workspace)
    const two = planFromDecision(decision({ parallel: 0.9, howMany: 0.4 }), workspace)
    expect(one.kind === 'spawn' && one.jobs.length).toBe(1)
    expect(two.kind === 'spawn' && two.jobs.length).toBe(2)
    expect(three.kind === 'spawn' && three.jobs.length).toBe(3)
  })

  it('flags a destructive request and a busy target', () => {
    const call = decision({
      action: answer('reuse_terminal', 0.9),
      terminal: answer('t1', 0.9),
      prompt: 'apaga o worktree',
      promptConfidence: 0.8,
      destructive: 0.84,
    })
    const busy: VoiceWorkspace = {
      ...workspace,
      terminals: workspace.terminals.map((t) => (t.id === 't1' ? { ...t, busy: true } : t)),
    }
    const plan = planFromDecision(call, busy)
    expect(planWarnings(call, plan, busy)).toEqual(['destructive', 'busyTerminal'])
  })

  it('hands the model live workspace state, not a static list', () => {
    const context = toJevContext(workspace)
    expect(context.terminals).toEqual([
      {
        id: 't1',
        project: 'Portfolio',
        agent: 'claude',
        cwd: 'D:/repos/Portfolio',
        busy: false,
        name: 'Claude Code',
        ordinal: 1,
      },
      {
        id: 't2',
        project: 'summon',
        agent: 'codex',
        cwd: 'D:/repos/summon',
        busy: true,
        name: 'Codex',
        ordinal: 2,
      },
    ])
    expect(context.focusedTerminal).toBe('t1')
  })
})

describe('acting without a confirmation step', () => {
  it('runs a confident spawn on its own', () => {
    const call = decision({
      project: answer('p2', 0.97),
      prompt: 'write a hello world',
      promptConfidence: 0.9,
    })
    const plan = planFromDecision(call, workspace)
    expect(needsConfirmation(plan, planWarnings(call, plan, workspace))).toBe(false)
  })

  it('runs even when the project was a guess', () => {
    const call = decision({ project: answer('p2', 0.52) })
    const plan = planFromDecision(call, workspace)
    expect(needsConfirmation(plan, planWarnings(call, plan, workspace))).toBe(false)
  })

  it('still asks before a destructive request', () => {
    const call = decision({ project: answer('p2', 0.99), destructive: 0.91 })
    const plan = planFromDecision(call, workspace)
    expect(needsConfirmation(plan, planWarnings(call, plan, workspace))).toBe(true)
  })

  it('still asks before killing a terminal', () => {
    const call = decision({ action: answer('kill_terminal', 0.99), terminal: answer('t1', 0.99) })
    const plan = planFromDecision(call, workspace)
    expect(plan.kind).toBe('kill')
    expect(needsConfirmation(plan, planWarnings(call, plan, workspace))).toBe(true)
  })

  it('asks before handing a task to a busy agent, so the prompt never queues unseen', () => {
    const call = decision({
      action: answer('reuse_terminal', 0.93),
      terminal: answer('t1', 0.9),
      prompt: 'continua o refactor',
      promptConfidence: 0.85,
    })
    const busy: VoiceWorkspace = {
      ...workspace,
      terminals: workspace.terminals.map((t) => (t.id === 't1' ? { ...t, busy: true } : t)),
    }
    const plan = planFromDecision(call, busy)
    expect(planWarnings(call, plan, busy)).toContain('busyTerminal')
    expect(needsConfirmation(plan, planWarnings(call, plan, busy))).toBe(true)
  })

  it('hands a task to an idle agent without asking', () => {
    const call = decision({
      action: answer('reuse_terminal', 0.93),
      terminal: answer('t1', 0.9),
      prompt: 'continua o refactor',
      promptConfidence: 0.85,
    })
    const plan = planFromDecision(call, workspace)
    expect(needsConfirmation(plan, planWarnings(call, plan, workspace))).toBe(false)
  })
})

describe('never handing a task to a plain shell', () => {
  it('falls back to a coding agent, not to whatever came first', () => {
    const shellFirst: VoiceWorkspace = { ...workspace, agents: ['codex', 'claude'] }
    const plan = planFromDecision(decision({ agent: answer('none', 0.1) }), shellFirst)
    expect(plan).toMatchObject({ kind: 'spawn', jobs: [{ agent: 'claude' }] })
  })

  it('still honours a confident spoken agent', () => {
    const plan = planFromDecision(decision({ agent: answer('codex', 0.93) }), workspace)
    expect(plan).toMatchObject({ kind: 'spawn', jobs: [{ agent: 'codex' }] })
  })
})

describe('fanning one prompt out to several agents', () => {
  const fanout = decision({
    project: answer('p2', 0.97),
    prompt: 'run the build',
    promptConfidence: 0.9,
    parallel: 0.9,
    howMany: 0.4,
  })

  it('says out loud that the prompt is shared, not split per agent', () => {
    const plan = planFromDecision(fanout, workspace)
    expect(plan.kind === 'spawn' && plan.jobs.length).toBe(2)
    expect(planWarnings(fanout, plan, workspace)).toContain('sharedPrompt')
  })

  it('duplicates the task instead of stopping, but says so', () => {
    const plan = planFromDecision(fanout, workspace)
    expect(needsConfirmation(plan, planWarnings(fanout, plan, workspace))).toBe(false)
  })

  it('still opens bare terminals without asking', () => {
    const bare = decision({ project: answer('p2', 0.97), parallel: 0.9, howMany: 0.9 })
    const plan = planFromDecision(bare, workspace)
    expect(plan.kind === 'spawn' && plan.jobs.every((job) => !job.prompt)).toBe(true)
    expect(needsConfirmation(plan, planWarnings(bare, plan, workspace))).toBe(false)
  })
})

describe('splitting one sentence into different jobs', () => {
  const split = decision({
    project: answer('p2', 0.97),
    agent: answer('claude', 0.92),
    prompt: 'run the build',
    promptConfidence: 0.9,
    multiTask: 0.93,
    tasks: [
      {
        prompt: 'tell me the first line of main.ts',
        promptConfidence: 0.88,
        agent: answer('codex', 0.9),
        count: 0,
      },
    ],
  })

  it('gives each job its own agent and its own prompt', () => {
    const plan = planFromDecision(split, workspace)
    expect(plan).toMatchObject({
      kind: 'spawn',
      jobs: [
        { agent: 'claude', prompt: 'run the build' },
        { agent: 'codex', prompt: 'tell me the first line of main.ts' },
      ],
    })
  })

  it('drops the shared prompt warning once the jobs really differ', () => {
    const plan = planFromDecision(split, workspace)
    expect(planWarnings(split, plan, workspace)).not.toContain('sharedPrompt')
  })

  it('falls back to the lead task when the second one was a guess', () => {
    const shaky = decision({
      project: answer('p2', 0.97),
      prompt: 'run the build',
      promptConfidence: 0.9,
      tasks: [
        { prompt: 'and the tests', promptConfidence: 0.12, agent: answer('codex', 0.9), count: 0 },
      ],
    })
    const plan = planFromDecision(shaky, workspace)
    expect(plan).toMatchObject({
      kind: 'spawn',
      jobs: [
        { agent: 'claude', prompt: 'run the build' },
        { agent: 'codex', prompt: 'run the build' },
      ],
    })
  })

  it('drops a slot the model filled with neither agent nor task', () => {
    const empty = decision({
      project: answer('p2', 0.97),
      prompt: 'run the build',
      promptConfidence: 0.9,
      tasks: [
        { prompt: 'and the tests', promptConfidence: 0.12, agent: answer('none', 0.1), count: 0 },
      ],
    })
    const plan = planFromDecision(empty, workspace)
    expect(plan.kind === 'spawn' && plan.jobs.length).toBe(1)
  })

  it('runs a split without asking, since nothing is destroyed', () => {
    const plan = planFromDecision(split, workspace)
    expect(needsConfirmation(plan, planWarnings(split, plan, workspace))).toBe(false)
  })
})

describe('naming several agents with no task at all', () => {
  const twoAgents = decision({
    project: answer('p2', 0.97),
    agent: answer('codex', 0.9),
    prompt: '',
    promptConfidence: 0,
    tasks: [{ prompt: '', promptConfidence: 0, agent: answer('claude', 0.88), count: 0 }],
  })

  it('opens one of each named agent instead of two of the same', () => {
    const plan = planFromDecision(twoAgents, workspace)
    expect(plan).toMatchObject({
      kind: 'spawn',
      jobs: [
        { agent: 'codex', prompt: '' },
        { agent: 'claude', prompt: '' },
      ],
    })
  })

  it('does not call it a shared prompt when there is no prompt', () => {
    const plan = planFromDecision(twoAgents, workspace)
    const warnings = planWarnings(twoAgents, plan, workspace)
    expect(warnings).toContain('noPromptSpawn')
    expect(warnings).not.toContain('sharedPrompt')
  })

  it('gives a second named agent the same task when only one task was said', () => {
    const shared = decision({
      project: answer('p2', 0.97),
      agent: answer('codex', 0.9),
      prompt: 'run the build',
      promptConfidence: 0.9,
      tasks: [{ prompt: '', promptConfidence: 0, agent: answer('claude', 0.88), count: 0 }],
    })
    const plan = planFromDecision(shared, workspace)
    expect(plan).toMatchObject({
      kind: 'spawn',
      jobs: [
        { agent: 'codex', prompt: 'run the build' },
        { agent: 'claude', prompt: 'run the build' },
      ],
    })
  })
})

describe('talking to an agent that is already open', () => {
  it('hands a one word answer to the terminal that was named', () => {
    const reply = decision({
      action: answer('reuse_terminal', 0.94),
      terminal: answer('t1', 0.87),
      prompt: 'yes',
      promptConfidence: 0.82,
    })
    const plan = planFromDecision(reply, workspace)
    expect(plan).toMatchObject({ kind: 'reuse', terminalId: 't1', ptyId: 'pty-1', prompt: 'yes' })
  })

  it('warns instead of hiding that the agent is still working', () => {
    const reply = decision({
      action: answer('send_prompt', 0.92),
      terminal: answer('t2', 0.9),
      prompt: 'yes',
      promptConfidence: 0.82,
    })
    const plan = planFromDecision(reply, workspace)
    expect(plan).toEqual({ kind: 'blocked', reason: 'noLiveTerminal' })
  })
})

describe('asking for two of each agent', () => {
  it('opens two of one and two of the other, not one each', () => {
    const pairs = decision({
      project: answer('p2', 0.97),
      agent: answer('claude', 0.95),
      leadCount: 0.5,
      tasks: [{ prompt: '', promptConfidence: 0, agent: answer('codex', 0.93), count: 0.5 }],
    })
    const plan = planFromDecision(pairs, workspace)
    expect(plan.kind === 'spawn' && plan.jobs.map((job) => job.agent)).toEqual([
      'claude',
      'claude',
      'codex',
      'codex',
    ])
  })

  it('still opens one each when no count was said', () => {
    const singles = decision({
      project: answer('p2', 0.97),
      agent: answer('claude', 0.95),
      leadCount: 0,
      tasks: [{ prompt: '', promptConfidence: 0, agent: answer('codex', 0.93), count: 0 }],
    })
    const plan = planFromDecision(singles, workspace)
    expect(plan.kind === 'spawn' && plan.jobs.map((job) => job.agent)).toEqual(['claude', 'codex'])
  })
})
