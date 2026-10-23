# Security policy

muxway gives remote access to terminal sessions. A flaw in it can hand an
attacker a shell, so security reports are handled first.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting
(the repository's Security tab, "Report a vulnerability"). Include what you
found, how to reproduce it, and the impact you expect. You will get an
answer within a week.

## Scope

Authentication, authorisation and grant enforcement, transport security,
input handling on the way into tmux, information leaks in responses and
logs, and the clients' storage of credentials.
