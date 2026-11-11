// ios/smserver-launch.c
// For Dopamine (iOS 15) phones only. iOS kept killing the SMServer daemon with
// JETSAM_REASON_MEMORY_PERPROCESSLIMIT because its effective memory limit was
// 6 MB, and launchd plist memory keys did not change that. This launcher runs
// as root from launchd, raises its own active/inactive memory limit to 64 MB,
// checks the limit took, drops to the mobile user, then execs SMServer with
// the same arguments. It aborts on any failure.
//
// Build on a Mac with Xcode installed:
//   xcrun --sdk iphoneos clang -arch arm64 -miphoneos-version-min=15.0 \
//     -Wall -Wextra -Werror -Os ios/smserver-launch.c -o smserver-launch
//   codesign --force --sign - smserver-launch
// Install root-owned, mode 755 (not setuid), under /var/jb, for example
// /var/jb/usr/local/libexec/smserver-launch. Executing an ad hoc binary from
// /var/mobile was killed with exit 137 in testing; /var/jb works.
//
//   smserver-launch --self-test     check the memory policy and privilege drop
//   smserver-launch --limits <pid>  read a running process's limits (as root)
//
// API layout: apple-oss-distributions/xnu, bsd/sys/kern_memorystatus.h
// (memorystatus_control commands 7 = set, 8 = get).

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pwd.h>
#include <grp.h>
#include <errno.h>
#include <sys/types.h>

#ifndef SMSERVER_PATH
#define SMSERVER_PATH "/var/jb/Applications/SMServer.app/SMServer"
#endif

extern int memorystatus_control(uint32_t, int32_t, uint32_t, void *, size_t);
typedef struct { int32_t active; uint32_t active_attr; int32_t inactive; uint32_t inactive_attr; } Limits;

static int read_limits(pid_t pid, Limits *limits) {
    return memorystatus_control(8, pid, 0, limits, sizeof(*limits));
}

int main(int argc, char **argv) {
    if (geteuid() != 0) { fputs("smserver-launch must be started by launchd as root\n", stderr); return 77; }
    if (argc == 3 && strcmp(argv[1], "--limits") == 0) {
        char *end = NULL; long pid = strtol(argv[2], &end, 10);
        if (!end || *end || pid <= 0 || pid > INT32_MAX) return 64;
        Limits current = {0};
        if (read_limits((pid_t)pid, &current) < 0) { perror("read process memory limits"); return 1; }
        printf("pid=%ld active=%dMB inactive=%dMB active_attr=%u inactive_attr=%u\n", pid, current.active, current.inactive, current.active_attr, current.inactive_attr);
        return 0;
    }
    Limits wanted = {64, 0, 64, 1}, actual = {0};
    if (memorystatus_control(7, getpid(), 0, &wanted, sizeof(wanted)) < 0) { perror("set memory limits"); return 1; }
    if (read_limits(getpid(), &actual) < 0 || actual.active != 64 || actual.inactive != 64) { fputs("memory limit verification failed\n", stderr); return 1; }
    struct passwd *mobile = getpwnam("mobile");
    if (!mobile || mobile->pw_uid != 501) { fputs("expected mobile account (uid 501) missing\n", stderr); return 1; }
    uid_t uid = mobile->pw_uid; gid_t gid = mobile->pw_gid;
    if (initgroups("mobile", gid) < 0 || setgid(gid) < 0 || setuid(uid) < 0 || getuid() != uid || geteuid() != uid) { perror("drop privileges to mobile"); return 1; }
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
        printf("PASS: active=%dMB inactive=%dMB uid=%u euid=%u gid=%u\n", actual.active, actual.inactive, getuid(), geteuid(), getgid());
        return 0;
    }
    argv[0] = SMSERVER_PATH;
    execv(argv[0], argv);
    perror("exec SMServer");
    return 1;
}
