// ios/tweak/vanquel-smsdb.m
// -----------------------------------------------------------------------------
// vanquel-smsdb: answers the tweak's sms.db reads on Dopamine phones, where
// SpringBoard may not open sms.db (see SmsDbRead.h). Installed at
// /var/jb/usr/local/libexec/vanquel-smsdb, signed ad hoc with
// vanquel-smsdb.entitlements (Messages storage). Read-only.
//
//   vanquel-smsdb games <afterRowid> <limit>   -> JSON array (same as /poc/read-games)
//   vanquel-smsdb status <guid>                -> "OK found=..." (same as /poc/message-status)
//
// Built and installed by scripts/phone/install-tweak.sh when JAILBREAK=dopamine.
// -----------------------------------------------------------------------------
#import "SmsDbRead.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
    @autoreleasepool {
        NSString *out;
        if (argc == 4 && strcmp(argv[1], "games") == 0) {
            int limit = atoi(argv[3]);
            out = tweakSmsDbReadGames(atoll(argv[2]), (limit <= 0 || limit > 200) ? 25 : limit);
        } else if (argc == 3 && strcmp(argv[1], "status") == 0) {
            out = tweakSmsDbMessageStatus([NSString stringWithUTF8String:argv[2]]);
        } else {
            fputs("usage: vanquel-smsdb games <afterRowid> <limit> | status <guid>\n", stderr);
            return 64;
        }
        fputs(out.UTF8String, stdout);
        return [out hasPrefix:@"ERR"] ? 1 : 0;
    }
}
