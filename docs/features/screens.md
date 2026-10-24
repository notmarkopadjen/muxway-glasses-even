# Screens and gestures

Three gestures and the menu reach everything:

| Gesture | Does |
|---|---|
| scroll | moves the highlight in a list; pages the pane |
| tap | opens the highlighted row; on the pane, opens the answers (or reads it again when it is read-only) |
| tap, then hold | the OS menu: Refresh, Reveal all / Lens on, Bottom, Panes, Needs you |
| double tap | back one page; out of the app from the pane list |

Every page has the same frame: a head line, the body, and a hint line that
names the gestures that work there.

## Panes

```
muxway · 3 panes · 1 needs you
┌──────────────────────────────────────────┐
│ ★ build · claude                          │
└──────────────────────────────────────────┘
  · work/0.0 · bash
  ● tests · bash · read-only
▽ choose · ● open · ×× exit
```

One row per pane the token may read, from `GET /v1/panes` in text mode:
the pane's **mark**, its **name**, its **program**, and `read-only` when
the token may not write to it. The name is the title the program gave the
pane, or `session/window.pane` when the title says nothing (it is empty,
or the program's name, or the host's). The mark is the pane's attention:
`★` a question or a permission (needs you), `●` done, `○` idle, `·`
nothing. Panes that need you come first, then by address. The head says
how many panes and how many need you, or what went wrong (`no
connection`, `token refused · set it on the phone`). More than nineteen
panes: the twentieth row is `→ next n more`. The list is read again every
10 s and after every event.

## Pane

```
★ build · claude · needs permission
  ● Bash(make test)
    ok
  * Crunched for 12s . done 8:41 PM
  > y
▽ page · ● answer · ≡ menu · ×× back
```

The head: the mark, the name, the program, and the state: the attention
in words (`asks a question`, `needs permission`, `idle`, `done`), else
`following`, `paused · 2 pages up`, `reading…`, or the error (`host
offline`, `no connection`, `not found`). After an answer the head flashes
what happened for a few seconds: `sent y ⏎`, `read only`.

The body is the last lines of the pane, `GET /v1/panes/{address}` in text
mode with `lines` (setting, default 200) and `width=400`, so the rows come
unwrapped and the app wraps them by pixels to the glasses' width: at
spaces where it can, inside a word where it must, so nothing is lost. The
[lens](lenses.md) shapes the rows first. Eight lines fit; with a pinned
block, six and two.

- **Following**: at the bottom, the pane is read every *follow* seconds
  with `If-None-Match`, and a `304` costs nothing on the glasses.
- **Scroll up** pages back and pauses following; **scroll down** pages
  forward, and past the last page following resumes.
- **Tap** opens the answers on a writable pane; on a read-only pane it
  reads the pane again (the hint says `refresh`).
- **Menu**: Refresh (the pane and the list), Reveal all / Lens on, Bottom
  (back to following), Panes, and Needs you: *name* when some other pane
  has attention.
- **Double tap** goes back to the list.

## Answers and confirmation

```
answer build                          send y ⏎ to build?
  ⏎ Enter                               Cancel
  y ⏎                                   Confirm
  n ⏎
  1 · Claude Code's first choice
  2 · second choice
  3 · third choice
  Esc
  Ctrl-C
  Tab
  Shift-Tab
  ↑ Up
  ↓ Down
▽ choose · ● pick · ×× back
```

When the hub has a transcriber the list opens with **» Say it**, which
leads to the [spoken reply](spoken-replies.md) pages.

A fixed set, in that order. `y ⏎` and `n ⏎` send the letter and then
`Enter`; `1`, `2` and `3` send the digit alone, which is how Claude Code
takes a choice on a question or a permission prompt; the rest are the
protocol's keys (`Enter`, `Escape`, `C-c`, `Tab`, `BTab`, `Up`, `Down`).
Nothing else can be sent from the glasses: free text comes from the
[phone pane](phone-pane.md).

A tap on an answer opens the confirmation, a two-row list with **Cancel**
first and highlighted. Confirm posts to `POST /v1/panes/{address}/input`,
one request per piece, goes back to the pane, reads it at once and
flashes the result in the head. A double tap on either page goes back
without sending.

## Security considerations

- The glasses send only the answers above, each after a confirmation; a
  mis-tap cannot send `Ctrl-C` to a running build. Keys are the
  protocol's names, text is one to four printable characters.
- Whether a pane may be written to comes from the hub's mode column; a
  title cannot forge it, and a hub or proxy that lies about the mode gains
  a refused request (`403 read only`).
- Rows are clamped by pixels and by bytes before they reach the firmware,
  so a hostile title cannot reject the page; the mark comes from the
  attention column, never from the title.
- The head and the hint never carry the token or an error body, only the
  status in words.
