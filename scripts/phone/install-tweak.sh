#!/usr/bin/env bash
# scripts/phone/install-tweak.sh [tweak|imcap|taskguard|rollback]
#
# Builds one of the on-phone tweaks in ios/tweak/ on this Mac and installs it
# on ONE jailbroken iPhone line, then proves it came back. Read
# ios/tweak/README.md first: a bad build here crashes SpringBoard on the phone.
#
#   tweak      VanquelTweak, the :8799 listener (default). On Dopamine also the
#              vanquel-smsdb helper it needs to read sms.db.
#   imcap      IMCap (iOS 16 lines): capability unlock and typing bridge.
#   taskguard  TaskGuard (rootless lines): stops an SMServer check crashing SpringBoard.
#   rollback   puts back the VanquelTweak files saved by the last install.
#
# Settings come from the environment, never from this file:
#   PHONE_SSH        ssh target, for example mobile@PHONE_IP (key-based login)
#   PHONE_SUDO_PASS  the phone's sudo password; sent on stdin, never in argv.
#                    May be empty on a rootful phone you reach as root.
#   JAILBREAK        palera1n | dopamine | rootful
#   LINE_NUMBER      this line's number in E.164 (tweak only)
#   TWEAK_URL        http://PHONE_IP:8799 (tweak and rollback: the self-test)
#   TWEAK_SECRET     the shared secret the bridge sends (tweak and rollback)
#   THEOS            your Theos checkout (tweak only)
#
# What it does for `tweak`: builds in a scratch copy, saves the installed
# dylib/plist under /var/mobile/vanquel-tweak-backup/<time>/ on the phone,
# writes the secret file, installs, restarts SpringBoard the way this
# jailbreak needs, and waits for /poc/ping and an authenticated
# /poc/message-status. If the tweak does not answer it puts the saved files
# back the same way. Afterwards restart this line's bridge: a respring ends
# SMServer's login session.
#
# Restarting SpringBoard, per jailbreak (see docs/PHONES.md, Hard rules):
#   dopamine  /var/jb/usr/bin/jbctl respring
#   palera1n  /cores/binpack/usr/sbin/p1ctl reboot-userspace  (re-arms injection)
#   rootful   killall -9 SpringBoard  (checkra1n's substrate re-injects on relaunch)
# Never the stock `launchctl reboot userspace` and never `reboot`.
set -euo pipefail

WHAT="${1:-tweak}"
case "$WHAT" in tweak|imcap|taskguard|rollback) ;; *) echo "usage: $0 [tweak|imcap|taskguard|rollback]" >&2; exit 64 ;; esac
: "${PHONE_SSH:?set PHONE_SSH, for example mobile@PHONE_IP}"
: "${JAILBREAK:?set JAILBREAK to palera1n, dopamine or rootful}"
PHONE_SUDO_PASS="${PHONE_SUDO_PASS:-}"
REPO="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
SRC="$REPO/ios/tweak"

case "$JAILBREAK" in
  palera1n|dopamine) SCHEME=rootless; PREFIX=/var/jb; SH=/var/jb/usr/bin/sh ;;
  rootful) SCHEME=rootful; PREFIX=''; SH=/bin/sh ;;
  *) echo "JAILBREAK must be palera1n, dopamine or rootful" >&2; exit 64 ;;
esac
[ "$WHAT" != taskguard ] || [ "$SCHEME" = rootless ] || { echo "taskguard is for rootless lines only" >&2; exit 64; }

LIBDIR="$PREFIX/Library/MobileSubstrate/DynamicLibraries"
HELPER=/var/jb/usr/local/libexec/vanquel-smsdb
REMOTE_PATH='export PATH=/var/jb/usr/bin:/var/jb/usr/sbin:/var/jb/bin:/usr/bin:/bin:/usr/sbin:/sbin; '
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=12)
SCP=(scp -O -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=12)

