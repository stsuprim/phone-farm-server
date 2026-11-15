#!/bin/bash
# One-time (and after Xcode/iOS updates): build + sign WebDriverAgent for each phone.
# Usage: scripts/build-wda.sh <TEAM_ID> <UDID> [UDID...]
set -euo pipefail
TEAM="${1:?team id}"; shift
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
PROJ="${WDA_PROJECT:?set WDA_PROJECT in .env}"
OUT="${WDA_DERIVED_DATA:-$HOME/wda-build}"; OUT="${OUT/#\~/$HOME}"
TEAM_LC="$(printf "%s" "$TEAM" | tr "[:upper:]" "[:lower:]")"
BUNDLE="${WDA_BUNDLE_ID:-com.${TEAM_LC}.WebDriverAgentRunner}"
# The fast touch route (POST /wda/lotus/touch, docs/BEST_METHOD.md 1b): answers before XCTest plays the touch,
# no active-app lookup. WDA_PATCH=0 builds WDA as it is.
if [ "${WDA_PATCH:-1}" != "0" ]; then node scripts/patch-wda.mjs "$PROJ"; fi
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
  echo "== $UDID"
  LOG="$OUT/build-wda-$UDID.log"
  if ! xcodebuild build-for-testing -project "$PROJ/WebDriverAgent.xcodeproj" -scheme WebDriverAgentRunner \
    -destination "id=$UDID" -derivedDataPath "$OUT" -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_IDENTITY="Apple Development" \
    PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE" > "$LOG" 2>&1; then
    echo "!! WDA build failed for $UDID. First errors:"
    grep -E "error:" "$LOG" | head -n 20 || tail -n 20 "$LOG"
    echo "Full log: $LOG"
    echo "To build without the fast touch route: node scripts/patch-wda.mjs \"$PROJ\" --remove, then WDA_PATCH=0 $0 $TEAM <UDIDs>"
    exit 1
  fi
  tail -n 3 "$LOG"
done
