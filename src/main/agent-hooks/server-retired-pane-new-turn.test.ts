import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))
vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})
afterEach(() => vi.restoreAllMocks())

/** Each source's own new-turn boundary, as `isNewTurnEvent` classifies it. `null` means the
 *  provider has no turn boundary at all, so a retired pane there stays retired by design. */
const NEW_TURN_EVENT: Record<AgentHookSource, string | null> = {
  claude: 'SessionStart',
  kimi: 'UserPromptSubmit',
  codex: 'SessionStart',
  gemini: 'BeforeAgent',
  antigravity: 'PreInvocation',
  amp: 'agent.start',
  cursor: 'beforeSubmitPrompt',
  pi: 'before_agent_start',
  omp: 'before_agent_start',
  'prime-agent': 'before_agent_start',
  droid: 'UserPromptSubmit',
  grok: 'user_prompt_submit',
  copilot: 'sessionStart',
  hermes: 'pre_llm_call',
  devin: 'UserPromptSubmit',
  opencode: null,
  'mimo-code': null,
  'command-code': null
}

function reviveRetiredPane(source: AgentHookSource, hookEventName: string): boolean {
  const server = new AgentHookServer()
  // Why: retirement is what command completion leaves behind on a reusable shell pane.
  server.retirePaneAuthority(PANE)
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      source,
      hookEventName,
      payload: { state: 'working', prompt: 'after reuse', agentType: 'claude' }
    },
    'conn-1'
  )
  return server.getStatusSnapshot().some((entry) => entry.paneKey === PANE)
}

describe("retired pane un-retires on each provider's own new-turn event", () => {
  // Why: the gate matched two raw literals, so only the 5 sources that happen to name their
  // boundary UserPromptSubmit/SessionStart could ever revive — the rest stayed rowless forever.
  // Why: keys of a Record<AgentHookSource, …> — a new source fails typecheck here rather than
  // silently skipping coverage, which is the same guarantee the runtime list would give.
  const revivable = (Object.keys(NEW_TURN_EVENT) as AgentHookSource[]).filter(
    (source) => NEW_TURN_EVENT[source] !== null
  )

  it.each(revivable)('%s', (source) => {
    const hookEventName = NEW_TURN_EVENT[source]
    expect(hookEventName).not.toBeNull()
    expect(reviveRetiredPane(source, hookEventName as string)).toBe(true)
  })

  it('leaves the pane retired for a source with no turn boundary', () => {
    // Why: opencode/mimo-code/command-code have no new-turn event; reviving them would need a
    // different signal, so the gate must stay closed rather than guess.
    expect(reviveRetiredPane('opencode', 'SessionStart')).toBe(false)
  })

  it('leaves the pane retired for a non-boundary event on a revivable source', () => {
    // Why: guards the inverse — the gate must not open on any event that merely mentions a session.
    expect(reviveRetiredPane('gemini', 'AfterAgent')).toBe(false)
  })
})
