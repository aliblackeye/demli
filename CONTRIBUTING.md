# Contributing to Demli

Thanks for looking. Demli is a small, private-by-design voice app for friend groups,
and it is developed in the open.

## Licence, in one paragraph

Demli is licensed under the **GNU Affero General Public License v3.0** (see
[`LICENSE`](LICENSE)). Use it, read it, run it for your own friends, fork it. If you
modify it and let other people use it **over a network**, the AGPL requires you to
offer those users the source of your modified version. That is the whole deal: the
code stays open for everyone who touches it.

If that does not work for you commercially, a separate licence is available — see
[Commercial licensing](#commercial-licensing).

## Contributor Licence Agreement (CLA)

By opening a pull request you agree to the following. There is nothing to sign; the
act of contributing is the agreement.

1. **You wrote it, or you have the right to give it.** The contribution is your own
   work, or you have permission from whoever owns it, and it does not knowingly
   infringe anyone's rights. If your employer has rights to code you write, you have
   their permission.
2. **You grant a copyright licence.** You give the project maintainer a perpetual,
   worldwide, non-exclusive, royalty-free, irrevocable copyright licence to use,
   reproduce, modify, publish and distribute your contribution, **including the right
   to license it under terms other than the AGPL** (for example, a commercial licence
   as described below).
3. **You grant a patent licence.** Under the same terms, for any patent claims you
   own that your contribution would otherwise infringe.
4. **You keep your copyright.** This is a licence, not an assignment. Your name stays
   in the history and you can use your own work anywhere else you like.
5. **No warranty.** The contribution is provided as-is.

### Why a CLA at all

Without it, the project cannot offer anything other than the AGPL, because it would
not have the right to relicense your lines. One contribution without this permission
permanently closes that door. The CLA exists to keep the option open — not to take
your work away, which is why point 4 exists.

If you would rather not agree to point 2, say so in the PR. Small fixes can usually
be re-implemented independently, and that is a normal outcome, not a rejection.

## Commercial licensing

If you want to build on Demli in a way the AGPL does not permit — typically running a
modified version as a service without publishing your changes — contact the maintainer
to discuss a commercial licence.

## The name and the logo

The licence covers the **code**. It does not grant rights to the Demli name, wordmark
or logo — see [`TRADEMARK.md`](TRADEMARK.md). Short version: fork freely, ship it under
your own name.

## Practical notes

- Work branches off `dev`. `master` only receives releases.
- Before opening a PR: `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- Conventional commits (`feat(scope):`, `fix(scope):`, …).
- Secrets never enter the repo. `.env*` files are gitignored and stay that way.