say() { echo "[install-tweak $WHAT] $*"; }
phone() { "${SSH[@]}" -n "$PHONE_SSH" "$REMOTE_PATH$1"; }
# Root on the phone. Commands passed here never contain single quotes or
# secrets; the sudo password goes on stdin.
root_phone() {
  if [ -z "$PHONE_SUDO_PASS" ]; then
    "${SSH[@]}" -n "$PHONE_SSH" "$SH -c '$REMOTE_PATH$1'"
  else
    printf '%s\n' "$PHONE_SUDO_PASS" | "${SSH[@]}" "$PHONE_SSH" "sudo -S -p '' $SH -c '$REMOTE_PATH$1'"
  fi
}
activate() {
  case "$JAILBREAK" in
    dopamine) root_phone '/var/jb/usr/bin/jbctl respring' >/dev/null 2>&1 || true ;;
    palera1n) root_phone '/cores/binpack/usr/sbin/p1ctl reboot-userspace' >/dev/null 2>&1 || true ;;
    rootful)  root_phone 'killall -9 SpringBoard' >/dev/null 2>&1 || true ;;
  esac
}
# The secret goes in a header file on a pipe, so it is never in curl's argv.
tweak_get() {
  curl -m 8 -s -H @<(printf 'X-Tweak-Secret: %s\n' "$TWEAK_SECRET") "$TWEAK_URL$1" || true
}
tweak_back() {
  local waited=0 limit=120
  [ "$JAILBREAK" != palera1n ] || limit=240
  while [ "$waited" -lt "$limit" ]; do
    sleep 5; waited=$((waited + 5))
    case "$(curl -m 5 -s "$TWEAK_URL/poc/ping" || true)" in
      pong*) [ "$(tweak_get /poc/message-status?guid=vanquel-selftest)" = 'OK found=0' ] && return 0 ;;
    esac
  done
  return 1
}

say "checking the phone"
case "$SCHEME" in
  rootless) phone 'test -d /var/jb && echo ok' | grep -q ok || { say "no /var/jb: the jailbreak is not active. Re-jailbreak first (docs/PHONES.md)."; exit 2; } ;;
  rootful)  phone 'test -d /Library/MobileSubstrate && echo ok' | grep -q ok || { say "no MobileSubstrate on this phone"; exit 2; } ;;
esac
STAMP="$(date +%Y%m%d%H%M%S)"

# ---- rollback ---------------------------------------------------------------
restore_from() {
  # $1: a backup dir on the phone. A fresh install has no saved files, so
  # rolling it back removes the package instead.
  local dir="$1" remove="rm -f $LIBDIR/VanquelTweak.dylib $LIBDIR/VanquelTweak.plist"
  [ "$SCHEME" = rootful ] || remove="dpkg -r com.example.vanquel.tweak"
  root_phone "set -e; if test -f $dir/VanquelTweak.dylib; then cp -p $dir/VanquelTweak.dylib $dir/VanquelTweak.plist $LIBDIR/; else $remove; fi"
  activate
}
if [ "$WHAT" = rollback ]; then
  : "${TWEAK_URL:?set TWEAK_URL}" "${TWEAK_SECRET:?set TWEAK_SECRET}"
  LAST="$(phone 'ls -1d /var/mobile/vanquel-tweak-backup/* 2>/dev/null | tail -1')"
  [ -n "$LAST" ] || { say "no backup on the phone; nothing to roll back to"; exit 3; }
  say "restoring $LAST and restarting SpringBoard"
  restore_from "$LAST"
  if tweak_back; then say "the previous build answers again"; else say "no answer from the tweak; if the files were removed that is expected. Check SpringBoard is up."; fi
  say "now restart this line's bridge"
  exit 0
fi

# ---- build ------------------------------------------------------------------
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/vanquel-tweak.XXXXXX")"
REMOTE_STAGE=''
cleanup() {
  [ -z "$REMOTE_STAGE" ] || phone "rm -rf $REMOTE_STAGE" >/dev/null 2>&1 || true
  rm -rf "$STAGE"
}
trap cleanup EXIT

