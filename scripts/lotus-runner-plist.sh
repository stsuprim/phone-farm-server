#!/bin/bash
# LOTUS (v6, 2026-11-24): what the runner app's Info.plist must say before iOS lets it add to Photos and shows its
# folder in Files. Xcode makes WebDriverAgentRunner-Runner.app itself and has no build setting for its Info.plist, so
# it's added after the build and the app is signed again with the same certificate and entitlements (as
# embed-runner-icon.sh does for the icon). Run by scripts/build-wda.sh with the app's folder.
# It never fails a build: when anything here goes wrong the app is left exactly as Xcode made it (WebDriverAgent works,
# sending files says why it can't), and that's printed.
set -uo pipefail

APP="${1:-}"
PLIST="$APP/Info.plist"
NAME="Lotus"
PHOTOS="Photos and videos you send to this phone from Lotus are added to your library. Nothing in it is read."

if [ ! -f "$PLIST" ]; then
  echo "warning: $PLIST not found; Photos and Files stay off"
  exit 0
fi

BUDDY=/usr/libexec/PlistBuddy
get() { "$BUDDY" -c "Print :$1" "$PLIST" 2>/dev/null; }

if [ "$(get CFBundleDisplayName)" = "$NAME" ] && [ "$(get NSPhotoLibraryAddUsageDescription)" = "$PHOTOS" ] \
    && [ "$(get UIFileSharingEnabled)" = "true" ] && [ "$(get LSSupportsOpeningDocumentsInPlace)" = "true" ] \
    && codesign --verify --strict "$APP" 2>/dev/null; then
  echo "the runner already has Photos and Files"
  exit 0
fi

WORK="$(mktemp -d)" || exit 0
trap 'rm -rf "$WORK"' EXIT
if ! cp -Rp "$APP" "$WORK/app"; then
  echo "warning: could not back the runner up; Photos and Files stay off"
  exit 0
fi

restore() {
  echo "warning: $1; the runner is left as Xcode made it (Photos and Files stay off)"
  if rm -rf "$APP" && cp -Rp "$WORK/app" "$APP"; then
    exit 0
  fi
  echo "error: the runner could not be put back"
  exit 1
}

put() { # key type value
  "$BUDDY" -c "Delete :$1" "$PLIST" 2>/dev/null
  "$BUDDY" -c "Add :$1 $2 $3" "$PLIST"
}

put CFBundleDisplayName string "$NAME" || restore "could not write the name"
put NSPhotoLibraryAddUsageDescription string "$PHOTOS" || restore "could not write the Photos text"
put UIFileSharingEnabled bool true || restore "could not write the shared folder"
put LSSupportsOpeningDocumentsInPlace bool true || restore "could not write the shared folder"

if [ -d "$APP/_CodeSignature" ]; then
  # the certificate Xcode signed with, by its SHA-1 (two can share a name)
  IDENT=""
  if codesign -d --extract-certificates="$WORK/leaf" "$APP" 2>/dev/null && [ -f "$WORK/leaf0" ]; then
    IDENT="$(shasum -a 1 "$WORK/leaf0" | awk '{print toupper($1)}')"
  fi
  [ -n "$IDENT" ] || restore "the runner's certificate could not be read"
  codesign --force --sign "$IDENT" --preserve-metadata=identifier,entitlements "$APP" || restore "could not sign the runner again"
  codesign --verify --strict "$APP" || restore "the runner's new signature is not valid"
fi
echo "the runner has Photos and Files (its folder in Files: $NAME)"
