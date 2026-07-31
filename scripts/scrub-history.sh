#!/usr/bin/env bash
# Rewrite git history to remove `.claude/reports/` before the repo goes public.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
# ---------------------------------------------------------------------------
# A screenshot committed under `.claude/reports/` showed a production password in
# plain text: an adb-driven UI probe typed the username and the password into the
# SAME field, so the masked PASSWORD box sat empty while the USERNAME box printed
# the secret. A second frame carried a live invite code.
#
# Both were removed from the working tree, and the account they belonged to was
# frozen on production with `purge_at` NULL (the freeze had to be outside the
# 14-day recovery window, or anyone holding the password could have walked back in
# with `reactivate: true`). So the leak is already neutralised — this script is
# about the repository going PUBLIC, where every commit becomes readable and a
# deleted file is still one `git show` away.
#
# The lesson worth carrying: no pattern scan found it. Grep cannot read a PNG. It
# was found by opening the images. `.claude/reports/` holds 213 tracked files
# across 178 commits, including ~100 screenshots and a great deal of internal
# agent argument — none of it is worth auditing frame by frame when the whole
# directory can simply not be published.
#
# ---------------------------------------------------------------------------
# BEFORE YOU RUN THIS
# ---------------------------------------------------------------------------
#  - Every commit id changes. Anything referencing an old SHA (an issue comment, a
#    bookmark, a note in a doc) stops resolving.
#  - There is exactly ONE developer machine and the VPS. The VPS deploy does
#    `git fetch && git reset --hard origin/dev`, which accepts rewritten history
#    without complaint — verified before writing this. No re-clone anywhere.
#  - Unmerged branches must be merged FIRST. A branch left on the old history is
#    stranded: its commits no longer share ancestry with the rewritten trunk.
#  - `filter-repo` deliberately drops the `origin` remote after rewriting, to stop
#    a reflex `git push` from doing something irreversible. This script re-adds it
#    and stops, leaving the force-push as a separate, deliberate command.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TARGET_PATH=".claude/reports"

fail() { echo "" >&2; echo "STOPPED: $*" >&2; exit 1; }

echo "== 1. Preconditions =========================================="

[[ -z "$(git status --porcelain)" ]] || fail "the working tree is dirty. Commit or stash first."

CURRENT="$(git rev-parse --abbrev-ref HEAD)"
[[ "$CURRENT" == "dev" ]] || fail "on '$CURRENT'; run this from dev."

git fetch origin --quiet
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/dev)" ]] ||
  fail "dev and origin/dev differ. Push or pull first — rewriting a diverged branch loses work."

# Unmerged branches would be stranded on the old history.
STRANDED=""
for b in $(git branch --format='%(refname:short)' | grep -v '^dev$'); do
  git merge-base --is-ancestor "$b" origin/dev 2>/dev/null || STRANDED="$STRANDED $b"
done
[[ -z "$STRANDED" ]] || fail "these branches are not merged into dev and would be stranded:$STRANDED
  Merge or delete them, then re-run."

WORKTREES="$(git worktree list | tail -n +2 | wc -l)"
[[ "$WORKTREES" -eq 0 ]] || fail "$WORKTREES worktree(s) still attached. filter-repo refuses to run with them:
$(git worktree list | tail -n +2)
  Remove them with 'git worktree remove --force <path>' once their work is merged."

python -m git_filter_repo --version >/dev/null 2>&1 ||
  fail "git-filter-repo is not importable. Install it: pip install git-filter-repo"

BEFORE_COMMITS="$(git rev-list --all --count)"
BEFORE_HITS="$(git log --all --oneline -- "$TARGET_PATH" | wc -l)"
echo "   commits: $BEFORE_COMMITS   commits touching $TARGET_PATH: $BEFORE_HITS"
[[ "$BEFORE_HITS" -gt 0 ]] || fail "no commit touches $TARGET_PATH — nothing to do."

echo ""
echo "== 2. Backup =================================================="
# A full mirror beside the repo. filter-repo also leaves its own backup in
# .git/filter-repo/, but an independent copy is cheap and this is irreversible.
BACKUP="$REPO_ROOT/../demli-backup-before-scrub.git"
[[ -e "$BACKUP" ]] && fail "backup already exists at $BACKUP — move it aside so it is not overwritten."
git clone --mirror . "$BACKUP" --quiet
echo "   mirror written to $BACKUP"

echo ""
echo "== 3. Rewrite ================================================="
REMOTE_URL="$(git remote get-url origin)"
python -m git_filter_repo --invert-paths --path "$TARGET_PATH/" --force

echo ""
echo "== 4. Verify =================================================="
AFTER_HITS="$(git log --all --oneline -- "$TARGET_PATH" | wc -l)"
[[ "$AFTER_HITS" -eq 0 ]] || fail "$TARGET_PATH still appears in $AFTER_HITS commits — the rewrite did not take."

# The whole point: prove the leaking blobs are unreachable, not merely untracked.
LEAKED="$(git rev-list --all --objects |
  grep -iE 'reports/.*\.(png|jpg|jpeg)' | wc -l || true)"
[[ "$LEAKED" -eq 0 ]] || fail "$LEAKED report image(s) still reachable in history."

AFTER_COMMITS="$(git rev-list --all --count)"
echo "   commits: $BEFORE_COMMITS -> $AFTER_COMMITS"
echo "   $TARGET_PATH in history: $BEFORE_HITS -> 0"
echo "   report images reachable: 0"

# The tree must still be the code we had. A rewrite that also ate source would
# pass every check above.
for probe in package.json apps/api/src/index.ts packages/media/src/engine.ts LICENSE; do
  [[ -f "$probe" ]] || fail "$probe is missing after the rewrite — do NOT push. Restore from $BACKUP."
done
echo "   working tree intact (spot-checked)"

echo ""
echo "== 5. Remote restored, NOT pushed ============================="
git remote add origin "$REMOTE_URL"
cat <<EOF

   filter-repo dropped 'origin' on purpose; it is back now, but nothing was
   pushed. Review first:

     git log --oneline -5
     pnpm lint && pnpm -r typecheck && pnpm test

   Then, deliberately:

     git push origin dev --force-with-lease
     git push origin master --force-with-lease   # if master exists remotely

   Afterwards, redeploy so the VPS checkout lands on the new history:

     bash scripts/deploy-remote.sh

   If anything looks wrong, the untouched mirror is at:
     $BACKUP
   Restore with: git remote set-url origin "$BACKUP" && git fetch --all
EOF