build_dylib() {
  # imcap / taskguard: one Objective-C file, no Theos needed.
  local name="$1" file="$2"
  xcrun --sdk iphoneos clang -arch arm64 -miphoneos-version-min=14.0 -dynamiclib -fobjc-arc \
    -framework Foundation -install_name "@rpath/$name.dylib" -o "$STAGE/$name.dylib" "$file"
  codesign --force --sign - "$STAGE/$name.dylib"
}

if [ "$WHAT" = tweak ]; then
  : "${LINE_NUMBER:?set LINE_NUMBER to the line number, for example +15550100123}"
  : "${TWEAK_URL:?set TWEAK_URL, for example http://PHONE_IP:8799}" "${TWEAK_SECRET:?set TWEAK_SECRET}" "${THEOS:?set THEOS}"
  [[ "$LINE_NUMBER" =~ ^\+[0-9]{8,15}$ ]] || { echo "LINE_NUMBER must be E.164, like +15550100123" >&2; exit 64; }
  say "building ($SCHEME)"
  rsync -a --exclude .theos --exclude packages "$SRC/" "$STAGE/src/"
  ( cd "$STAGE/src" && make clean package FINALPACKAGE=1 SCHEME="$SCHEME" LINE_NUMBER="$LINE_NUMBER" ) >"$STAGE/make.log" 2>&1 || { tail -25 "$STAGE/make.log"; exit 1; }
  DEB="$(ls "$STAGE"/src/packages/*.deb | head -1)"
  if [ "$JAILBREAK" = dopamine ]; then
    xcrun --sdk iphoneos clang -arch arm64 -miphoneos-version-min=15.0 -fobjc-arc -Wall -Wextra -Werror -Os \
      -framework Foundation -lsqlite3 "$SRC/vanquel-smsdb.m" -o "$STAGE/vanquel-smsdb"
    codesign --force --sign - --entitlements "$SRC/vanquel-smsdb.entitlements" "$STAGE/vanquel-smsdb"
  fi
else
  NAME=IMCap; [ "$WHAT" = imcap ] || NAME=TaskGuard
  say "building $NAME"
  build_dylib "$NAME" "$SRC/$WHAT/$NAME.m"
fi

