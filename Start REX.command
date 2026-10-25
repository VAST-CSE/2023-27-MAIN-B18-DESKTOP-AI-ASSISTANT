#!/bin/zsh
# Double-click this file in Finder to start REX.

cd "$(dirname "$0")" || exit 1
unset ELECTRON_RUN_AS_NODE

APP="/Applications/REX.app"
[ -d "$APP" ] || APP="$PWD/release/mac-arm64/REX.app"

if [ ! -d "$APP" ]; then
  echo "REX.app was not found."
  echo "Build it first: npm run package"
  exit 1
fi

BIN="$APP/Contents/MacOS/REX"

pkill -f "^${BIN}([[:space:]]|$)" 2>/dev/null
sleep 1

# Ensure entitlements and clean attributes for microphone access
xattr -cr "$APP" 2>/dev/null || true
if [ -f "build/entitlements.mac.plist" ]; then
  codesign --force --deep --sign - --identifier com.rex.app --requirements '=designated => identifier "com.rex.app"' --entitlements build/entitlements.mac.plist "$APP" 2>/dev/null || true
fi

nohup "$BIN" "$@" >/tmp/rex.log 2>&1 &
sleep 2

if pgrep -f "^${BIN}([[:space:]]|$)" >/dev/null; then
  echo "REX is running — press ⌘⇧Space and speak."
else
  echo "REX did not start. Recent log:"
  tail -n 10 /tmp/rex.log 2>/dev/null
fi
