import { describe, expect, it } from 'vitest'
import { parseRemoteCliArgs } from './ssh-remote-cli-args'
import { buildRemoteLinearProjectEditRequest } from './ssh-remote-linear-project-edit-request'
import { tryDispatchRemoteLinearProjectWriteCli } from './ssh-remote-linear-project-write-cli'

/**
 * `orca linear project create|edit|update add` is parsed twice by hand: by the
 * local CLI against `COMMAND_SPECS`, and by this shim against its own flag
 * grammar. The two projects cannot share a tsconfig, so the local outcomes are
 * pinned here as literals and asserted against the local builders by
 * `src/cli/linear-project-create.test.ts`, `linear-project-edit.test.ts` and
 * `handlers/linear-project-writes.test.ts`. A drift on either side fails one of
 * the two suites; agreeing on the wrong value takes an edit to both.
 */

type Outcome = { params: Record<string, unknown> } | { error: string }

/** JSON-RPC drops undefined-valued keys, so parity is compared on the transmitted shape. */
function transmitted(value: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value))
}

async function remote(argv: string[]): Promise<Outcome> {
  let captured: object | undefined
  const dispatcher = {
    dispatch: async (request: { params?: object }) => {
      captured = request.params
      return { id: 'parity', result: {} }
    }
  }
  try {
    await tryDispatchRemoteLinearProjectWriteCli(
      dispatcher as never,
      parseRemoteCliArgs(argv),
      undefined
    )
    return { params: transmitted(captured ?? {}) }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

/** Why: called directly so an edit parse error surfaces instead of looking like a command miss. */
function remoteEdit(argv: string[]): Outcome {
  try {
    return {
      params: transmitted(buildRemoteLinearProjectEditRequest(parseRemoteCliArgs(argv), undefined))
    }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

const CREATE = ['linear', 'project', 'create']
const EDIT = ['linear', 'project', 'edit']
const UPDATE_ADD = ['linear', 'project', 'update', 'add']

describe('linear project create matches the local CLI', () => {
  // Why: a reference typed twice must reach the host once over SSH too, or the same
  // command costs the host one extra workspace lookup per duplicate.
  it('dedupes repeated teams, members and labels', async () => {
    await expect(
      remote([...CREATE, '--name', 'P', '--team', 'ENG', '--team', 'ENG'])
    ).resolves.toEqual({ params: { name: 'P', teams: ['ENG'] } })
    await expect(
      remote([...CREATE, '--name', 'P', '--team', 'ENG', '--member', 'ada', '--member', 'ada'])
    ).resolves.toEqual({ params: { name: 'P', teams: ['ENG'], members: ['ada'] } })
    await expect(
      remote([...CREATE, '--name', 'P', '--team', 'ENG', '--label', 'x', '--label', 'x'])
    ).resolves.toEqual({ params: { name: 'P', teams: ['ENG'], labels: ['x'] } })
  })

  // Why: `--description ""` is a real empty summary; treating '' as a missing value
  // turned the flag boolean and pushed the empty string on as a stray positional.
  it('keeps an empty value passed as its own argv token', async () => {
    await expect(
      remote([...CREATE, '--name', 'P', '--team', 'ENG', '--description', ''])
    ).resolves.toEqual({ params: { name: 'P', teams: ['ENG'], description: '' } })
  })

  it.each([
    [['--team', 'ENG'], 'Missing required --name'],
    [['--name', '  ', '--team', 'ENG'], '--name must not be blank'],
    [
      ['--name', 'P', '--team', 'ENG', '--color', 'nope'],
      '--color must be #RRGGBB, quoted so the shell keeps the leading #'
    ],
    [
      ['--name', 'P', '--team', 'ENG', '--write-id', 'not-a-uuid'],
      '--write-id must be a UUID v4 for Linear project create'
    ],
    [
      ['--name', 'P', '--team', 'ENG', '--workspace', 'all'],
      '--workspace all is not valid for Linear writes'
    ]
  ])('rejects %j with the local CLI wording', async (tail, error) => {
    await expect(remote([...CREATE, ...tail])).resolves.toEqual({ error })
  })
})

describe('linear project edit matches the local CLI', () => {
  it('dedupes a repeated collection reference', () => {
    expect(remoteEdit([...EDIT, 'launch-q3', '--member', 'ada', '--member', 'ada'])).toEqual({
      params: { input: 'launch-q3', members: ['ada'] }
    })
  })

  it('keeps an empty description passed as its own argv token', () => {
    expect(remoteEdit([...EDIT, 'launch-q3', '--description', ''])).toEqual({
      params: { input: 'launch-q3', description: '' }
    })
  })

  it.each([
    [['launch-q3'], 'Pass at least one field flag or --clear-* flag to edit a Linear project'],
    [
      ['launch-q3', '--team'],
      '--team replaces the whole collection and needs at least one value; a project edit cannot remove every team'
    ],
    [
      ['launch-q3', '--member'],
      '--member replaces the whole collection and needs at least one value; use --clear-members to empty it'
    ],
    [['launch-q3', '--name', '   '], '--name must not be blank'],
    [
      ['launch-q3', '--color', 'aabbcc'],
      '--color must be #RRGGBB, quoted so the shell keeps the leading #'
    ],
    [
      ['launch-q3', '--workspace', 'all', '--name', 'x'],
      '--workspace all is not valid for Linear writes'
    ]
  ])('rejects %j with the local CLI wording', (tail, error) => {
    expect(remoteEdit([...EDIT, ...tail])).toEqual({ error })
  })
})

describe('linear project update add matches the local CLI', () => {
  it.each([
    [['launch-q3', '--body', ''], 'Linear project update body must not be empty'],
    [
      ['launch-q3', '--body', 's', '--health', 'bogus'],
      '--health must be one of on-track, at-risk, off-track'
    ],
    [
      ['launch-q3', '--body', 's', '--workspace', 'all'],
      '--workspace all is not valid for Linear writes'
    ]
  ])('rejects %j with the local CLI wording', async (tail, error) => {
    await expect(remote([...UPDATE_ADD, ...tail])).resolves.toEqual({ error })
  })
})
