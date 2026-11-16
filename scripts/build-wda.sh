#!/bin/bash
# Build + sign WebDriverAgent for each phone. The server runs this by itself (the 6-day re-sign, and the install of
# our own build: src/resign.ts, src/fork.ts); by hand only for the first setup or to see a build's errors.
# Usage: scripts/build-wda.sh <TEAM_ID> <UDID> [UDID...]
#   WDA_BUILD_FLAVOR=fork   build our own WebDriverAgent (wda/ in this repo) into WDA_FORK_DERIVED_DATA
#                           (default ~/wda-fork-build) instead of the stock one of WDA_PROJECT into WDA_DERIVED_DATA.
#                           Same team, same certificate, same bundle id: the phone's developer trust stays as it is.
set -euo pipefail
TEAM="${1:?team id}"; shift
cd "$(dirname "$0")/.."
FLAVOR="${WDA_BUILD_FLAVOR:-stock}"
set -a; [ -f .env ] && . ./.env; set +a
TEAM_LC="$(printf "%s" "$TEAM" | tr "[:upper:]" "[:lower:]")"
BUNDLE="${WDA_BUNDLE_ID:-com.${TEAM_LC}.WebDriverAgentRunner}"
EXTRA=()
if [ "$FLAVOR" = "fork" ]; then
  # Our own build: the sources are in this repo, with our changes already in them (nothing is patched here).
  PROJ="$(pwd)/wda"
  OUT="${WDA_FORK_DERIVED_DATA:-$HOME/wda-fork-build}"; OUT="${OUT/#\~/$HOME}"
  [ -d "$PROJ/WebDriverAgent.xcodeproj" ] || { echo "error: $PROJ/WebDriverAgent.xcodeproj is missing from this checkout"; exit 1; }
  # Its build-phase scripts must be runnable, whatever this clone's core.fileMode says (the server does it too).
  find "$PROJ" -type f \( -name '*.sh' -o -name '*.command' \) -not -path '*/node_modules/*' -exec chmod +x {} + 2>/dev/null || true
  # Upstream builds with -Weverything and warnings as errors: a newer Xcode's new warning must not fail our build.
  EXTRA=(GCC_TREAT_WARNINGS_AS_ERRORS=NO RUN_CLANG_STATIC_ANALYZER=NO)
else
  PROJ="${WDA_PROJECT:?set WDA_PROJECT in .env}"
  OUT="${WDA_DERIVED_DATA:-$HOME/wda-build}"; OUT="${OUT/#\~/$HOME}"
  # The fast touch route (POST /wda/lotus/touch, docs/BEST_METHOD.md 1b): answers before XCTest plays the touch,
  # no active-app lookup. WDA_PATCH=0 builds WDA as it is.
  if [ "${WDA_PATCH:-1}" != "0" ]; then node scripts/patch-wda.mjs "$PROJ"; fi
fi
mkdir -p "$OUT"
# WDA_FRESH_PROFILE=1 (the server's 6-day re-sign): drop the cached provisioning profiles for this bundle first, so
# Xcode fetches a new 7-day one instead of reusing the one that is about to expire.
if [ "${WDA_FRESH_PROFILE:-0}" = "1" ]; then
  for DIR in "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
    [ -d "$DIR" ] || continue
    for P in "$DIR"/*.mobileprovision; do
      [ -f "$P" ] || continue
      if grep -aq "$BUNDLE" "$P" 2>/dev/null; then echo "removing old profile $(basename "$P")"; rm -f "$P"; fi
    done
  done
fi
for UDID in "$@"; do
  echo "== $UDID ($FLAVOR)"
  LOG="$OUT/build-wda-$UDID.log"
  if ! xcodebuild build-for-testing -project "$PROJ/WebDriverAgent.xcodeproj" -scheme WebDriverAgentRunner \
    -destination "id=$UDID" -derivedDataPath "$OUT" -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_IDENTITY="Apple Development" \
    PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE" ${EXTRA[@]+"${EXTRA[@]}"} > "$LOG" 2>&1; then
    echo "!! WDA build failed for $UDID. First errors:"
    grep -E "error:" "$LOG" | head -n 20 || tail -n 20 "$LOG"
    echo "Full log: $LOG"
    if [ "$FLAVOR" != "fork" ]; then
      echo "To build without the fast touch route: node scripts/patch-wda.mjs \"$PROJ\" --remove, then WDA_PATCH=0 $0 $TEAM <UDIDs>"
    fi
    exit 1
  fi
  tail -n 3 "$LOG"
done
