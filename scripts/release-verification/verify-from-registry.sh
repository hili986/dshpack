#!/usr/bin/env bash
# Install dshpack from the registry into an isolated prefix and exercise the binary a
# stranger would actually get. Publishing is not delivery: this procedure has run twice
# and caught a CI-green defect both times (0.1.0 five, 0.2.0 one) — it is the primary
# detector, not a safety net. Checklist mirrors 最终方案 §8.3.
#
# Isolation rules this script must not break:
#   - never touch the real DSH_HOME; every dsh-facing path lives under $BASE
#   - no $HOME / $USERPROFILE / ~ anywhere
#
# usage: verify-from-registry.sh <absolute-scratch-dir> <version>
set -uo pipefail

BASE="$1"
VERSION="$2"
PREFIX="$BASE/prefix"
DSH_HOME="$BASE/isolated-dsh-home"
WORK="$BASE/work"
export DSH_HOME
mkdir -p "$PREFIX" "$DSH_HOME" "$WORK"

fail=0
step() { printf '\n=== %s ===\n' "$1"; }
pass() { printf 'OK   %s\n' "$1"; }
bad()  { printf 'FAIL %s\n' "$1"; fail=1; }
# `--` before the pattern: without it a pattern like `--yes` is parsed as a grep option,
# which silently reports "not found" for a string that is present. That bug produced a
# phantom defect in the 0.2.0 round.
check() { # check <label> <expected-substring> <actual>
  if printf '%s' "$3" | grep -qF -- "$2"; then pass "$1"
  else printf 'FAIL %s\n  want substring: %s\n  got: %s\n' "$1" "$2" "$3"; fail=1; fi
}

step "① install dshpack@$VERSION from the registry into an isolated prefix"
npm install --prefix "$PREFIX" --no-audit --no-fund "dshpack@$VERSION" >"$BASE/npm-install.log" 2>&1
printf 'npm install rc=%s\n' "$?"
BIN="$PREFIX/node_modules/.bin/dshpack"
[ -f "$BIN" ] || BIN="$PREFIX/node_modules/.bin/dshpack.cmd"
if [ -f "$BIN" ]; then pass "binary present: $BIN"; else bad "no binary under .bin/"; fi

step "② --version reports the published version"
out="$("$BIN" --version 2>&1)"; check "--version == $VERSION" "$VERSION" "$out"

step "③ --version --json puts it under a version key, not inside help text"
out="$("$BIN" --version --json 2>&1)"; check "--version --json" '"version"' "$out"

step "④ the copyable command the tool prints actually runs (0.2.0 shipped one that did not)"
printed="$("$BIN" init "$WORK/copyable" 2>&1 </dev/null)"
printf '%s\n' "$printed" | tail -2
cmd="$(printf '%s' "$printed" | grep -o 'dshpack init.*' | head -1)"
if [ -z "$cmd" ]; then
  bad "the exit-21 path printed no copyable command"
else
  # Drop argv[0] (`dshpack`), keep everything else verbatim, then run it through the binary.
  eval "set -- ${cmd#dshpack }"
  "$BIN" "$@" >"$BASE/copyable.log" 2>&1
  rc=$?
  if [ $rc -eq 0 ]; then pass "copied command exits 0"; else bad "copied command rc=$rc"; tail -3 "$BASE/copyable.log"; fi
  # Exit code alone is not enough: the 0.2.0 defect exited 0 having created nothing.
  if [ -f "$WORK/copyable/pack.yml" ]; then pass "copied command produced pack.yml"
  else bad "copied command exited without producing pack.yml"; fi
fi

step "⑤ main path end to end: init → pack → install file:"
"$BIN" init "$WORK/demo-pack" --yes --name demo-pack --pack-version 0.1.0 \
  --description 'A demo pack.' --author verifier --license MIT --template skills \
  >"$BASE/init.log" 2>&1
printf 'init rc=%s\n' "$?"
[ -f "$WORK/demo-pack/pack.yml" ] && pass "pack.yml written" || bad "pack.yml missing"
[ -f "$WORK/demo-pack/pack.lock.yml" ] && pass "pack.lock.yml written (init ran lock)" || bad "lock missing"

