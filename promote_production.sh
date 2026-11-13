#!/usr/bin/env bash
# promote_production.sh -- promote staging to production (Ian's routine), then leave you on staging.
# Run from anywhere:  bash /c/Users/ian/Campaignia/Campaignia/promote_production.sh   (add --watch to wait for the deploy)
# It stops at the first problem and says which step. Ctrl+C is safe at every step; after step 4 the
# promote is already done. Nothing here waits silently, and nothing waits more than 10 seconds for
# the network.
set -e
cd /c/Users/ian/Campaignia/Campaignia
export GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no GIT_TERMINAL_PROMPT=0
back_to_staging() { git checkout -q staging 2>/dev/null || true; }
trap 'back_to_staging; echo; echo ">>> STOPPED at the step above -- nothing after it ran; you are on $(git branch --show-current)"' ERR
trap 'back_to_staging; echo; echo ">>> interrupted -- you are on $(git branch --show-current)"; exit 130' INT

echo ">>> 1/4 staging: current, clean, pushed"
git checkout -q staging
git pull --ff-only -q origin staging
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo ">>> staging has uncommitted changes -- commit or discard them first"; exit 1
fi
git push -q origin staging
VER=$(grep -o '"version": *"[0-9.]*"' version-info.json | grep -o '[0-9][0-9.]*')
echo "    staging is v$VER"

echo ">>> 2/4 is anyone mid-Optimize on production? (waits until clear)"
bash inflight.sh production --wait

echo ">>> 3/4 merging staging into main"
git checkout -q main
git pull --ff-only -q origin main
git merge -q staging --no-edit
echo "    main is now: $(git log -1 --oneline)"

echo ">>> 4/4 pushing main (Railway deploys it to campaignia.com)"
git push -q origin main
git checkout -q staging
echo "    pushed; you are back on staging -- the promote is done"

# 5. Optional: add --watch to wait until production reports the new version (up to 10 min, Ctrl+C is safe).
if [ "${1:-}" != "--watch" ]; then
  echo ">>> DONE: v$VER pushed to production; you are on staging and can carry on."
  echo "    Railway takes a few minutes to deploy -- check https://campaignia.com/version, or run this script with --watch next time."
  exit 0
fi
echo ">>> watching production for v$VER (every 15 s, up to 10 min; Ctrl+C is safe)"
for i in $(seq 1 40); do
  LIVE=$(curl -s --max-time 10 https://campaignia.com/version | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -n 1 || true)
  echo "    check $i: production says v${LIVE:-?}"
  if [ "$LIVE" = "$VER" ]; then echo ">>> DONE: production is serving v$VER"; exit 0; fi
  sleep 15
done
echo ">>> production still says v${LIVE:-?} after 10 minutes -- the push went out; check the deploy in Railway"
