# Security policy

Demli carries real conversations for real people. If you find something that puts
those at risk, please tell us before you tell anyone else.

## Reporting a vulnerability

Use GitHub's private reporting:
**[Security → Report a vulnerability](https://github.com/aliblackeye/demli/security/advisories/new)**

That opens a thread visible only to you and the maintainer. Please do **not** open a
public issue for a security problem — a public issue is a working exploit notice for
every deployment that has not updated yet.

Helpful things to include, none of them required:

- what an attacker gets out of it (read someone else's messages? join a voice room
  they were not invited to? take over an account?)
- the steps to reproduce, and which surface — desktop, web, mobile, or the API
- the version or commit you tested

You will get a first reply within **72 hours**. This is one person's project, not a
company with an on-call rota; the honest promise is a quick acknowledgement and a
straight answer about whether it is being fixed and roughly when, not a same-day patch.

## Scope

In scope: anything in this repository, and the hosted instance at `getdemli.com`.

Please stay inside your own account and your own test servers while looking. Do not
read other people's messages, do not disrupt live voice rooms, and do not run load or
denial-of-service tests against the hosted instance — there are people talking on it.

Out of scope, because they are already known or are not defects:

- Missing rate limits on endpoints that already have per-user caps documented in code.
- Self-XSS, or attacks that require the victim to paste something into a devtools
  console.
- Reports produced only by an automated scanner, with no working reproduction.
- Anything requiring a rooted device plus physical access — the threat model does not
  cover an attacker who already owns the hardware.

## What we will do

- Confirm or reject the finding, with reasoning either way.
- Fix confirmed issues on `dev`, then ship to desktop, web and mobile.
- Credit you in the release notes if you want it, and skip the credit if you do not.

There is no bug bounty. If that changes it will be written here.

## For people self-hosting

Demli is AGPL and you are welcome to run your own. Two things that are yours to get
right and not ours:

- Secrets — LiveKit, database and storage credentials live in your `.env` files and
  never in the repository. `.env.example` shows the shape, never a real value.
- Updates — a self-hosted instance does not auto-update. Watch releases.
