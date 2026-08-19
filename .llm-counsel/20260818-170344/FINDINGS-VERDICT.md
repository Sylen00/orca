# Findings verdict — readiness round 5 (findings-severity counsel)

Seats launched: grok, codex (gpt-5.6-sol high), claude-opus high, claude-fable high.
Seats that produced a report: **3** (codex, claude-opus, claude-fable).
Seat failed: **grok** — hit a hard usage/credit wall ("Upgrade tier / Buy more credits") before
producing any output. Marked failed per the skill's stalled-seat rule.

Quorum: the skill requires >=2 seats to KEEP a P0/P1. Three seats reported. **No seat kept any
candidate at P0 or P1**, so the quorum question is moot in the keeping direction.

Phase 2 (blind peer rating) was NOT run. It is a tiebreak instrument, and there is no tie: all
three seats independently returned 0 P0 / 0 P1, and no seat proposed a release blocker for the
others to rate. Running it could not change the verdict. Stated here rather than implied.

| id | claimed | codex | opus | fable | counsel | seats | action |
|---|---|---|---|---|---|---|---|
| R5-01 read caps < write caps -> destructive read-modify-write | P1 | P2 | P2 | P2 | **P2** | 3/3 | demote-P2 |
| R5-02 update-add retry omits --health/--hide-diff | P2 | P2 | P2 | P2 | **P2** | 3/3 | keep-P2 |
| R5-03 four un-abortable reads outside both deadlines | P2 | P2 | P2 | P2 | **P2** | 3/3 | keep-P2 |
| R5-04 --hide-diff=true / --updates=true silently ignored | P2 | P2 | P2 | P2 | **P2** | 3/3 | keep-P2 |
| R5-05 SSH create drops empty --status=/--lead= | P2 | P2 | P2 | P2 | **P2** | 3/3 | keep-P2 |
| R5-06 quoted --name="NAME" retry template | P2 | drop | P2 | P2 | **P2** | 2/3 | keep-P2 (partly mitigated; claim text was stale) |
| R5-07 empty occurrence dropped from destructive replace | P2 | P2 | P2 | P2 | **P2** | 3/3 | keep-P2 |
| R5-08(a) blank --body-file now rejected on shipped cmds | P2 | P2 | P2 | P2 | **P2** | 3/3 | keep-P2 |
| R5-08(b) ORCA_CLI_SSH_REMOTE guard | P2 | fix | false-pos | fix | **drop** | 3/3 | drop — it is a fix, and it was already documented pre-branch |
| R5-09 UTF-8 BOM not stripped from --content-file | P2 | P2 | P2 | P2 | **P2** | 3/3 | keep-P2 |
| R5-10 cap slices mid-surrogate -> lone surrogate in --json | P2 | P2 | P2 | P2 | **P2** | 3/3 | keep-P2 |
| R5-11 256-reference cap exceeds the 30s deadline | P2 | drop | P2 | P2 | **P2** | 2/3 | keep-P2 |

## Verdict

**PASS WITH RISK — 0 P0, 0 P1, 10 P2 (one sub-claim dropped).** Nothing reverts.

## Corrections the counsel made to the coordinator's packet

- R5-01's premise "nothing warns the agent" is only half true. `skill-guides/orca-linear.md:128`
  and `src/cli/specs/linear-project.ts:131` DO warn that repeated `--member`/`--team`/`--label`
  replace the whole collection. What is genuinely missing is the *truncation* interlock.
- R5-06's quoted instruction was stale. The working tree at
  `src/main/runtime/linear-project-write-recovery.ts:167` now reads "...with the exact original
  text, **escaped for your shell**", which HEAD lacks. That is a partial mitigation; the
  pre-supplied double quotes still conflict with it.
- R5-08(b) is a fix, not a regression, and the SSH stdin-only restriction was already documented
  at `skill-guides/orca-linear.md` before this branch.
- R5-05's `--member=`/`--label=` half is weaker than claimed: an empty member set on *create* is
  observationally identical to no members. The `--status=`/`--lead=` half is the real divergence.