"$BIN" pack "$WORK/demo-pack" >"$BASE/pack.log" 2>&1
printf 'pack rc=%s\n' "$?"
ls -1 "$WORK/demo-pack/dist" 2>/dev/null && pass "pack produced dist artifacts" || bad "no dist output"

step "⑥ packing twice is byte-identical (the reproducibility claim, on the real binary)"
first="$(ls "$WORK/demo-pack/dist"/*.tgz 2>/dev/null | head -1)"
if [ -n "$first" ]; then
  a="$(sha256sum "$first" | cut -d' ' -f1)"
  rm -rf "$WORK/demo-pack/dist"
  "$BIN" pack "$WORK/demo-pack" >/dev/null 2>&1
  second="$(ls "$WORK/demo-pack/dist"/*.tgz 2>/dev/null | head -1)"
  b="$(sha256sum "$second" | cut -d' ' -f1)"
  if [ "$a" = "$b" ]; then pass "two packs are byte-identical (${a:0:16})"
  else printf 'FAIL packs differ\n  %s\n  %s\n' "$a" "$b"; fail=1; fi
else
  bad "no tarball to compare"
fi

step "⑦ the audit record carries a real version (0.1.0 wrote dshpack@0.0.0 forever)"
if grep -rn 'dshpack@0\.0\.0' "$WORK/demo-pack" 2>/dev/null; then bad "stale generatedBy found"
else pass "no dshpack@0.0.0 anywhere in the generated pack"; fi
grep -h 'generatedBy' "$WORK/demo-pack/pack.lock.yml" 2>/dev/null || true

step "⑧ the npm landing page is not blank (README shipped inside the tarball)"
for pkg in dshpack @dshpack/core; do
  d="$PREFIX/node_modules/$pkg"
  [ -f "$d/README.md" ] && pass "$pkg ships a README" || bad "$pkg has no README"
done

step "⑨ dependency install was clean (no EBADENGINE, no dead dependency)"
if grep -qi 'EBADENGINE' "$BASE/npm-install.log"; then bad "npm reported EBADENGINE"; grep -i -m3 'EBADENGINE' "$BASE/npm-install.log"
else pass "no EBADENGINE"; fi

step "⑩ install the pack back from file:, with SRI mandatory and tampering rejected"
# The SRI travels in the source string as `file:<path>#sha512-<base64>` — there is no
# `--integrity` flag. An earlier version of this script invented one and reported the
# resulting `unknown option` as if it were a product defect. Read the option list, do not
# guess. Paths must be Windows-style here: an MSYS `/c/...` path resolves relative to the
# cwd file:// URL and silently becomes "source does not exist", which looks like a
# rejection and proves nothing.
tgz_win="$(printf '%s' "${second:-${first:-}}" | sed -E 's|^/([a-zA-Z])/|\1:/|')"
if [ -z "$tgz_win" ]; then
  bad "no tarball to install back"
else
  sri="$(tr -d '\r\n' <"${second:-$first}.sha512" 2>/dev/null)"

  out="$("$BIN" install "file:$tgz_win#$sri" --as verify-demo --dry-run --json 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then pass "correct SRI produces a plan (rc=0)"
  else printf 'FAIL correct SRI rejected, rc=%s\n%s\n' "$rc" "$out"; fail=1; fi

  # The security claim, not a formality: one flipped byte must fail integrity.
  cp "${second:-$first}" "$BASE/tampered.tgz"
  python -c "
