```
┌─ muxway-glasses-even ─┐
```

Even Realities G2 client for [muxway](https://github.com/notmarkopadjen/muxway):
your tmux panes at a glance, and a word back when an AI coding agent needs
you.

![Claude Code through the lens: the conversation, no chrome](store/shots/05-lens.png)

On the Even Hub store: to be provided. Anyone can pack it themselves
with `scripts/pack.sh`, as [Build](#build) says.

> Worn daily on the G2. Runs in the Even Hub simulator for development.

An Even Hub app: a page the Even phone app loads and that draws on the
glasses. It lists the panes your token may see, shows the last lines of
one, answers it from a fixed set of replies or with your voice, and
tells you when an AI coding agent in a pane asks a question or waits
for a permission. Settings and free-text replies live on the phone, in the
same app.

## What it does

- **The pane list**, panes that wait for you first, each with its word:
  *asks a question*, *needs permission*, *done*. Scroll moves, tap opens,
  hold selects two for side by side.
- **A pane**, following its tail, or two panes in columns.
- **The Claude Code lens** reshapes Claude Code's screen for eight short
  lines: the conversation stays, the chrome goes, and whatever Claude
  suggests in its input box is offered as the first answer.
- **Answers**: a question's own choices first (`muxway ask`), then
  Enter, `y`, `n`, numbered choices, a few keys; or **say it**, read the
  transcript back on the glasses, and send.
- **The inbox**: every pane that waits, on every host, oldest first, one
  row away from the list.
- **A banner** at the foot of whatever you are reading when a pane needs
  you, and *go to* from the menu.

Every AI coding CLI muxway knows (Claude Code, Codex, Gemini,
Antigravity, OpenCode, Copilot and the rest) is named in the list and
reports its state through its hooks or the host's watcher; a question it
asks with fixed answers (`muxway ask`) is answered from the glasses with
a tap, and the **inbox** lists what waits across hosts, oldest first.
Only the Claude Code lens reshapes a screen; Claude Code is the harness
tested on the device.

<p>
<img src="store/shots/01-list.png" alt="The pane list, panes waiting first" width="288">
<img src="store/shots/06-answers.png" alt="The answers, Claude Code's suggestion first" width="288">
</p>
<p>
<img src="store/shots/07-listening.png" alt="Listening, with the graph of your voice" width="288">
<img src="store/shots/09-banner.png" alt="A notification banner at the foot of a pane" width="288">
</p>

- [Screens and gestures](docs/features/screens.md)
- [Notifications](docs/features/notifications.md)
- [Lenses: every harness named, the Claude Code lens](docs/features/lenses.md)
- [The phone pane](docs/features/phone-pane.md)
- [Spoken replies](docs/features/spoken-replies.md)
- [Install](docs/features/install.md)
- [Architecture](docs/ARCHITECTURE.md)

The other clients, and the hub: [muxway](https://github.com/notmarkopadjen/muxway)
(web client, protocol),
[muxway-android](https://github.com/notmarkopadjen/muxway-android),
[muxway-midp](https://github.com/notmarkopadjen/muxway-midp).

## Build

Needs Node 22.

```sh
npm ci                                   # once
scripts/build.sh                         # dist/
scripts/pack.sh https://hub.example.com  # muxway.ehpk for the Even Hub portal, with your hub whitelisted
```

The hub must answer CORS preflights for bearer-token clients, which it
does since protocol v1 gained them (see the core's `docs/protocol/v1.md`).
Listings and events are read as JSON, pane content in text mode.

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
Chromium (`npx playwright install chromium`). The screenshots above are
the store listing's, taken by `scripts/store-shots.sh` from such a run.

Contributors and AI agents: read [AGENTS.md](AGENTS.md) first.
Security issues: see [SECURITY.md](SECURITY.md).

[Apache License 2.0](LICENSE), like the rest of muxway.
