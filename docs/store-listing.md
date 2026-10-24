# Store listing: muxway

Everything the Even Hub developer portal asks for, ready to paste.
Nothing here names a real host, person or key: the hub and the package
id are typed into the portal and into `scripts/pack.sh`.

## 1. Before you pack

| What | Where | Why |
|---|---|---|
| the `network` whitelist | `app.json` | the Even app lets the page reach only the hosts named here; `pack.sh` writes your hub's origin in, the committed file says `https://hub.example.com` |
| the `package_id` | `app.json` | the committed `com.example.muxway` is a placeholder; give `pack.sh` yours, and keep it from the first submission on, since a new id is a new app |

```sh
scripts/pack.sh https://<your hub> <your package id> muxway.ehpk
```

## 2. Manifest values

| Field | Value | Limit |
|---|---|---|
| `package_id` | yours, via `pack.sh` | reverse-domain, lowercase, three segments |
| `name` | `muxway` | 6 of 20 characters, no "Even" |
| `version` | `0.3.0` | three-part semver |
| `edition` | `202601` | exact |
| `min_sdk_version` | `0.0.15` | the SDK the page is built against |
| `min_app_version` | `2.2.10` | stamped by `evenhub pack` |
| `entrypoint` | `index.html` | in `dist/` |
| `supported_languages` | `["en"]` | |

## 3. Listing copy

**Name**: `muxway`

**Tagline** (43 / 50 characters)

```
Your tmux panes, and a word back, on the G2
```

**Description** (1843 / 2000 characters)

```
muxway puts your tmux panes on the Even G2: see what is running on your machines, read the last lines of a pane, and answer it, without reaching for a laptop.

It is a client for muxway, an open, self-hosted service: a small agent next to each tmux server exposes only the panes you mark, a hub you run connects your devices to them, and every connection is authenticated and encrypted. The glasses talk to your hub and to nothing else.

On the glasses, under a status line that counts the panes that need you:

- The pane list: every pane your token may see, those that need you first, with a mark, the name, the program and a word that says only what is known: asks a question, needs permission, done, idle, active, or quiet and for how long. A tap opens the pane under the cursor; a hold selects it.
- Side by side: hold two or three panes and open them in columns, each under its bold title, all following. The scroll opens one; a double tap comes back to the columns, and once more to the list.
- A pane: its last lines, following as they change, through a lens for Claude Code that keeps the conversation and hides the chrome; a position bar shows where you are in its history.
- Answers: a fixed set behind a confirmation: Enter, y, n, Claude Code's 1 2 3, Esc, Ctrl-C, Tab, Shift-Tab, the arrows. Or Say it: speak while a graph shows your voice, read the transcript back, send it.
- Notifications: when a pane needs you, a banner appears at the foot of whatever you are looking at, and the pane's menu takes you there.

Scroll moves, tap opens, hold selects (on a pane, the menu), double tap goes back. The phone screen holds the hub address, the token, a few settings and a box for typing longer replies.

No account, no analytics, no server of ours: you point the app at your own muxway hub, and spoken replies go to the transcriber you configured on it.
```

**Changelog** (0.4.0)

```
The pane list is the main screen: tap opens the pane under the cursor, hold selects it, and two or three selected panes open side by side; from the columns the scroll opens a pane and a double tap comes back. Every row says only what the hub knows: asks a question, needs permission, done, idle, active, or quiet and for how long. A reading row with moving dots until the first listing is in. Leaving the app is confirmed by the OS.
```

**Category**: Productivity (developer tools if offered)

## 4. Permission justifications

The `desc` strings in `app.json`; both permissions are used.

- **network**: Reads the tmux panes your muxway token may see and sends
  the answers you confirm on the glasses to the hub you set on the
  phone.
- **g2-microphone**: Records what you say when you choose Say it on a
  pane, and sends that clip to your muxway hub for transcription.
  Recording starts only on that action and stops when you tap, cancel
  or leave.

## 5. Backend domains

- **Your muxway hub**: the one host in the whitelist, run by you. It
  terminates TLS, checks the bearer token, enforces the token's grants,
  answers CORS for the WebView, and forwards spoken clips to the
  transcriber you configured, if any.
- **No other outbound host**: no analytics, no CDN, no font or script
  fetched at run time.

## 6. Reviewer access

A reviewer without a hub sees an unconfigured app. Stand up a throwaway
hub with synthetic panes from the core repository's test tooling (a
tmux server with a few shells, an agent, the hub behind TLS at a host
you own, a token that reads and writes them, a transcriber if you want
Say it reviewed) and put in the notes:

```
Setup: open the app on the phone, enter
  hub URL:  https://<review host>
  token:    <review token>
then tap "save & test" and open the app on the glasses.
Gestures: scroll = move or page, tap = open or answer, hold = select (on a pane,
the menu), double tap = back (and out of the app from the pane list, confirmed).
The hub above serves synthetic panes only; no real machine is reachable through it.
```

Keep it up until the review clears.

## 7. Screenshots

From the simulator against the test hub, 576 x 288, synthetic panes
(`alice-laptop`, `work/0.0`, a Claude Code fixture). Taken by
`scripts/store-shots.sh`.

| File | Shows |
|---|---|
| `store/shots/01-list.png` | the pane list: panes waiting first, with their words |
| `store/shots/02-selected.png` | two rows held, the open and clear rows under them |
| `store/shots/03-split.png` | two panes side by side, one marked |
| `store/shots/04-pane.png` | a pane, following, with its title band and position bar |
| `store/shots/05-lens.png` | Claude Code through the lens: the conversation, the typed box framed |
| `store/shots/06-answers.png` | the answers |
| `store/shots/07-listening.png` | listening, with the graph of your voice |
| `store/shots/08-heard.png` | the transcript read back in its box |
| `store/shots/09-banner.png` | a notification banner at the foot of a pane |
| `store/shots/10-phone.png` | the phone screen after save & test |

Pick `01`, `03`, `04`, `05`, `07`, `08` and `10` for the listing.

## 8. Icon

A terminal box with a prompt and a cursor, drawn from a pixel map by
`tools/icons.py`; white on black, greyscale only, hard edges.

| File | Size | Format | Use |
|---|---|---|---|
| `public/icon.png` | 24 x 24 | 8-bit grey | inside the package |
| `store/icon-512-foreground.png` | 512 x 512 | grey with alpha | portal foreground |
| `store/icon-512-background.png` | 512 x 512 | 8-bit grey, black | portal background |
| `store/icon-512.png` | 512 x 512 | 8-bit grey | flattened |

## 9. QA self-check

| Check | Where it stands |
|---|---|
| no black screen on launch; setup explained | the head says `set the hub and token on the phone`; the phone pane explains the gestures |
| settings persist | `localStorage` and the Even app's store (`src/settings.ts`) |
| five-minute locked-phone test | on a beta install, by hand |
| root double tap exits | `shutDownPageContainer` from the pane list (`src/app.ts`, `back`) |
| responsive after two minutes idle | polling restarts on foreground enter and on any gesture |
| CORS on the backend | the hub answers preflights on the bearer-token endpoints (protocol v1) |
| no unused permission | network and the microphone are both used |
| content safety | panes are the operator's own terminals; nothing medical, financial or emergency |

## 10. Sources

- App Submission & QA Guidelines (hub.evenrealities.com/docs/reference/app-submission)
- Beta Testing (hub.evenrealities.com/docs/test/beta-testing)
