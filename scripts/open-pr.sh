#!/usr/bin/env bash
# Task 006 (bugfix JS cursor pagination): prepare the pull request.
#
# Pushes the fix branch and opens a PR using REPORT.md as the body.
# Usage: npm run pr   (or: bash scripts/open-pr.sh [branch-name])
#
# Merge and deploy are intentionally NOT performed.
set -euo pipefail

BRANCH="${1:-fix/cursor-pagination}"
BASE="${BASE:-main}"
TITLE="${TITLE:-fix(cursor-pagination): correct cursor tiebreak, nextCursor, limit/cursor validation}"

cd "$(dirname "$0")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git repository" >&2
  exit 1
fi

if ! git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  echo "error: branch ${BRANCH} does not exist; run 'npm run branch' first" >&2
  exit 1
fi

git switch "${BRANCH}"
git push --set-upstream origin "${BRANCH}"

# Opens the PR only. No merge, no deploy.
gh pr create --base "${BASE}" --head "${BRANCH}" --title "${TITLE}" --body-file REPORT.md

echo "PR prepared for branch: ${BRANCH} (no merge, no deploy)"