# ---- upload -------------------------------------------------------------------
REMOTE_STAGE="$(phone 'umask 022; mktemp -d /var/mobile/vanquel-tweak.XXXXXX')"
chmod 644 "$STAGE"/*.dylib 2>/dev/null || true

if [ "$WHAT" != tweak ]; then
  # imcap / taskguard: a real dpkg package on rootless phones, so the
  # jailbreak registers the dylib in its trust cache (a loose copy can stop
  # injecting after a userspace re-arm); a plain copy on rootful.
  "${SCP[@]}" "$STAGE/$NAME.dylib" "$SRC/$WHAT/$NAME.plist" "$SRC/$WHAT/control" "$PHONE_SSH:$REMOTE_STAGE/"
  if [ "$SCHEME" = rootless ]; then
    PKG="$REMOTE_STAGE/pkg"
    root_phone "set -e; mkdir -p $PKG/DEBIAN $PKG$LIBDIR; cp $REMOTE_STAGE/control $PKG/DEBIAN/control; cp $REMOTE_STAGE/$NAME.dylib $REMOTE_STAGE/$NAME.plist $PKG$LIBDIR/; chmod 755 $PKG$LIBDIR/$NAME.dylib; chmod 644 $PKG$LIBDIR/$NAME.plist; dpkg-deb -b $PKG $REMOTE_STAGE/$NAME.deb >/dev/null; dpkg -i $REMOTE_STAGE/$NAME.deb"
  else
    root_phone "set -e; cp $REMOTE_STAGE/$NAME.dylib $REMOTE_STAGE/$NAME.plist $LIBDIR/; chown root:wheel $LIBDIR/$NAME.dylib $LIBDIR/$NAME.plist; chmod 755 $LIBDIR/$NAME.dylib; chmod 644 $LIBDIR/$NAME.plist; command -v ldid >/dev/null && ldid -S $LIBDIR/$NAME.dylib || true"
  fi
  say "installed; restarting SpringBoard"
  [ "$WHAT" != imcap ] || root_phone 'killall -9 SMServer' >/dev/null 2>&1 || true
  activate
  say "done. Check the log on the phone (/var/mobile/vanquel-$WHAT.log) and restart this line's bridge."
  exit 0
fi

BACKUP="/var/mobile/vanquel-tweak-backup/$STAMP"
if [ "$SCHEME" = rootless ]; then
  "${SCP[@]}" "$DEB" "$PHONE_SSH:$REMOTE_STAGE/vanquel-tweak.deb"
  [ "$JAILBREAK" != dopamine ] || "${SCP[@]}" "$STAGE/vanquel-smsdb" "$PHONE_SSH:$REMOTE_STAGE/"
else
  # Rootful iOS 13 reports dpkg architecture iphoneos-arm while Theos emits
  # iphoneos-arm64 packages, so copy the already-signed staged files instead.
  STAGED="$STAGE/src/.theos/_/Library/MobileSubstrate/DynamicLibraries"
  "${SCP[@]}" "$STAGED/VanquelTweak.dylib" "$STAGED/VanquelTweak.plist" "$PHONE_SSH:$REMOTE_STAGE/"
fi

# The secret file: readable by mobile (SpringBoard) only.
printf '%s' "$TWEAK_SECRET" | "${SSH[@]}" "$PHONE_SSH" 'umask 077; cat > /var/mobile/.vanquel-tweak-secret.new'

say "saving the installed build in $BACKUP"
root_phone "set -e; mkdir -p $BACKUP; chmod 700 $BACKUP; if test -f $LIBDIR/VanquelTweak.dylib; then cp -p $LIBDIR/VanquelTweak.dylib $LIBDIR/VanquelTweak.plist $BACKUP/; fi; if test -f $HELPER; then cp -p $HELPER $BACKUP/; fi; mv /var/mobile/.vanquel-tweak-secret.new /var/mobile/.vanquel-tweak-secret; chown mobile:mobile /var/mobile/.vanquel-tweak-secret; chmod 600 /var/mobile/.vanquel-tweak-secret"

if [ "$JAILBREAK" = dopamine ]; then
  root_phone "set -e; mkdir -p /var/jb/usr/local/libexec; cp $REMOTE_STAGE/vanquel-smsdb $HELPER.new; chown root:wheel $HELPER.new; chmod 755 $HELPER.new; mv $HELPER.new $HELPER"
  case "$(phone "$HELPER status vanquel-selftest" || true)" in
    'OK found=0') say "sms.db helper self-test passed" ;;
    *) say "sms.db helper self-test failed; the tweak was not touched"; exit 3 ;;
  esac
fi

say "installing and restarting SpringBoard"
if [ "$SCHEME" = rootless ]; then
  root_phone "dpkg -i $REMOTE_STAGE/vanquel-tweak.deb"
else
  root_phone "set -e; cp $REMOTE_STAGE/VanquelTweak.dylib $REMOTE_STAGE/VanquelTweak.plist $LIBDIR/; chmod 755 $LIBDIR/VanquelTweak.dylib; chmod 644 $LIBDIR/VanquelTweak.plist; command -v ldid >/dev/null && ldid -S $LIBDIR/VanquelTweak.dylib || true"
fi
activate

if tweak_back; then
  say "PASS: /poc/ping and an authenticated /poc/message-status answer. Previous files in $BACKUP"
  say "now restart this line's bridge"
  exit 0
fi
say "the new tweak did not answer; putting the previous build back"
restore_from "$BACKUP"
tweak_back || say "the previous build did not answer either. Look at the phone: Safe Mode, or SpringBoard without tweaks (docs/PHONES.md)."
exit 3
