# Feature: the store listing pack

> Status: approved 2026-10-24, in progress.

## 1. Goal

Everything the Even Hub developer portal asks for when the app is
submitted, ready to paste, and a template so the next client (and the
next version) fills the same form the same way. Modelled on the owner's
Build Agents submission pack, which went through review.

Out of scope: the submission itself, which is a person dragging the
package into the portal; a marketing site.

## 2. Design

Three pieces:

- **`docs/templates/store-listing.md`**: the template. Sections in the
  portal's order: the manifest values with their limits (name under 20
  characters and without "Even", three-part version, the edition, the
  SDK floor), tagline (50) and description (2000) with character counts,
  the changelog that every version needs, category, a justification per
  permission that matches its `desc` in the manifest, backend domains
  (the operator's own hub, nothing else), reviewer access with a
  throwaway environment, the screenshot table, the icon table, and the
  QA self-check the reviewers run (no black screen, settings persist,
  the five-minute phone lock, root double tap exits, responsive after
  idle, CORS, no unused permission, content safety).
- **`docs/store-listing.md`**: the template filled for this app, with
  the description written for the listing, the first changelog, the
  permissions as in `app.json`, and reviewer notes that stand up the
  test hub from the core repository with synthetic panes.
- **Assets**: `store/` with the icon in the portal's sizes (24 px for the
  package in `public/icon.png`, 512 px foreground, 512 px background,
  flattened 512 px), drawn by `tools/icons.py` from a pixel map as the
  Java ME client's icon is: a terminal box with the muxway mark, white
  on black, greyscale only, no colour, as the guidelines require; and
  `store/shots/` with the listing's screenshots, taken from the
  simulator against the test hub by `scripts/store-shots.sh`, which
  runs the chosen end-to-end tests and copies their captures under
  listing names (`01-panes.png` … `08-phone.png`). Synthetic content
  only: `alice-laptop`, `work/0.0`, the Claude Code fixture.

The pack script already stamps the manifest; the listing says which two
values the owner changes before packing (hub, package id) and why the
package id must not change after the first submission.

## 3. Protocol and API changes

None.

## 4. Security analysis

- Screenshots come from the test environment only; the script refuses to
  run against anything but the harness.
- The listing names the hub only as "your hub"; the owner's host and
  package id are typed into the portal, never into the repository.
- Reviewer access is a throwaway hub with synthetic panes and a token
  that reads them; it reaches no real machine.

## 5. Privacy check

The filled listing uses placeholders; the icon is drawn, not taken from
a logo of a company; the screenshots show synthetic panes.

## 6. Test plan

| # | Test | Kind | Expected |
|---|------|------|----------|
| 1 | `tools/icons.py` output | unit (script check) | 24 px 8-bit greyscale, 512 px greyscale with alpha, 512 px opaque black; no colour channel |
| 2 | `scripts/store-shots.sh` | script | eight PNGs of 576 x 288 (and the phone one) from a fresh run, names as in the listing |
| 3 | The listing's counts | script | tagline ≤ 50, description ≤ 2000, name ≤ 20 without "Even" (`scripts/check-listing.py`, run by the e2e script) |

## 7. Documentation

The template and the listing are the documentation; `README.md` gets a
line pointing at the pack and the listing; `docs/features/install.md`
links the listing's submission steps.

## 8. Implementation steps

1. `tools/icons.py`, the icons, `public/icon.png` in the package.
2. The template.
3. `scripts/store-shots.sh` and the screenshots.
4. The filled listing and `scripts/check-listing.py`.

## Decisions

- 2026-10-24: plan approved.

---

## Review (after implementation)

- [ ] Diff matches the plan, deviations explained here
- [ ] Security rules (AGENTS.md section 2) hold
- [ ] Privacy check passed: `scripts/prepush-check.sh` clean and diff read
- [ ] Docs and diagrams updated

## Test run

Pending.
