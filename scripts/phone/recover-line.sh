#!/usr/bin/env bash
# scripts/phone/recover-line.sh <ssh-target> <palera1n|dopamine>
#
# Re-arms tweak injection on a phone whose jailbreak is still active but
# whose SMServer stopped (for example after SpringBoard crashed). It uses the
# jailbreak's OWN userspace reboot:
#   palera1n:  /cores/binpack/usr/sbin/p1ctl reboot-userspace
#   dopamine:  /var/jb/usr/bin/jbctl reboot_userspace
#
# It refuses, and tells you to re-jailbreak by hand, if the jailbreak is gone.
#
# HARD RULES this script follows, and you should too:
#   - Never run the stock `launchctl reboot userspace`: it restarts launchd
#     WITHOUT re-arming injection, which is how an outage starts.
#   - Never run `reboot` on a semi-tethered phone: the jailbreak is lost and
#     someone has to re-jailbreak it (over USB for palera1n/checkra1n).
#   - Never let two recoveries run on one phone at once. Stop anything else
#     that might act on this phone before you run this.
#
# The phone's sudo password is read from PHONE_SUDO_PASS and passed on stdin,
# never on the command line.
set -euo pipefail
TARGET="${1:?usage: recover-line.sh <ssh-target> <palera1n|dopamine>}"
KIND="${2:?usage: recover-line.sh <ssh-target> <palera1n|dopamine>}"
: "${PHONE_SUDO_PASS:?set PHONE_SUDO_PASS to the phone's mobile password}"
SSH=(ssh -o ConnectTimeout=10 -o BatchMode=no "$TARGET")

case "$KIND" in
  palera1n) CMD='/cores/binpack/usr/sbin/p1ctl reboot-userspace' ;;
  dopamine) CMD='/var/jb/usr/bin/jbctl reboot_userspace' ;;
  *) echo "unknown jailbreak type: $KIND (use palera1n or dopamine)" >&2; exit 64 ;;
esac

echo "Checking the jailbreak is still active..."
if ! STATE=$("${SSH[@]}" 'uptime; test -e /var/jb && echo "JB_PRESENT"' 2>/dev/null); then
  echo "Cannot reach the phone over SSH. Either Wi-Fi is down or the jailbreak dropped."
  echo "Re-jailbreak it by hand (docs/PHONES.md, 'After a full reboot'), then check again."
  exit 2
fi
echo "$STATE"
if ! grep -q "JB_PRESENT" <<<"$STATE"; then
  echo "/var/jb is missing: the jailbreak is gone. Re-jailbreak by hand; do not retry this script."
  exit 2
fi

echo "Running the userspace reboot ($KIND). The phone will be away for about two minutes."
printf '%s\n' "$PHONE_SUDO_PASS" | "${SSH[@]}" "sudo -S $CMD" || true
echo "Done. Wait about 90 seconds, then run scripts/phone/check-line.sh and restart this line's bridge."