import sys
p = sys.argv[1]
d = bytearray(open(p,'rb').read()); d[len(d)//2] ^= 0xFF; open(p,'wb').write(d)
" "$(printf '%s' "$BASE/tampered.tgz" | sed -E 's|^/([a-zA-Z])/|\1:/|')"
  base_win="$(printf '%s' "$BASE" | sed -E 's|^/([a-zA-Z])/|\1:/|')"
  out="$("$BIN" install "file:$base_win/tampered.tgz#$sri" --as verify-demo --dry-run --json 2>&1)"
  check "tampered tarball rejected by integrity" 'SOURCE_INTEGRITY' "$out"

  # And SRI is mandatory even for the author's own local tarball.
  out="$("$BIN" install "file:$tgz_win" --as verify-demo --dry-run --json 2>&1)"
  check "missing SRI fragment refused" '完整性片段' "$out"
fi

step "⑪ compose refuses a collision and honours an explicit resolution (0.3.0 ships it first)"
# compose is the headline of this release and had zero coverage in this procedure. Everything
# else here has been exercised by an earlier round; this one is brand new to users, which is
# exactly the profile of the defects the last two rounds caught.
for src in alpha beta; do
  mkdir -p "$WORK/cmp/$src/skills/shared-note" "$WORK/cmp/$src/patch"
  printf '[]\n' > "$WORK/cmp/$src/patch/cordis.patch.yml"
  printf -- '---\nname: shared-note\ndescription: From %s.\n---\n\n# shared-note (%s)\n' \
    "$src" "$src" > "$WORK/cmp/$src/skills/shared-note/SKILL.md"
  cat > "$WORK/cmp/$src/pack.yml" <<YAML
formatVersion: 0
name: $src-notes
version: 0.1.0
description: Source pack $src for the compose check.
author: verifier
license: MIT
dsh:
  tested:
    - 0.1.0-rc.6
plugins: []
mcp: []
defaults:
  permissionPreset: workspace-write
YAML
  "$BIN" lock "$WORK/cmp/$src" >/dev/null 2>&1
done

write_compose() { # write_compose <path> <resolve-block-or-empty>
  cat > "$1" <<YAML
composeVersion: 0
name: verify-kit
version: 0.1.0
description: Composed by the registry-installed binary.
author: verifier
license: MIT
include:
  - from: ./alpha
    skills: ["*"]
  - from: ./beta
    skills: ["*"]
$2
defaults:
  permissionPreset: workspace-write
YAML
}

write_compose "$WORK/cmp/unresolved.yml" ''
out="$("$BIN" compose "$WORK/cmp/unresolved.yml" --output "$WORK/cmp/out-bad" --json 2>&1)"; rc=$?
if [ $rc -eq 30 ]; then pass "unresolved collision exits 30"
else printf 'FAIL unresolved collision rc=%s (want 30)\n%s\n' "$rc" "$out"; fail=1; fi
check "and names the conflicting id" 'shared-note' "$out"
[ -d "$WORK/cmp/out-bad" ] && bad "refused compose still produced a directory" \
  || pass "refused compose produced nothing"

write_compose "$WORK/cmp/resolved.yml" '
resolve:
  - id: shared-note
    prefer: ./alpha'
out="$("$BIN" compose "$WORK/cmp/resolved.yml" --output "$WORK/cmp/out" --json 2>&1)"; rc=$?
if [ $rc -eq 0 ]; then pass "explicit prefer composes (rc=0)"
else printf 'FAIL resolved compose rc=%s\n%s\n' "$rc" "$out"; fail=1; fi
# Both sources deploy to the same path, so only the content proves which one was chosen.
check "the chosen source is the one that landed" 'shared-note (alpha)' \
  "$(cat "$WORK/cmp/out/skills/shared-note/SKILL.md" 2>/dev/null)"
check "provenance records where it came from" 'provenance' \
  "$(cat "$WORK/cmp/out/pack.yml" 2>/dev/null)"

step "⑫ the npm landing page no longer claims shipped commands are unimplemented"
# 0.2.1 shipped a README saying `init` / `pack` were unimplemented, months after they were
# not. That page is the first thing a stranger reads; nothing about the binary can detect it.
readme="$(cat "$PREFIX/node_modules/dshpack/README.md" 2>/dev/null)"
if printf '%s' "$readme" | grep -q '未实现'; then
  bad "published README still calls a command unimplemented"
  printf '%s' "$readme" | grep -n '未实现' | head -3
else
  pass "no 未实现 claim in the published README"
fi
for cmd in compose uninstall update restore status diff gc migrate init pack; do
  printf '%s' "$readme" | grep -qF -- "\`$cmd" || bad "published README never mentions $cmd"
done
pass "published README mentions the M1 command set"

printf '\n===== RESULT: %s =====\n' "$([ $fail -eq 0 ] && echo PASS || echo 'FAIL (see above)')"
exit $fail
