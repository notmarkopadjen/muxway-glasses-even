# The phone pane

The page the Even app shows on the phone while the app runs. It is the
only place a token is typed, and the way to send free text to a pane.
Green on black, monospace, box frames: a terminal, as every muxway UI.

## Hub

| Field | Meaning |
|---|---|
| hub URL | `https://` required; `http://` only for `localhost`, `127.0.0.1` and `::1`; no user name, path, query or fragment |
| token | pasted once, then stored; the field is a password field, empty after saving, and says `stored` |
| follow every | seconds between reads of the open pane while following, 1 to 30, default 3 |
| lines | rows asked from the hub per read, 50 to 500, default 200 |
| text | Latin-1 (default: every glyph the font has) or Unicode |
| Claude Code lens | on by default; see [lenses](lenses.md) |
| Spoken replies | on by default; offered on the glasses when the hub has a transcriber; see [spoken replies](spoken-replies.md) |

**save & test** checks the URL and the token, stores them and calls
`GET /v1/me`; the status line says how long the hub took, the token's
name and whether the hub has a transcriber, never the token. **test** repeats the call. **forget token**
deletes the token from the phone.

Settings are one JSON record under one key in the WebView's
`localStorage` and in the Even app's own key/value store, which survives
a wipe of the WebView's storage.

A page served from loopback (the simulator, the test harness) also takes
settings from its own URL (`?hub=…&token=…&every=…`), stores them and
strips them from the address. A packed or sideloaded app never does: the
status line says `settings in the URL are ignored here`.

## Reply

A text box for the pane that is open on the glasses; the line above it
names that pane, or says to open one first. **send ⏎** posts the text and
then `Enter`; **type only** posts the text alone. Control characters are
removed and the text is cut to 4096 bytes before it goes, since the hub
refuses both. The glasses flash `sent from the phone ⏎` in the head and
read the pane at once.

## Log

The last forty lines of what the app did: status codes, byte counts and
timings (`GET pane 304 0 chars 80 ms`, `event permission on build`),
what failed and in which words. Never a token, never pane content, never
an event's text.

## Security considerations

- The token can type into a shell. It is stored on the phone, in the Even
  app's storage, readable by anyone with the unlocked phone and the app.
  A token per pair of glasses, scoped to the panes it needs, read-only
  unless answering is the point, short-lived, revoked when the phone or
  the glasses are lost.
- A refused token (`401`) is deleted at once and the glasses say so;
  nothing retries it, so the app cannot lock its own network out (ten
  failures in ten minutes lock an address for ten minutes).
- The URL rules keep the token off plain HTTP on the internet. The query
  path is loopback-only.
- The token is never shown after saving, never logged, never part of an
  error message, never in a URL.
