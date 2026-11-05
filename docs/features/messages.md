# Messages and mail

Panes talk to panes: an agent types into another pane naming the pane it
came from, or leaves a [mail](https://github.com/notmarkopadjen/muxway/blob/main/docs/features/mail.md)
for the other's process, held by its host and never typed. The hub keeps
the record of both, the [talk feed](https://github.com/notmarkopadjen/muxway/blob/main/docs/features/talk.md),
and the glasses show it the way nine rows of one font allow: a messages
page for the feed, a mail page for one pane's mailbox, and a way to mail
a pane, or mail back whoever wrote to it, with your voice or from the
phone. Nothing here is a notification: no banner, no row in the inbox.

## The messages page

```
  test-pane → tests · 3m
    echo hi
  reviewer → build · 2m · mail
    one more thing: the docs
> build → review · 1m · reply
      all green

messages · 3 · ▽ move · ● the mail · ×× back
```

The feed, `GET /v1/talk`, is read with every listing: the first time the
hub's most recent fifty entries, then what is newer than the cursor,
every ten seconds. The glasses keep two hundred entries. While the feed
holds anything the list has a row under the inbox row, `» messages`,
and `» messages · mail 3` while three entries arrived that were not
looked at; a tap opens the page and clears the count. A hub that nobody
talks on spends no row.

An entry is its head row, who → whom and the age, with ` · mail`,
` · reply`, ` · key` or ` · answer` after it (a typed text has no word),
then its text under it, indented, over at most three rows, the third
ending in `…` when there was more (the hub gives two hundred characters
at most). A reply sits one step further in than what it answers, when
that mail is on the page. Names are the pane's alias in the entry, else
the pane's name from the listing by its id and then by its address,
else the address without the host; a mail from a client that is not a
pane is named by the token that sent it. Oldest at the top, the page
opens with the cursor on the newest entry. The scroll moves by entry; a
**tap** on a mail entry opens the [mail page](#the-mail-page) of the
pane it went to, on that mail, and on a typed entry lays the two panes
side by side, the columns of the [screens](screens.md#side-by-side)
with nothing marked; the hint says which (`● the mail`, `● side by
side`), and `a pane is gone` when one of them left the listing. A
double tap goes back.

From the mail page's menu the same page shows one pane's exchanges,
`messages · build`: the entries it wrote or received.

## The mail page

```
> ← review · 3m · unread
    run the tests on the branch and tell me what fails
  → review · 2m · cut
    all green, the docs are updated and the branch is ready for …

mail · build · 1 unread · ▽ move · ● mail back · ≡ menu · ×× back
```

**Mail** in the pane page's menu, on a host whose agent holds mail
(`hosts[].mail`), opens the pane's mail: `GET /v1/panes/{address}/mail`
when the page opens and with every listing while it is open. What came
in is the mailbox, `←`, the sender, the age, `unread` until the process
read it, `replied` when the pane answered it. What went out is the
feed's mail entries from this pane, `→`, the recipient, the age, and
`cut` where the feed's two hundred characters are not the whole text
(reading the recipient's mailbox for the rest would be a request per
mail, which the glasses do not spend). Merged by time, oldest at the
top, the cursor on the newest. Reading the page marks nothing read: the
process does, through its hooks or `muxway mail`.

The menu: **Mail build**, a mail to the open pane (a writer, on a host
that holds mail), and **Messages with build**, the feed's entries of
this pane. A **tap** on a received mail whose sender is a pane in the
listing the token may write is **mail back** to that pane; on any other
entry the tap does nothing and the hint has no `● mail back`.

## Mail the open pane, mail back

A mail is text for the pane's process, `POST /v1/panes/{address}/mail`,
never typed. The text comes from your voice or from the phone, and
every mail passes the Cancel / Confirm page.

```mermaid
sequenceDiagram
    participant O as Owner
    participant G as Glasses
    participant P as Phone pane
    participant H as Hub
    O->>G: pane menu, Mail
    G->>H: GET /v1/panes/alice-laptop/work/1.0/mail
    H-->>G: the mailbox; the feed's entries from the pane are held already
    G->>G: the mail page, the newest under the cursor
    O->>G: tap on "← review · unread"
    G->>G: listening (the mic), heard this, a tap
    G->>G: Cancel / Confirm: mail this to review?
    O->>G: Confirm
    G->>H: POST /v1/panes/alice-laptop/work/0.0/mail {"text": "..."}
    H-->>G: 201 {"mail": {"id": 8}}
    G->>G: "mailed review", the mail page read again
    O->>P: types in the reply box, taps mail
    P->>G: the text, for the pane the glasses aim at
    G->>G: Cancel / Confirm: mail this to review? "the first words…"
    O->>G: Confirm
    G->>H: POST .../mail
```

- **Say it.** The listening and heard pages of a [spoken
  reply](spoken-replies.md), titled `for mail to review`, the hint
  `● mail`, the menu *Say it again* only. A tap on the heard page opens
  the Cancel / Confirm page, `mail this to review?`; Confirm posts, the
  words `mailed review` land on the pane's state or in the hint, and
  the mail page is read again. Without a transcriber the hint says so
  and the phone is the way.
- **The phone.** The reply box's third button, **mail**, sends the text
  to the glasses for the pane they aim at: the sender of the received
  mail under the cursor on the mail page, else the open pane, where
  its host holds mail; the *to* line on the phone names it (`mail to
  review`). The glasses show Cancel / Confirm with the first words in
  the hint, `mail this to review? "run the tests…"`, and Confirm
  posts; the whole text is on the phone, where it was typed.

The hub refuses what it refuses, in words on the glasses: `read only`
when the token may not write the target, `mailbox full` after fifty
mails held for the pane, `not found` from an older host. The text is
cleaned of control characters, newlines kept, and cut to 4000
characters, the agent's cap.

## Beside

**Beside: review** in the pane page's menu, on a pane that talked with
another in the last ten minutes (the listing's `talk`, its newest
partner that is in the listing), opens the columns with the two, the
open pane first, nothing marked; the pair becomes the list's selection,
as a hold would have made it, and a double tap comes back to the pane.

## Security considerations

- **Nothing is sent from the feed or a mailbox.** Their entries are
  drawn; a tap on one opens a page or the columns of panes taken from
  the listing by address, never from the entry's words.
- **What crosses the boundary** is checked: every address in the feed
  and the mailbox passes the address grammar or the entry is dropped;
  seqs, ids and times are integers within range; texts are cleaned and
  cut (200 and 4000 characters), then wrapped and clamped to the row's
  63 bytes and 490 px before the firmware sees them; actors' names are
  32 characters at most; a hundred entries per read, two hundred kept,
  fifty mails shown. A hostile feed or mailbox puts words on a page and
  nothing more (S61).
- **Grants.** The hub shows the feed only where the token reads both
  panes; the mailbox needs the read grant; a mail needs the write grant
  and a writable pane, checked by the hub, and the glasses never send a
  `from`, so a reply can land nowhere but where the hub puts a mail. A
  reader sees the pages and has no way to mail (S60); a proxy that
  calls a pane writable earns `403 read only` (S62).
- **Every mail is confirmed** on a page that names the target, after
  the heard page showed every word of a spoken one; the phone's text is
  on the phone.
- **Logged:** `mailed review, 42 bytes` and a failure's status; never
  the text, on the glasses or the phone. The hub and the host audit
  every mail with its length and id.
