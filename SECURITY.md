# Security policy

muxway gives remote access to terminal sessions. A flaw in it can hand an
attacker a shell, so security reports come before everything else.

## Reporting a vulnerability

Do not open a public issue, and do not describe the flaw in a pull
request. Use one of these:

- GitHub's private vulnerability reporting: the repository's **Security**
  tab, *Report a vulnerability*.
- E-mail: `<security contact e-mail: to be provided>`. Encrypt to the
  PGP key `<fingerprint: to be provided>` if the report contains an
  exploit or a captured token.

Say what you found, how to reproduce it (a request, a pane name, a
screen), what it gives an attacker, and which commit or release you
tested. A proof of concept against your own hub and host is welcome;
never against someone else's.

## What to expect

| Step | Within |
|---|---|
| Acknowledgement | `<N>` days (target: 3) |
| First assessment and severity | `<N>` days (target: 7) |
| Fix or mitigation for a high or critical finding | `<N>` days (target: 30) |
| Public disclosure | after the fix is released, or `<N>` days after the report (target: 90), whichever comes first, agreed with you |

Credit goes in the release notes and `<the acknowledgements page: to be
provided>` if you want it; say so in the report.

## Supported versions

| Version | Supported |
|---|---|
| `main` | yes |
| the latest release | yes |
| anything older | no: upgrade first |

## Scope

The Even Hub app in this repository, on the glasses and on the phone.
Reports are most welcome on:

- how the hub URL and the token are kept in the phone app and in the
  packed `.ehpk`, and whether they can leak to another app or page;
- what a hostile pane's content can do to the app (injection, crashes,
  spoofed names or states, a suggestion that sends more than shown);
- what is sent to a pane from the glasses, and whether anything can be
  sent without a gesture;
- the test build's query parameters and the simulator-only paths reaching
  a production build.

The hub, the agent and the protocol are in
[muxway](https://github.com/notmarkopadjen/muxway); report flaws there to
that repository.

Out of scope: the Even Hub platform itself, denial of service against your
own hub, and social engineering.

## Safe harbour

Research done in good faith against your own installation, within this
policy, will not be reported to anyone or met with legal action by the
maintainers. `<legal wording to be confirmed by the owner>`
