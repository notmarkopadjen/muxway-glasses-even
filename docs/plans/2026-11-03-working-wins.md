# Feature: the harness's word wins over the screen's age

> Status: proposed. The owner's report of 2026-11-03: the glasses said
> `quiet 3m` for a pane the web showed working, with its ring turning.

## 1. Goal

The list's state word puts the screen's age before the harness's word:
a pane whose last event said `working` reads `working` only while its
screen changed in the last minute, and `quiet 3m` after. The core's
guideline (§1.2) and the web have it the other way: a named harness is
working from its last `working` event until its next event, and the
screen's age only adds to that (the web: changed in the last ten
seconds). A Claude Code pane in a long tool call draws nothing for
minutes and is working all the while; the owner saw `quiet 3m` on the
glasses and the ring on the web for the same pane.

The goal: the word says `working` from the harness's last `working`
event until the next event, whatever the screen does; `active` and
`quiet` stay for panes that said nothing. The attention still wins
over everything. The marks that follow the word (muxway-glasses-even#43)
turn for as long as the word says working.

Out of scope: a working pane whose harness died without a `done`
(nothing says so; the web has the same, and the host's watcher is the
core's to improve).

## 2. Design

`src/views.ts`, `stateWord`: the attention's word first, then `working`
while `p.working`, then the age. The app already clears `working` on
any other event for the pane (`onNotify`). One line moves; the table in
`docs/features/screens.md` loses "and the pane still moves".

## 3. Protocol and API changes

None.

## 4. Security analysis

None: the word comes from the hub's events as before.

## 5. Privacy check

The plan, the docs and the tests name the test environment's panes;
no host, person or secret.

## 6. Test plan

| # | Test | Kind (unit / e2e / e2e-security / UI) | Expected |
|---|------|---------------------------------------|----------|
| 1 | security | — | none new; S01–S50 run as they are |
| 2 | `stateWord` | unit | `working` with a silent screen (activity 90 s and 4 h old, and unknown); `done` over working; `active` and `quiet 4m` without the word |
| 3 | F42 | UI | the row says working after the event, unchanged |

## 7. Documentation

`docs/features/screens.md` (the state table and the sentence under it),
this plan.

## 8. Implementation steps

1. This plan.
2. The line, the test, the table; one commit.
3. The run on the pull request, recorded; the review below.

---

## Review (after implementation)

- [x] Diff matches the plan, deviations explained here
- [x] Security rules (AGENTS.md section 2) hold
- [x] Privacy check passed: `scripts/prepush-check.sh` clean and diff read
- [x] Docs and diagrams updated

Deviations: none. F42 and F15 passed locally with the unit tests
(20261103-194120-fb3094d) before the pull request's run.

## Test run

Link to the recorded run: result, commit, logs, screenshots.
