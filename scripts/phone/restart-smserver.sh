#!/usr/bin/env bash
# scripts/phone/restart-smserver.sh <ssh-target>
#
# Restarts only the SMServer process. Its launchd daemon relaunches it within
# seconds. This is not a reboot and does not touch the jailbreak.
#
# When to use it: SMServer slowly rots after a week or two of uptime (iOS
# throttles it for CPU use). Sending keeps working but typing indicators and
# polling get flaky. A restart every few days, at a quiet hour, prevents it.
# After a restart, restart this line's bridge too (its login session died).
set -euo pipefail
TARGET="${1:?usage: restart-smserver.sh <ssh-target>}"
: "${PHONE_SUDO_PASS:?set PHONE_SUDO_PASS to the phone's mobile password}"
printf '%s\n' "$PHONE_SUDO_PASS" | ssh -o ConnectTimeout=10 "$TARGET" 'sudo -S killall SMServer'
echo "SMServer restarted. Check it with scripts/phone/check-line.sh in about 15 seconds."
