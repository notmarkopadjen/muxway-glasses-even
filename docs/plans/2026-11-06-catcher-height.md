# Feature: the catcher is as tall as its line, so every scroll is reported

> Status: implemented, awaiting the owner's device check. The owner's report of 2026-11-06 with 0.9.1: a scroll
> in the direction opposite to the last one does nothing the first time
> and works the second; the phone log shows no `gesture text` line for
> the lost ones. On top of the catcher plans (`2026-11-03-gestures.md`,
> `2026-11-06-pane-catcher.md`).

## 1. Goal

The SDK's two scroll events are `SCROLL_TOP_EVENT` and
`SCROLL_BOTTOM_EVENT`: the firmware scrolls the text of the container
that takes the gestures and tells the app when that text is at its
top or its bottom. The app's catcher is an unseen square of 16 × 16 px
holding one blank line, and a line is 28 px, so the square has 12 px
of scroll room: the first scroll in a new direction moves the blank
line inside the square and reports nothing, the next one reaches the
edge and is reported. The hint, which took the gestures before, was a
30 px box around one line (2 px of room, less than a step), so every
scroll of it was at an edge and reported, and the footer moved by those
two pixels, which is what the catcher was made to stop. The list page
has had the corner catcher since #51 and the pane and the columns since
#81, which is why the scroll felt laggy at times before and on every
page now.

The goal: the catcher holds its one blank line with no room to scroll,
so every scroll is at an edge and reaches the app, on every page.

## 2. Design

`src/views.ts`: the catcher is `CATCH` (16) px wide and `LINE_H` (28)
px tall, from the top edge, in the top right corner as before. Nothing
else changes: every block beside it ends at `CANVAS_W - CATCH - 4` or
less, the title rows at 26 px are beside it, not under it, and the
list's rows block starts at x = 2 and ends short of the corner. The
unit test of the catcher expects 16 × 28 and keeps the corner free of
every other block down to 28 px.

```
┌──────────────────────────────────────────────────────────┐▪
│ ◐ build · /muxway · Claude            following          │▪  ← the catcher, 16 × 28, one blank line, no room
├──────────────────────────────────────────────────────────┤
```

The simulator reports every scroll whatever the catcher's size, so the
suite is the same before and after; the device is the check.

## 3. Protocol and API changes

None.

## 4. Security analysis

None: layout only, 12 pixels of an unseen block.

## 5. Privacy check

The plan and the test name nothing of the owner's.

## 6. Test plan

| # | Test | Kind (unit / e2e / e2e-security / UI) | Expected |
|---|------|---------------------------------------|----------|
| 1 | the catcher | unit | 16 × 28 at 560, 0 on every page without an OS list; no other block reaches the corner above y = 28 |
| 2 | every page above the banner | unit | unchanged |
| 3 | F10, F11, F33 (a scroll on the list, the pane, the columns) | UI | unchanged |
| 4 | the device | by hand, recorded here | the owner scrolls down twice and up once on the list and on a pane: every scroll moves the cursor or the page, the first in a new direction too; the phone log has a `gesture text` line per scroll |

## 7. Documentation

`docs/ARCHITECTURE.md` (the catcher is one line tall, 16 × 28, since
the device reports a scroll only at the text's edge and a shorter box
leaves room for a silent one), this plan.

## 8. Implementation steps

1. This plan.
2. `src/views.ts`: the catcher's height; the unit test.
3. The docs.
4. F10, F11 and F33 locally, the pull request's run, the owner's device
   check, recorded below.

---

## Review (after implementation)

- [x] Diff matches the plan, deviations explained here
- [x] Security rules (AGENTS.md section 2) hold
- [x] Privacy check passed: `scripts/prepush-check.sh` clean and diff read
- [x] Docs and diagrams updated

Deviations: one. The rule under the title is two pixels at y = 26 to
28 across the whole width, and the catcher at 28 px tall now reaches
y = 28 in the corner, which the unit test caught as an overlap once the
branch was rebased on the pane fix (#81). The rule ends at the
catcher's corner, `CANVAS_W - CATCH` = 560 px wide, so the two touch
and do not overlap, as the body and the hint touch at the banner's top.

## Test run

Run 20261106-190602-f3c59d6, local, against the core's main: F10, F11
and F33 passed with the secret scan, none failed; the unit suite (83)
passed. After the rebase on #81 and the rule's end at the corner: run
20261106-191111-d997826, F10, F11, F32 and F33 passed, the unit suite
(83) passed. The owner's device check (test 4) is recorded here when it is
done.

## The pull request's run

Run 42353697404 on the pull request failed S65 and F68, both exposed by
the simulator's fast start (the no-session-bus fix in this branch): with
its first page 25 s earlier, the app's first listing comes within ten
seconds of the test panes' creation, when a fresh pane's own screen reads
as working, and reads as quiet only at the second listing.

- F68 waited for the pane quiet, typed its loop, and then accepted a page
  drawn before the loop: `Sim.expect` reads every page since the mark,
  newest first, and the first listing's working pages were still there.
  The idle then landed on a pane no listing had seen move and drew its
  banner. The test marks the trace after the quiet page, so only a page
  drawn after the loop counts as working from the screen.
- S65 counted the CORS preflight as a read, and the wait after an
  unreadable recent answer never doubled: a `200` reset it to five
  seconds before the cursor was checked, so the app asked every five
  seconds and a fourth read fell in the test's window. `runEvents` resets
  the wait only on an answer with a cursor, as
  `docs/features/notifications.md` says (five seconds, doubling); the
  proxy's `paths` takes a method and S64 and S65 count `GET`s.
- The trace and console logs of a test that restarts the app are
  appended, so a second simulator's no longer replace the first's (F68's
  trace in the run directory was the restart's alone).

Run 20261107-093123-d4e10b4, local, against the core's main: S06, S64,
S65 and F68 passed. Run 20261107-093311-d4e10b4, the full suite: 147
tests passed, none failed; S65 read the recent events after five and then
ten seconds. The unit suite (89) passed.
