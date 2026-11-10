#!/bin/bash
# One-time (and after Xcode/iOS updates): build + sign WebDriverAgent for each phone.
# Usage: scripts/build-wda.sh <TEAM_ID> <UDID> [UDID...]
set -euo pipefail
TEAM="${1:?team id}"; shift
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
PROJ="${WDA_PROJECT:?set WDA_PROJECT in .env}"
OUT="${WDA_DERIVED_DATA:-$HOME/wda-build}"; OUT="${OUT/#\~/$HOME}"
for UDID in "$@"; do
  echo "== $UDID"
  xcodebuild build-for-testing -project "$PROJ/WebDriverAgent.xcodeproj" -scheme WebDriverAgentRunner \
    -destination "id=$UDID" -derivedDataPath "$OUT" -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_IDENTITY="Apple Development" | tail -n 5
done
