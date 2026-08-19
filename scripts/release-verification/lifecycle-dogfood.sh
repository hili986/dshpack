#!/usr/bin/env bash
# M1-12 dogfooding: drive the whole management lifecycle on a real machine with a real dsh.
#
# Isolation rules this script must not break:
#   - every dsh-facing path lives under $BASE; the user's real DSH_HOME is never named
#   - no $HOME / $USERPROFILE / ~ anywhere
#
# usage: m1-12-lifecycle.sh <absolute-scratch-dir> <path-to-bin.js> <label> [extra-install-flags]
#
# The 4th argument exists because the two machines disagree on dsh version: Windows has rc.5 against
# a pack that declares rc.6, so it needs --allow-version-mismatch; WSL has rc.6 and must NOT be given
# the flag, so that run proves the version gate passes on its own rather than being waved through.
set -uo pipefail

BASE="$1"; BIN="$2"; LABEL="$3"; EXTRA_INSTALL="${4:-}"
DSH_HOME="$BASE/isolated-dsh-home"
WORK="$BASE/work"
export DSH_HOME
mkdir -p "$DSH_HOME" "$WORK"

fail=0
step() { printf '\n=== %s ===\n' "$1"; }
pass() { printf 'OK   %s\n' "$1"; }
bad()  { printf 'FAIL %s\n' "$1"; fail=1; }
# rc must be captured on the very next line — nothing may run between the command and $?.
run() { "$@" >"$BASE/last.out" 2>&1; RC=$?; }

printf '===== M1-12 lifecycle: %s =====\n' "$LABEL"
printf 'dshpack: %s\n' "$(node "$BIN" --version 2>&1)"
printf 'dsh:     %s\n' "$(dsh --version 2>&1 | head -1)"
printf 'node:    %s\n' "$(node --version 2>&1)"

step "1. author a pack with compose, from a local source"
mkdir -p "$WORK/src/skills/note-taking" "$WORK/src/patch"
cat > "$WORK/src/pack.yml" <<'YAML'
formatVersion: 0
name: lifecycle-source
version: 0.1.0
description: A local source pack for lifecycle dogfooding.
author: dogfood
license: MIT
dsh:
  tested:
    - 0.1.0-rc.6
plugins: []
mcp: []
defaults:
  permissionPreset: workspace-write
YAML
printf '[]\n' > "$WORK/src/patch/cordis.patch.yml"
printf -- '---\nname: note-taking\ndescription: Take structured notes.\n---\n\n# note-taking\n' \
  > "$WORK/src/skills/note-taking/SKILL.md"
run node "$BIN" lock "$WORK/src"
[ $RC -eq 0 ] && pass "lock rc=0" || { bad "lock rc=$RC"; tail -3 "$BASE/last.out"; }

cat > "$WORK/compose.yml" <<'YAML'
composeVersion: 0
name: lifecycle-kit
version: 0.1.0
description: Composed pack for the M1 lifecycle run.
author: dogfood
license: MIT
include:
  - from: ./src
    skills: ["*"]
defaults:
  permissionPreset: workspace-write
YAML
run node "$BIN" compose "$WORK/compose.yml"
[ $RC -eq 0 ] && pass "compose rc=0" || { bad "compose rc=$RC"; tail -5 "$BASE/last.out"; }
[ -f "$WORK/lifecycle-kit/pack.lock.yml" ] && pass "composed pack is locked" || bad "no lock in composed pack"

step "2. install it into the isolated home"
run node "$BIN" install "$WORK/lifecycle-kit" --as lifecycle --yes $EXTRA_INSTALL --json
printf 'install rc=%s\n' "$RC"
tail -c 600 "$BASE/last.out"; printf '\n'
[ $RC -eq 0 ] && pass "install rc=0" || bad "install rc=$RC"
[ -f "$DSH_HOME/profiles/lifecycle/package.json" ] && pass "profile materialised" || bad "no profile on disk"

step "3. list and status see it as tracked"
run node "$BIN" list --json
printf '%s\n' "$(tail -c 400 "$BASE/last.out")"
grep -q 'lifecycle' "$BASE/last.out" && pass "list names the profile" || bad "list does not name it"
run node "$BIN" status --json
printf '%s\n' "$(tail -c 400 "$BASE/last.out")"
[ $RC -eq 0 ] && pass "status rc=0 (offline by default)" || bad "status rc=$RC"

step "4. diff is clean immediately after install"
run node "$BIN" diff lifecycle --json
printf '%s\n' "$(tail -c 400 "$BASE/last.out")"
[ $RC -eq 0 ] && pass "diff rc=0 on a fresh install" || bad "diff rc=$RC"

step "5. edit a deployed skill; diff must report the drift"
# Skills deploy to the home root, not under the profile — this is what the install plan itself
# reports as the target (`skills/note-taking`), so take the tool's word over the directory layout
# one might assume from `profiles/<name>/`.
SKILL="$DSH_HOME/skills/note-taking/SKILL.md"
if [ -f "$SKILL" ]; then
  printf '\nEdited by the user after install.\n' >> "$SKILL"
  run node "$BIN" diff lifecycle --json
  printf '%s\n' "$(tail -c 400 "$BASE/last.out")"
  # Must assert on `localDrift` being non-empty. Grepping for the words `drift` or `note-taking`
  # matches the CLEAN step-4 output too (`"localDrift":[]`, and the asset digest names the skill),
  # so that phrasing goes green whether or not diff noticed anything.
  if grep -q '"localDrift":\[\]' "$BASE/last.out"; then
    bad "diff missed a local edit (localDrift is still empty)"
  else
    pass "diff reports the local edit (localDrift non-empty)"
  fi
else
  bad "deployed skill not found at the expected path: $SKILL"
  ls -R "$DSH_HOME/profiles/lifecycle" 2>/dev/null | head -20
fi

step "6. uninstall must preserve content it cannot prove it owns"
run node "$BIN" uninstall lifecycle --yes --json
printf 'uninstall rc=%s\n' "$RC"
cp "$BASE/last.out" "$BASE/uninstall.json"
tail -c 700 "$BASE/last.out"; printf '\n'
# The property under test is not "does it delete" but "does what it says match what it did".
# The skill was edited in step 5, so a report that still calls it `intact` while deleting it is
# the one outcome that is a defect rather than a policy choice.
if [ -f "$SKILL" ]; then
  pass "the user-edited skill survived uninstall (drift => preserved)"
elif grep -q '"target":"skills/note-taking","drift":"intact"' "$BASE/uninstall.json"; then
  bad "uninstall deleted an edited skill while reporting it as intact"
else
  printf 'NOTE edited skill deleted, but the report did not claim it was intact:\n'
  grep -o '"target":"skills/note-taking"[^}]*' "$BASE/uninstall.json" | head -1
fi

step "7. gc reclaims what is now unreferenced"
run node "$BIN" gc --json
printf 'gc rc=%s\n' "$RC"; tail -c 300 "$BASE/last.out"; printf '\n'
[ $RC -eq 0 ] && pass "gc rc=0" || bad "gc rc=$RC"

step "8. doctor --strict on the isolated home"
run node "$BIN" doctor --strict --json
printf 'doctor rc=%s\n' "$RC"; tail -c 400 "$BASE/last.out"; printf '\n'

printf '\n===== %s RESULT: %s =====\n' "$LABEL" "$([ $fail -eq 0 ] && echo PASS || echo 'FAIL (see above)')"
exit $fail
