```
┌─ muxway-glasses-even ─┐
```

Even Realities G2 client for [muxway](https://github.com/notmarkopadjen/muxway): your tmux panes at a glance, and a word back when an AI coding CLI needs you.

> Early development. Runs in the Even Hub simulator; first builds for the glasses.

An Even Hub app: a page the Even phone app loads and that draws on the
glasses. It lists the panes your token may see, shows the last lines of
one, answers it from a fixed set of replies or with your voice, and
tells you when Claude Code in a pane asks a question or waits for a
permission. Settings and
free-text replies live on the phone, in the same app.

- [Screens and gestures](docs/features/screens.md)
- [Notifications](docs/features/notifications.md)
- [The Claude Code lens](docs/features/lenses.md)
- [The phone pane](docs/features/phone-pane.md)
- [Spoken replies](docs/features/spoken-replies.md)
- [Install](docs/features/install.md)
- [Architecture](docs/ARCHITECTURE.md)

## Build

Needs Node 22.

```sh
npm ci                                   # once
scripts/build.sh                         # dist/
scripts/pack.sh https://hub.example.com  # muxway.ehpk for the Even Hub portal, with your hub whitelisted
```

The hub must answer CORS preflights for bearer-token clients, which it
does since protocol v1 gained them (see the core's `docs/protocol/v1.md`).
Listings are read as JSON, pane content in text mode.

Contributors and AI agents: read [AGENTS.md](AGENTS.md) first.
Security issues: see [SECURITY.md](SECURITY.md).

## Tests

```sh
npm run test:unit                        # the lens, text fitting, protocol parsing, the answers
MUXWAY_CORE=../muxway scripts/e2e.sh     # everything
scripts/e2e.sh S05 F14                   # chosen tests
```

The suite builds the hub and agent from a checkout of the core
repository, starts a throwaway tmux server and a recording proxy that can
misbehave on purpose, serves the built page, and drives the Even Hub
simulator on a headless display through its automation API: a glasses
screenshot per step, the app's trace of every drawn page, the console. The
phone pane is tested in Chromium with Playwright. Each run writes
`test-runs/<id>/` with a summary, JUnit results, logs, screenshots, a
Playwright trace and `report/index.html`. Needs tmux, Xvfb, Go, Python 3,
Node 22, `libwebkit2gtk-4.1-0` for the simulator and Playwright's
Chromium (`npx playwright install chromium`).
