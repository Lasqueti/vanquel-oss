// ios/tweak/Tweak.m
// -----------------------------------------------------------------------------
// VanquelTweak: a small HTTP listener inside SpringBoard on a jailbroken iPhone
// line that sends what SMServer cannot: native app cards and balloons, photos
// (several files on ONE message), native voice notes, tapbacks, URL-preview
// cards, polls, plain text into groups, and two read-only sms.db reads
// (message status, inbound GamePigeon cards). See ios/tweak/README.md.
//
// BUILD VARIANTS (one source; every IMCore SPI is resolved at RUNTIME so the
//   same code drives every jailbreak):
//     * rootful (checkra1n, iOS 13): `make SCHEME=rootful`, installs to
//         /Library/MobileSubstrate/DynamicLibraries/. Capability bypass
//         free-ridden from libsmserver (-_capabilities==17159 for SpringBoard).
//     * rootless (palera1n or Dopamine, iOS 15/16): `make SCHEME=rootless`,
//         installs to /var/jb/Library/MobileSubstrate/DynamicLibraries/. On
//         iOS 15 libsmserver's unlock applies; on iOS 16 the capability bypass
//         (-processCapabilities==4485895 for SpringBoard) comes from IMCap
//         (ios/tweak/imcap/).
//   The only per-build value is TWEAK_LINE_NUMBER (the poll creatorHandle
//   fallback), which the Makefile requires. NEITHER build adds its own
//   capability hook: each free-rides an already-present SpringBoard unlock,
//   avoiding hook-ordering questions.
//
// HOST PROCESS: SpringBoard (com.apple.springboard). It used to ride MobileSMS,
//   but iOS suspends/jetsams the Messages app when it is backgrounded, which
//   made :8799 intermittently unreachable. iOS never suspends SpringBoard, so
//   hosting the listener there keeps :8799 (and the IMCore send/read path)
//   ALWAYS up. This mirrors SMServer, which runs its own IMCore inside
//   SpringBoard for exactly this reason (its libsmserver.plist filters
//   com.apple.springboard). We register NO MRYIPC center and NO class hooks, so
//   SMServer's com.ianwelker.smserver link is untouched: we are a pure additive
//   HTTP listener that reuses the ported IMCore send path. MobileSMS also runs
//   a listener on :8800, only for GamePigeon sends (see the ctor).
//
// SpringBoard is load-bearing: an uncaught exception here is a respring. Every
//   handler + the accept loop + the ctor is wrapped in @try/@catch, the ctor is
//   trivial and deferred, and the send path stays fail-closed behind the secret.
//
// The inline-image CARD path uses IMFileTransferCenter / IMDPersistentAttachment-
//   Controller (IMDPersistence.framework), which MobileSMS loaded natively but
//   SpringBoard may not. The ctor force-loads IMCore + IMDPersistence early and
//   logs whether the classes resolve (also surfaced on /poc/ping as im=...).
//
// PoC-2 (proven in production): send a PLAIN PHOTO via our OWN IMFileTransferCenter
//   chain and confirm it uploads (MMCS) + renders inline on a stock recipient.
// PoC-1: send a native FIRST-PARTY POLL balloon (com.apple.messages.Polls) via
//   balloonBundleID + payloadData on the outgoing IMMessage.
//
// ADDITIVE. Does NOT touch SMServer's own send path. HTTP on :8799:
//   GET  /poc/ping                                        (open, no auth)
//   POST /poc/send-photo   fields: to, filePath | filePaths="/a|/b|/c", audio
//                          (PoC-2; filePaths puts every file on ONE message so
//                           iMessage renders a stacked "3 Photos" bundle)
//   POST /poc/send-text    fields: to, text               (plain text, groups too)
//   POST /poc/send-poll    fields: to, question, options (PoC-1; options="a|b|c")
//   POST /poc/send-card    fields: to, bundleId, payloadFile, imageFile (Target B)
//   POST /poc/send-balloon fields: to, bundleId, payloadBase64, replyToGuid
//                          (replyToGuid: the inbound invite/move guid this reply
//                           UPDATES in place; empty => a fresh anchor balloon)
//   POST /poc/send-url-preview fields: to, url, payloadFile, faviconFile, heroFile
//   POST /poc/send-tapback fields: to, guid, type          (Heart etc.)
//   POST /poc/share-nickname fields: to, dryRun             (Name & Photo Sharing)
//   GET  /poc/read-games   params: afterRowid, limit -> JSON inbound GamePigeon cards
//   GET  /poc/message-status params: guid -> "OK found=1 rowid=.. sent=.. delivered=.. error=.. attachments=.."
// AUTH: every endpoint except /poc/ping requires the shared secret, sent as the
//   `X-Tweak-Secret:` header (or a `secret=` param). The secret lives on-phone at
//   /var/mobile/.vanquel-tweak-secret; the Mac bridge holds the matching value. Fails
//   CLOSED (rejects all sends) when that file is missing/empty.
//
// The IMCore send code is ported from the injected helper of the open-source
// imsg CLI (github.com/steipete/imsg, IMsgHelper/IMsgInjected.m) and adapted
// to iOS; the comments name the iOS versions where each branch was needed.
// -----------------------------------------------------------------------------

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <sqlite3.h>   // resolved at runtime from the dyld shared cache (SpringBoard links it too)
#include <spawn.h>
#include <fcntl.h>
#include <sys/wait.h>
#import "SmsDbRead.h"
extern char **environ;

// ---- Logging (writes to a file we can tail over SSH) --------------------
static void KBLog(NSString *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    NSString *msg = [[NSString alloc] initWithFormat:fmt arguments:ap];
    va_end(ap);
    NSString *line = [NSString stringWithFormat:@"[%@] %@\n", [NSDate date], msg];
    NSString *path = @"/tmp/vanquel-tweak.log";
    NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:path];
    if (!fh) {
        [[NSFileManager defaultManager] createFileAtPath:path contents:nil attributes:nil];
        fh = [NSFileHandle fileHandleForWritingAtPath:path];
    }
    @try { [fh seekToEndOfFile]; [fh writeData:[line dataUsingEncoding:NSUTF8StringEncoding]]; [fh closeFile]; }
    @catch (__unused NSException *e) {}
    NSLog(@"VanquelTweak: %@", msg);
}

// ---- Main-queue marshaling for every IMCore send -------------------------
// ROOT CAUSE (iPhone 8 on iOS 16): IMCore's -sendMessage: (and the
// iOS-16 transfer path it drives) calls dispatch_assert_queue() to enforce that
// it runs on IMCore's own serial queue, which on-device is pumped by the
// SpringBoard MAIN run loop. The HTTP accept loop / handleClient run on a GLOBAL
// concurrent worker thread, so calling sendMessage: inline there tripped
// dispatch_assert_queue_fail -> SIGTRAP -> a hard SpringBoard crash that the
// @try/@catch around sendMessage: CANNOT catch (it is __builtin_trap, not an
// NSException). iOS 13 has no such assertion, which is why the same
// code path is crash-free there. FIX: run the whole IMCore-touching send body on
// the main queue. dispatch_sync is safe here because handleClient always runs on
// the global queue (never main), so there is no self-deadlock; the send stays
// synchronous so handleClient can still return the result down the socket.
static NSString *tweakRunOnMainSync(NSString *(^block)(void)) {
    if ([NSThread isMainThread]) return block();
    __block NSString *result = nil;
    dispatch_sync(dispatch_get_main_queue(), ^{
        @try { result = block(); }
        @catch (NSException *ex) {
            KBLog(@"EXC on main-queue send: %@ %@", ex.name, ex.reason);
            result = [NSString stringWithFormat:@"ERR exception (main): %@", ex.reason];
        }
    });
    return result;
}

// ---- IMCore / IMDPersistence force-load (SpringBoard caveat) -------------
// SpringBoard does not natively link the IMCore + IMDPersistence attachment path
// the way MobileSMS did. Force-load the frameworks early so IMFileTransferCenter,
// IMDPersistentAttachmentController, IMMessage, and IMChatRegistry resolve before
// any send runs. On iOS 13 the Mach-O binaries live in the dyld shared cache, so
// [NSBundle load] dlopen's the framework and the classes resolve from the cache.
// Everything here is wrapped so a missing framework can NEVER crash SpringBoard;
// if a class stays unresolved the CARD path just fails closed at send time.
//
// tweakImStatus is a short human-readable summary of what resolved, surfaced on
// /poc/ping (im=...) so the make-or-break test can confirm the load from the Mac
// without SSHing in to read the log. It never contains secrets.
static NSString *tweakImStatus = @"im:not-loaded";

static void tweakForceLoadIMFrameworks(void) {
    @try {
        NSArray<NSString *> *paths = @[
            @"/System/Library/PrivateFrameworks/IMCore.framework",
            @"/System/Library/PrivateFrameworks/IMDPersistence.framework",
            @"/System/Library/PrivateFrameworks/IMSharedUtilities.framework",
            @"/System/Library/PrivateFrameworks/IMFoundation.framework",
            @"/System/Library/PrivateFrameworks/IMDaemonCore.framework",
        ];
        for (NSString *p in paths) {
            @try {
                NSBundle *b = [NSBundle bundleWithPath:p];
                BOOL ok = b ? [b load] : NO;
                KBLog(@"force-load %@ -> %@", [p lastPathComponent], ok ? @"loaded" : (b ? @"already/failed" : @"no-bundle"));
            } @catch (NSException *ex) {
                KBLog(@"EXC force-load %@: %@ %@", [p lastPathComponent], ex.name, ex.reason);
            }
        }
        // Verify the exact classes the send/card path needs.
        BOOL ftc = NSClassFromString(@"IMFileTransferCenter") != nil;
        BOOL pac = NSClassFromString(@"IMDPersistentAttachmentController") != nil;
        BOOL msg = NSClassFromString(@"IMMessage") != nil;
        BOOL reg = NSClassFromString(@"IMChatRegistry") != nil;
        BOOL acc = NSClassFromString(@"IMAccountController") != nil;
        tweakImStatus = [NSString stringWithFormat:@"im:ftc=%d,pac=%d,msg=%d,reg=%d,acc=%d",
                        ftc, pac, msg, reg, acc];
        KBLog(@"IM class resolution -> %@", tweakImStatus);
        if (!(ftc && pac && msg && reg)) {
            KBLog(@"WARNING: inline-card path classes did not fully resolve in this process; CARD sends will fail closed. Poll/game payload sends that need no attachment may still work if msg+reg resolved.");
        }
    } @catch (NSException *ex) {
        tweakImStatus = @"im:load-exception";
        KBLog(@"EXC tweakForceLoadIMFrameworks: %@ %@", ex.name, ex.reason);
    }
}

// ---- IMDaemon connect (SpringBoard caveat #2) ---------------------------
// The classes resolve in SpringBoard, but IMChatRegistry starts EMPTY there:
// MobileSMS connects to imagent (the IMDaemon) on launch and loads all chats,
// so existingChatWithGUID:/chatForIMHandle: work. SpringBoard does not do that
// for us, so a card send hit "could not resolve chat" until we connect the
// daemon ourselves. This mirrors the upstream ported bootstrap
// (IMsgInjected.m bridgeBootstrap -> [[IMDaemonController sharedInstance]
// connectToDaemon]). Idempotent: connecting an already-connected controller is
// a no-op, so we can also call this defensively right before a send.
static void tweakConnectIMDaemon(void) {
    @try {
        Class daemonClass = NSClassFromString(@"IMDaemonController");
        if (!daemonClass) { KBLog(@"IMDaemonController class not found (cannot warm registry)"); return; }
        id daemon = [daemonClass performSelector:@selector(sharedInstance)];
        if (!daemon) { KBLog(@"IMDaemonController sharedInstance nil"); return; }
        // Use the same plain connectToDaemon the upstream bootstrap proved on this
        // iOS 13.7 build (IMsgInjected.m bridgeBootstrap). Avoid the richer
        // connectToDaemonWithLaunch:capabilities:… variant - its capabilities
        // argument encoding differs across versions and is an unnecessary risk in
        // SpringBoard. Fall back to autoConnect only if connectToDaemon is absent.
        if ([daemon respondsToSelector:@selector(connectToDaemon)]) {
            [daemon performSelector:@selector(connectToDaemon)];
            KBLog(@"IMDaemon connect via connectToDaemon");
        } else if ([daemon respondsToSelector:@selector(autoConnect)]) {
            [daemon performSelector:@selector(autoConnect)];
            KBLog(@"IMDaemon connect via autoConnect");
        } else {
            KBLog(@"IMDaemonController has no known connect selector");
            return;
        }
        // Log how many chats the registry now sees (confirms the warm-up).
        Class regClass = NSClassFromString(@"IMChatRegistry");
        id reg = regClass ? [regClass performSelector:@selector(sharedInstance)] : nil;
        if (reg && [reg respondsToSelector:@selector(allExistingChats)]) {
            NSArray *chats = [reg performSelector:@selector(allExistingChats)];
            KBLog(@"IMChatRegistry after connect: %lu existing chat(s)", (unsigned long)chats.count);
        }
    } @catch (NSException *ex) {
        KBLog(@"EXC tweakConnectIMDaemon: %@ %@", ex.name, ex.reason);
    }
}

// ---- Shared-secret auth -------------------------------------------------
// Every SEND endpoint requires a matching secret (header `X-Tweak-Secret:` or a
// `secret=` param). The secret lives in a file on the phone that only `mobile`
// can read; the Mac bridge holds the same value and sends it on every call.
// FAIL CLOSED: if the secret file is missing/empty, all sends are rejected
// (only /poc/ping stays open). This is a LAN-exposed listener, so no auth = no
// sends. Re-read from disk each request so rotating the file needs no relaunch.
static NSString *TWEAK_SECRET_PATH = @"/var/mobile/.vanquel-tweak-secret";
static int tweakHTTPPort = 8799;
static NSString *tweakHostProcess = @"SpringBoard";

static NSString *tweakLoadSecret(void) {
    NSError *err = nil;
    NSString *s = [NSString stringWithContentsOfFile:TWEAK_SECRET_PATH
                                            encoding:NSUTF8StringEncoding
                                               error:&err];
    if (!s) return @"";
    return [s stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

// Constant-time-ish compare so a timing side-channel can't leak the secret.
static BOOL tweakSecretEquals(NSString *a, NSString *b) {
    if (!a || !b) return NO;
    NSData *da = [a dataUsingEncoding:NSUTF8StringEncoding];
    NSData *db = [b dataUsingEncoding:NSUTF8StringEncoding];
    if (da.length != db.length) return NO;
    if (da.length == 0) return NO;
    const unsigned char *pa = da.bytes, *pb = db.bytes;
    unsigned char diff = 0;
    for (NSUInteger i = 0; i < da.length; i++) diff |= (pa[i] ^ pb[i]);
    return diff == 0;
}

// Pull a header value out of a raw HTTP request (case-insensitive name match).
static NSString *tweakHeaderValue(NSString *req, NSString *name) {
    NSArray *lines = [req componentsSeparatedByString:@"\r\n"];
    NSString *prefix = [name stringByAppendingString:@":"];
    for (NSString *ln in lines) {
        if (ln.length == 0) break;  // blank line == end of headers
        if ([ln rangeOfString:prefix options:NSCaseInsensitiveSearch].location == 0) {
            NSString *v = [ln substringFromIndex:prefix.length];
            return [v stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        }
    }
    return nil;
}

// ---- IMCore interface (subset ported from IMsgInjected.m) ---------------
@interface IMFileTransfer : NSObject
- (NSString *)guid;
- (NSURL *)localURL;
- (void)setLocalURL:(NSURL *)url;
// Hides the .pluginPayloadAttachment transfer from the bubble (chat.db
// hide_attachment column). Used by the URL-preview card so the favicon/hero ride
// as ORDERED substitute images, not as visible attachments.
- (void)setHideAttachment:(BOOL)hide;
@end

@interface IMFileTransferCenter : NSObject
+ (instancetype)sharedInstance;
- (NSString *)guidForNewOutgoingTransferWithLocalURL:(NSURL *)url;
- (IMFileTransfer *)transferForGUID:(NSString *)guid;
- (void)retargetTransfer:(NSString *)guid toPath:(NSString *)path;
- (void)registerTransferWithDaemon:(NSString *)guid;
@end

// ---- Chat resolution (ported) -------------------------------------------
// Single attempt: existingChatWithGUID: first, then materialize from the handle.
static id resolveChatByGuidOnce(NSString *chatGuid) {
    Class registryClass = NSClassFromString(@"IMChatRegistry");
    if (!registryClass) { KBLog(@"no IMChatRegistry"); return nil; }
    id registry = [registryClass performSelector:@selector(sharedInstance)];
    if (!registry) { KBLog(@"no chatRegistry sharedInstance"); return nil; }
    if ([registry respondsToSelector:@selector(existingChatWithGUID:)]) {
        id chat = [registry performSelector:@selector(existingChatWithGUID:) withObject:chatGuid];
        if (chat) { KBLog(@"resolved existing chat for %@", chatGuid); return chat; }
    }
    // Fallback: materialize a chat from the trailing address.
    NSArray *parts = [chatGuid componentsSeparatedByString:@";"];
    if (parts.count == 3) {
        NSString *address = parts.lastObject;
        // SMServer's proven tapback path resolves one-to-one chats by their bare
        // chat_identifier (the phone number), not by the full iMessage;-; GUID.
        // On a cold SpringBoard registry existingChatWithGUID: can miss even
        // though the conversation is present; try the direct identifier before
        // materializing a new chat from IMHandleRegistrar.
        SEL identifierSel = NSSelectorFromString(@"existingChatWithChatIdentifier:");
        if ([registry respondsToSelector:identifierSel]) {
            id chat = ((id (*)(id, SEL, id))objc_msgSend)(registry, identifierSel, address);
            if (chat) { KBLog(@"resolved existing chat by identifier for %@", address); return chat; }
        }
        Class hrClass = NSClassFromString(@"IMHandleRegistrar");
        if (hrClass) {
            id hr = [hrClass performSelector:@selector(sharedInstance)];
            if ([hr respondsToSelector:@selector(IMHandleWithID:)]) {
                id handle = [hr performSelector:@selector(IMHandleWithID:) withObject:address];
                if (handle && [registry respondsToSelector:@selector(chatForIMHandle:)]) {
                    id chat = [registry performSelector:@selector(chatForIMHandle:) withObject:handle];
                    if (chat) { KBLog(@"materialized chat via handle for %@", address); return chat; }
                }
            }
        }
    }
    return nil;
}

// SpringBoard-robust wrapper: IMChatRegistry only populates once we are connected
// to imagent, and the load is async, so a cold first send can beat it. Try once;
// if it misses, (re)connect the daemon and retry a few times with a short wait.
// Connecting an already-connected controller is a no-op, so this is cheap on the
// hot path (the first try almost always wins once the boot-time connect has run).
static id resolveChatByGuid(NSString *chatGuid) {
    if (![chatGuid isKindOfClass:[NSString class]] || chatGuid.length == 0) return nil;
    id chat = resolveChatByGuidOnce(chatGuid);
    if (chat) return chat;
    for (int attempt = 0; attempt < 5 && !chat; attempt++) {
        KBLog(@"chat %@ not resolved yet (attempt %d) - ensuring IMDaemon connection", chatGuid, attempt);
        tweakConnectIMDaemon();
        usleep(400000); // 0.4s for the registry to catch up
        chat = resolveChatByGuidOnce(chatGuid);
    }
    if (!chat) KBLog(@"could not resolve chat for %@", chatGuid);
    return chat;
}

// ---- Native iMessage Name & Photo Sharing ------------------------------
// Apple keeps this as a per-chat allow-list in IMNicknameController. The exact
// selector differs by OS: iOS 13 uses whitelistHandles..., while iOS 15/16 use
// allowHandles.... Both were runtime-verified on the supported phones as
// void methods taking (handles, chat). This path is deliberately conservative:
// it runs on SpringBoard's main queue, checks every runtime object, and fails
// closed before invoking private SPI. dryRun=1 exercises all lookups without
// changing sharing state, which gives operations a safe post-deploy probe.
static NSString *pocShareNickname(NSString *to, BOOL dryRun) {
    if (!to.length) return @"ERR missing to";

    NSString *chatGuid = [to containsString:@";"] ? to : [NSString stringWithFormat:@"iMessage;-;%@", to];
    id chat = resolveChatByGuid(chatGuid);
    if (!chat) return @"ERR could not resolve chat";

    Class controllerClass = NSClassFromString(@"IMNicknameController");
    SEL sharedSel = NSSelectorFromString(@"sharedInstance");
    if (!controllerClass || ![(id)controllerClass respondsToSelector:sharedSel])
        return @"ERR nickname controller unavailable";
    id controller = ((id (*)(id, SEL))objc_msgSend)((id)controllerClass, sharedSel);
    if (!controller) return @"ERR nickname controller unavailable";

    SEL featureSel = NSSelectorFromString(@"_nicknameFeatureEnabled");
    BOOL featureEnabled = [controller respondsToSelector:featureSel]
        ? ((BOOL (*)(id, SEL))objc_msgSend)(controller, featureSel) : NO;
    if (!featureEnabled) return @"ERR nickname feature disabled";

    SEL personalSel = NSSelectorFromString(@"personalNickname");
    id personal = [controller respondsToSelector:personalSel]
        ? ((id (*)(id, SEL))objc_msgSend)(controller, personalSel) : nil;
    if (!personal) {
        // SpringBoard can have the feature flag and My Card configured while its
        // client-side controller has not fetched the personal nickname from the
        // daemon yet. Kick the controller's own cache refresh and ask the bridge
        // to retry; never synthesize or set a nickname ourselves.
        SEL updateSel = NSSelectorFromString(@"_updatePersonalNicknameWithMeCardIfNecessary");
        if ([controller respondsToSelector:updateSel])
            ((void (*)(id, SEL))objc_msgSend)(controller, updateSel);
        SEL fetchSel = NSSelectorFromString(@"fetchPersonalNicknameWithCompletion:");
        if ([controller respondsToSelector:fetchSel]) {
            void (^completion)(void) = ^{
                KBLog(@"personal nickname fetch completed; next request will re-check identity");
            };
            ((void (*)(id, SEL, id))objc_msgSend)(controller, fetchSel, completion);
            KBLog(@"personal nickname not cached; requested controller refresh for %@", to);
            return @"ERR personal nickname loading";
        }
        return @"ERR personal nickname unavailable";
    }

    SEL participantsSel = NSSelectorFromString(@"participants");
    id handles = [chat respondsToSelector:participantsSel]
        ? ((id (*)(id, SEL))objc_msgSend)(chat, participantsSel) : nil;
    NSUInteger handleCount = [handles respondsToSelector:@selector(count)]
        ? ((NSUInteger (*)(id, SEL))objc_msgSend)(handles, @selector(count)) : 0;
    if (!handles || handleCount == 0) return @"ERR chat has no participants";

    SEL shareSel = NSSelectorFromString(@"allowHandlesForNicknameSharing:forChat:");
    if (![controller respondsToSelector:shareSel])
        shareSel = NSSelectorFromString(@"whitelistHandlesForNicknameSharing:forChat:");
    if (![controller respondsToSelector:shareSel])
        return @"ERR nickname share selector unavailable";

    NSString *selectorName = NSStringFromSelector(shareSel);
    if (dryRun) {
        KBLog(@"nickname share dry-run ready selector=%@ participants=%lu to=%@",
              selectorName, (unsigned long)handleCount, to);
        return [NSString stringWithFormat:@"OK ready selector=%@ participants=%lu personal=1",
                selectorName, (unsigned long)handleCount];
    }

    ((void (*)(id, SEL, id, id))objc_msgSend)(controller, shareSel, handles, chat);
    KBLog(@"native nickname share authorized selector=%@ participants=%lu to=%@",
          selectorName, (unsigned long)handleCount, to);
    return [NSString stringWithFormat:@"OK shared selector=%@ participants=%lu",
            selectorName, (unsigned long)handleCount];
}

// ---- Native tapback ----------------------------------------------------
// SMServer's MRYIPC tapback handler runs this IMCore operation off SpringBoard's
// required queue on iOS 15 and hard-resprings the phone. This endpoint
// performs the same documented IMCore operation through tweakRunOnMainSync, like
// every other proven native send in this tweak. Every lookup fails closed.
static NSString *pocSendTapback(NSString *to, NSString *messageGuid, NSString *typeName) {
    if (!to.length || !messageGuid.length) return @"ERR missing to/guid";
    NSDictionary *types = @{
        @"love": @2000, @"heart": @2000, @"like": @2001,
        @"dislike": @2002, @"laugh": @2003, @"emphasize": @2004,
        @"question": @2005,
    };
    NSNumber *ackNumber = types[[typeName.lowercaseString stringByTrimmingCharactersInSet:
                                  [NSCharacterSet whitespaceAndNewlineCharacterSet]]];
    if (!ackNumber) return @"ERR unsupported tapback type";

    NSString *guid = [messageGuid stringByTrimmingCharactersInSet:
                      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
    NSRange slash = [guid rangeOfString:@"/"];
    if (slash.location != NSNotFound) guid = [guid substringFromIndex:slash.location + 1];
    NSString *chatGuid = [to containsString:@";"] ? to : [NSString stringWithFormat:@"iMessage;-;%@", to];
    id chat = resolveChatByGuid(chatGuid);
    if (!chat) return @"ERR could not resolve chat";

    @try {
        SEL loadSel = NSSelectorFromString(@"loadMessagesUpToGUID:date:limit:loadImmediately:");
        if ([chat respondsToSelector:loadSel]) {
            ((void (*)(id, SEL, id, id, id, BOOL))objc_msgSend)(chat, loadSel, guid, nil, nil, YES);
        }
        SEL itemSel = NSSelectorFromString(@"messageItemForGUID:");
        id item = nil;
        if ([chat respondsToSelector:itemSel]) {
            item = ((id (*)(id, SEL, id))objc_msgSend)(chat, itemSel, guid);
        } else {
            // iOS 13 has no messageItemForGUID: anywhere in its
            // shared cache, so every tapback there failed this lookup. Its
            // IMChat hands back the IMMessage instead, which wraps the same
            // IMMessageItem.
            SEL messageSel = NSSelectorFromString(@"messageForGUID:");
            SEL wrappedSel = NSSelectorFromString(@"_imMessageItem");
            id message = [chat respondsToSelector:messageSel]
                ? ((id (*)(id, SEL, id))objc_msgSend)(chat, messageSel, guid) : nil;
            id wrapped = [message respondsToSelector:wrappedSel]
                ? ((id (*)(id, SEL))objc_msgSend)(message, wrappedSel) : nil;
            Class itemClass = NSClassFromString(@"IMMessageItem");
            if (itemClass && [wrapped isKindOfClass:itemClass]) item = wrapped;
        }
        if (!item) return @"ERR message item not loaded";

        id body = [item respondsToSelector:@selector(body)]
            ? ((id (*)(id, SEL))objc_msgSend)(item, @selector(body)) : nil;
        id subject = [item respondsToSelector:@selector(subject)]
            ? ((id (*)(id, SEL))objc_msgSend)(item, @selector(subject)) : nil;
        NSString *bodyString = [body respondsToSelector:@selector(string)]
            ? ((id (*)(id, SEL))objc_msgSend)(body, @selector(string))
            : ([body isKindOfClass:[NSString class]] ? body : @"");

        Class partClass = NSClassFromString(@"IMTextMessagePartChatItem");
        SEL initSel = NSSelectorFromString(@"_initWithItem:text:index:messagePartRange:subject:");
        // iOS 16 dropped that initializer for one that also takes
        // isShowingEditHistory:. A tapback targets the current text, so NO.
        SEL editInitSel = NSSelectorFromString(@"_initWithItem:text:index:messagePartRange:subject:isShowingEditHistory:");
        id allocated = partClass ? [partClass alloc] : nil;
        NSRange partRange = NSMakeRange(0, [bodyString length]);
        id part = nil;
        if ([allocated respondsToSelector:initSel]) {
            part = ((id (*)(id, SEL, id, id, NSInteger, NSRange, id))objc_msgSend)(
                allocated, initSel, item, body, 0, partRange, subject);
        } else if ([allocated respondsToSelector:editInitSel]) {
            part = ((id (*)(id, SEL, id, id, NSInteger, NSRange, id, BOOL))objc_msgSend)(
                allocated, editInitSel, item, body, 0, partRange, subject, NO);
        } else {
            return @"ERR tapback part class unavailable";
        }
        if (!part) return @"ERR could not build tapback part";

        // iOS 13 may only know this call by its older name; same arguments.
        SEL ackSel = NSSelectorFromString(@"sendMessageAcknowledgment:forChatItem:withAssociatedMessageInfo:");
        if (![chat respondsToSelector:ackSel])
            ackSel = NSSelectorFromString(@"sendMessageAcknowledgment:forChatItem:withMessageSummaryInfo:");
        NSDictionary *info = @{ @"amc": @1, @"ams": bodyString ?: @"" };
        if ([chat respondsToSelector:ackSel]) {
            ((void (*)(id, SEL, long long, id, id))objc_msgSend)(
                chat, ackSel, [ackNumber longLongValue], part, info);
        } else {
            // iOS 16 has neither on IMChat (its remaining ack calls are
            // ChatKit's and want a CKChatItem). IMCore sends one through
            // IMTapbackSender, built from an IMTapback and the same part.
            Class tapbackClass = NSClassFromString(@"IMTapback");
            Class senderClass = NSClassFromString(@"IMTapbackSender");
            SEL tapbackSel = NSSelectorFromString(@"tapbackWithAssociatedMessageType:messageSummaryInfo:");
            SEL senderInitSel = NSSelectorFromString(@"initWithTapback:chat:messagePartChatItem:");
            SEL sendSel = NSSelectorFromString(@"send");
            id tapback = [tapbackClass respondsToSelector:tapbackSel]
                ? ((id (*)(id, SEL, long long, id))objc_msgSend)(tapbackClass, tapbackSel, [ackNumber longLongValue], info) : nil;
            id sender = senderClass ? [senderClass alloc] : nil;
            if (!tapback || ![sender respondsToSelector:senderInitSel]) return @"ERR tapback selector unavailable";
            sender = ((id (*)(id, SEL, id, id, id))objc_msgSend)(sender, senderInitSel, tapback, chat, part);
            if (![sender respondsToSelector:sendSel]) return @"ERR tapback selector unavailable";
            ((void (*)(id, SEL))objc_msgSend)(sender, sendSel);
        }
        KBLog(@"native tapback dispatched type=%@ guid=%@ to=%@", typeName, guid, to);
        return @"OK sent tapback";
    } @catch (NSException *ex) {
        KBLog(@"EXC native tapback: %@ %@", ex.name, ex.reason);
        return [NSString stringWithFormat:@"ERR tapback exception: %@", ex.reason];
    }
}

// ---- Attachment attributedBody (ported) - PoC-2 photo -------------------
static NSAttributedString *buildAttachmentAttributed(NSString *transferGuid,
                                                     NSString *filename,
                                                     NSInteger partIndex) {
    NSDictionary *attrs = @{
        @"__kIMBaseWritingDirectionAttributeName": @"-1",
        @"__kIMFileTransferGUIDAttributeName": transferGuid ?: @"",
        @"__kIMFilenameAttributeName": filename ?: @"",
        @"__kIMMessagePartAttributeName": @(partIndex),
    };
    unichar ofc = 0xFFFC;  // object replacement character
    NSString *glyph = [NSString stringWithCharacters:&ofc length:1];
    return [[NSAttributedString alloc] initWithString:glyph attributes:attrs];
}

// ---- Breadcrumb attributedBody (ported) - balloon body (no transfer) ----
// Mirrors buildPollBreadcrumbAttributed (IMsgInjected.m:972): a single U+FFFD
// run carrying the breadcrumb marker. Used by every plain balloon (poll,
// GamePigeon). Marker is caller-chosen so the visible label matches the card.
static NSAttributedString *buildBalloonBreadcrumbAttributed(NSString *marker) {
    unichar rc = 0xFFFD;  // replacement character
    NSString *placeholder = [NSString stringWithCharacters:&rc length:1];
    NSDictionary *attrs = @{
        @"__kIMMessagePartAttributeName": @0,
        @"__kIMBreadcrumbTextMarkerAttributeName": marker.length ? marker : @"Sent a message",
        @"__kIMBreadcrumbTextOptionFlags": @0
    };
    return [[NSAttributedString alloc] initWithString:placeholder attributes:attrs];
}

// ---- Card attributedBody (ported: buildBalloonCardAttributed :2658) -------
// Two runs: [0] U+FFFD breadcrumb, [1] U+FFFC attachment carrying the hidden
// image transfer GUID. This is what makes a card render its FULL image
// INLINE (not the app icon). Target B.
static NSAttributedString *buildBalloonCardAttributed(NSString *marker, NSString *transferGuid) {
    NSMutableAttributedString *body = [[NSMutableAttributedString alloc] init];
    unichar rc = 0xFFFD;
    NSString *crumbGlyph = [NSString stringWithCharacters:&rc length:1];
    NSDictionary *crumbAttrs = @{
        @"__kIMBaseWritingDirectionAttributeName": @(-1),
        @"__kIMBreadcrumbTextMarkerAttributeName": marker.length ? marker : @"Sent a message",
        @"__kIMBreadcrumbTextOptionFlags": @0,
        @"__kIMMessagePartAttributeName": @0
    };
    [body appendAttributedString:[[NSAttributedString alloc] initWithString:crumbGlyph attributes:crumbAttrs]];

    unichar ofc = 0xFFFC;
    NSString *objGlyph = [NSString stringWithCharacters:&ofc length:1];
    NSDictionary *attachAttrs = @{
        @"__kIMFileTransferGUIDAttributeName": transferGuid ?: @"",
        @"__kIMMessagePartAttributeName": @1
    };
    [body appendAttributedString:[[NSAttributedString alloc] initWithString:objGlyph attributes:attachAttrs]];
    return body;
}

// ---- Rich-link URL attributedBody (ported: buildRichLinkURLAttributed :4416) --
// The URL-preview CARD body: the URL text itself tagged as a rich link (NO
// U+FFFC attachment glyphs). Image ordering is entirely the fileTransferGUIDs
// array (favicon idx0, hero idx1), which the recipient's URLBalloonProvider maps
// onto richLinkImageAttachmentSubstituteIndex. Ported verbatim from the Mac
// handleSendURLPreview path (pure Foundation). Maps rich-link card only.
static NSAttributedString *buildRichLinkURLAttributed(NSString *urlText, NSData *dataDetected) {
    if (![urlText isKindOfClass:[NSString class]]) urlText = @"";
    NSMutableDictionary *attrs = [@{
        @"__kIMMessagePartAttributeName": @0,
        @"__kIMBaseWritingDirectionAttributeName": @"-1",
        @"__kIMLinkIsRichLinkAttributeName": @YES,
    } mutableCopy];
    NSURL *url = urlText.length ? [NSURL URLWithString:urlText] : nil;
    if (url) attrs[@"__kIMLinkAttributeName"] = url;
    if (dataDetected.length) attrs[@"__kIMDataDetectedAttributeName"] = dataDetected;
    return [[NSAttributedString alloc] initWithString:urlText attributes:attrs];
}

// ---- Outgoing transfer staging (ported, iOS 3-arg persistent path) ------
static void retargetPreparedTransfer(id ftc, IMFileTransfer *transfer,
                                     NSString *transferGuid, NSString *path) {
    if (!path.length) return;
    if ([ftc respondsToSelector:@selector(retargetTransfer:toPath:)]) {
        NSMethodSignature *rsig = [ftc methodSignatureForSelector:@selector(retargetTransfer:toPath:)];
        NSInvocation *rinv = [NSInvocation invocationWithMethodSignature:rsig];
        [rinv setSelector:@selector(retargetTransfer:toPath:)];
        [rinv setTarget:ftc];
        __unsafe_unretained NSString *g = transferGuid; __unsafe_unretained NSString *p = path;
        [rinv setArgument:&g atIndex:2]; [rinv setArgument:&p atIndex:3];
        [rinv invoke];
    }
    if ([transfer respondsToSelector:@selector(setLocalURL:)]) {
        [transfer performSelector:@selector(setLocalURL:) withObject:[NSURL fileURLWithPath:path]];
    }
}

// ---- Persistent-path staging (iOS 13/15 3-arg AND iOS 16+ 5-arg) --------
// The attachment must be copied into IMD's per-chat persistent store path or
// imagent cannot upload it. iOS 13.7 exposes the 3-arg
// _persistentPathForTransfer:filename:highQuality:. iOS 16 DROPPED
// that and uses the 5-arg _persistentPathForTransfer:filename:highQuality:
// chatGUID:storeAtExternalPath: form (same as macOS 26 in IMsgInjected.m:3295).
// Try the 3-arg first, then the 5-arg. Returns YES only if the file was actually
// copied into a persistent path AND the transfer retargeted. On iOS 16 the old
// code left the file at /var/mobile and proceeded, which CRASHED SpringBoard in
// sendMessage:; callers now abort the card send when this returns NO.
static BOOL tweakStageTransferPersistentPath(id pac, id ftc, IMFileTransfer *transfer,
                                            NSString *transferGuid, NSURL *originalURL,
                                            NSString *filename, NSString *chatGuid) {
    if (!pac) return NO;
    NSString *fn = filename ?: [originalURL lastPathComponent];

    // Resolve the persistent path via whichever selector this iOS exposes.
    NSString *persistentPath = nil;
    SEL sel3 = @selector(_persistentPathForTransfer:filename:highQuality:);
    SEL sel5 = @selector(_persistentPathForTransfer:filename:highQuality:chatGUID:storeAtExternalPath:);
    if ([pac respondsToSelector:sel3]) {
        @try {
            NSMethodSignature *sig = [pac methodSignatureForSelector:sel3];
            NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
            [inv setSelector:sel3]; [inv setTarget:pac];
            __unsafe_unretained IMFileTransfer *xfer = transfer;
            __unsafe_unretained NSString *fnr = fn; BOOL hi = YES;
            [inv setArgument:&xfer atIndex:2]; [inv setArgument:&fnr atIndex:3]; [inv setArgument:&hi atIndex:4];
            [inv retainArguments]; [inv invoke];
            __unsafe_unretained NSString *raw = nil; [inv getReturnValue:&raw];
            persistentPath = raw;
            KBLog(@"persistentPath(3arg)=%@", persistentPath ?: @"(nil)");
        } @catch (NSException *ex) { KBLog(@"EXC 3arg persistentPath: %@ %@", ex.name, ex.reason); }
    } else if ([pac respondsToSelector:sel5]) {
        @try {
            NSMethodSignature *sig = [pac methodSignatureForSelector:sel5];
            NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
            [inv setSelector:sel5]; [inv setTarget:pac];
            __unsafe_unretained IMFileTransfer *xfer = transfer;
            __unsafe_unretained NSString *fnr = fn;
            __unsafe_unretained NSString *cg = chatGuid;
            BOOL hi = YES; BOOL ext = YES;
            [inv setArgument:&xfer atIndex:2]; [inv setArgument:&fnr atIndex:3]; [inv setArgument:&hi atIndex:4];
            [inv setArgument:&cg atIndex:5]; [inv setArgument:&ext atIndex:6];
            [inv retainArguments]; [inv invoke];
            __unsafe_unretained NSString *raw = nil; [inv getReturnValue:&raw];
            persistentPath = raw;
            KBLog(@"persistentPath(5arg,iOS16)=%@", persistentPath ?: @"(nil)");
        } @catch (NSException *ex) { KBLog(@"EXC 5arg persistentPath: %@ %@", ex.name, ex.reason); }
    } else {
        KBLog(@"IMDPersistentAttachmentController has NEITHER 3-arg NOR 5-arg _persistentPathForTransfer:");
        return NO;
    }

    if (!persistentPath.length) return NO;

    // Copy the file into the persistent path and retarget the transfer.
    NSError *e = nil;
    NSURL *pURL = [NSURL fileURLWithPath:persistentPath];
    [[NSFileManager defaultManager] createDirectoryAtURL:[pURL URLByDeletingLastPathComponent]
        withIntermediateDirectories:YES attributes:nil error:&e];
    if (e) { KBLog(@"mkdir persistentPath parent failed: %@", e.localizedDescription); return NO; }
    if ([[NSFileManager defaultManager] fileExistsAtPath:persistentPath])
        [[NSFileManager defaultManager] removeItemAtURL:pURL error:NULL];
    [[NSFileManager defaultManager] copyItemAtURL:originalURL toURL:pURL error:&e];
    if (e) { KBLog(@"copy to persistentPath failed: %@", e.localizedDescription); return NO; }
    retargetPreparedTransfer(ftc, transfer, transferGuid, persistentPath);
    return YES;
}

static IMFileTransfer *prepareOutgoingTransfer(NSURL *originalURL, NSString *filename,
                                               NSString *chatGuid, NSString **outErr) {
    Class ftcClass = NSClassFromString(@"IMFileTransferCenter");
    if (!ftcClass) { if (outErr) *outErr = @"IMFileTransferCenter not available"; return nil; }
    id ftc = [ftcClass performSelector:@selector(sharedInstance)];
    if (!ftc) { if (outErr) *outErr = @"FileTransferCenter unavailable"; return nil; }
    if (![ftc respondsToSelector:@selector(guidForNewOutgoingTransferWithLocalURL:)]) {
        if (outErr) *outErr = @"guidForNewOutgoingTransferWithLocalURL: unavailable"; return nil;
    }
    id rawGuid = [ftc performSelector:@selector(guidForNewOutgoingTransferWithLocalURL:) withObject:originalURL];
    if (![rawGuid isKindOfClass:[NSString class]] || ![(NSString *)rawGuid length]) {
        if (outErr) *outErr = @"Could not allocate transfer guid"; return nil;
    }
    NSString *transferGuid = (NSString *)rawGuid;
    KBLog(@"allocated transferGuid=%@", transferGuid);

    IMFileTransfer *transfer = nil;
    if ([ftc respondsToSelector:@selector(transferForGUID:)]) {
        transfer = [ftc performSelector:@selector(transferForGUID:) withObject:transferGuid];
    }
    if (!transfer) { if (outErr) *outErr = @"Could not resolve IMFileTransfer for guid"; return nil; }

    Class pacClass = NSClassFromString(@"IMDPersistentAttachmentController");
    id pac = pacClass ? [pacClass performSelector:@selector(sharedInstance)] : nil;
    BOOL staged = tweakStageTransferPersistentPath(pac, ftc, transfer, transferGuid, originalURL, filename, chatGuid);

    // CRASH-SAFE (iOS 16): if we could NOT stage the file into IMD's persistent
    // store, DO NOT proceed. On iOS 13 staging always succeeds; on iOS 16 the
    // persistent-path selector differs and, when staging failed, the old code
    // left the file at /var/mobile and let sendMessage: fault SpringBoard. Fail
    // closed instead so the card send aborts cleanly and the bridge falls back
    // to a plain photo. (Poll/GamePigeon balloons carry no transfer and never
    // reach this function.)
    if (!staged) {
        if (outErr) *outErr = @"could not stage attachment into IMD persistent path (iOS-version persistent-path SPI mismatch); aborting to avoid a SpringBoard crash";
        KBLog(@"ABORT card transfer: persistent-path staging failed (transfer NOT registered, NOT sent)");
        return nil;
    }

    if ([ftc respondsToSelector:@selector(registerTransferWithDaemon:)]) {
        [ftc performSelector:@selector(registerTransferWithDaemon:) withObject:transferGuid];
        KBLog(@"registerTransferWithDaemon called for %@", transferGuid);
    } else {
        KBLog(@"registerTransferWithDaemon: unavailable");
    }
    return transfer;
}

// ---- flags (ported: IMsgInjected.m flagsForMessagePayload) ---------------
// balloon payload (no subject, no transfer) and plain attachment both use
// 0x100005 on the reference path.
static unsigned long long flagsForBalloon(void) { return 0x100005ULL; }

// ================= POLL PAYLOAD (ported from IMsgInjected.m) ==============

// LANDMINE FIX: the Mac's pollPreviewImageData() uses AppKit
// (NSBitmapImageRep / NSColor / NSBezierPath), which does not exist on iOS.
// Rewritten with UIKit + CoreGraphics: a 162x162 poll-thumbnail (light card
// with a blue rounded badge + three white "option" rows) -> JPEG data.
static NSData *pollPreviewImageData(void) {
    CGSize size = CGSizeMake(162, 162);
    UIGraphicsBeginImageContextWithOptions(size, YES, 1.0);
    CGContextRef ctx = UIGraphicsGetCurrentContext();
    if (!ctx) { UIGraphicsEndImageContext(); return nil; }

    // Background (light neutral).
    [[UIColor colorWithRed:0.96 green:0.96 blue:0.98 alpha:1.0] setFill];
    CGContextFillRect(ctx, CGRectMake(0, 0, 162, 162));

    // Blue rounded badge. NOTE: UIKit's origin is top-left (AppKit is
    // bottom-left), so the y math below is expressed directly in UIKit space
    // rather than mirrored from the AppKit source.
    [[UIColor colorWithRed:0.16 green:0.40 blue:0.86 alpha:1.0] setFill];
    UIBezierPath *badge = [UIBezierPath bezierPathWithRoundedRect:CGRectMake(25, 25, 112, 112)
                                                     cornerRadius:24];
    [badge fill];

    // Three white "option" rows: a bullet dot + a rounded bar, top to bottom.
    [[UIColor whiteColor] setFill];
    for (NSInteger i = 0; i < 3; i++) {
        CGFloat y = 47 + (i * 28);  // 47, 75, 103 from the top
        UIBezierPath *dot = [UIBezierPath bezierPathWithOvalInRect:CGRectMake(48, y, 10, 10)];
        [dot fill];
        UIBezierPath *bar = [UIBezierPath bezierPathWithRoundedRect:CGRectMake(68, y + 1, 46, 8)
                                                       cornerRadius:4];
        [bar fill];
    }

    UIImage *img = UIGraphicsGetImageFromCurrentImageContext();
    UIGraphicsEndImageContext();
    if (!img) return nil;
    return UIImageJPEGRepresentation(img, 0.82);
}

// Archive a plain object with NSKeyedArchiver (iOS 11+ has the
// requiringSecureCoding: variant; keep the legacy fallback for safety).
static NSData *tweakArchive(id root, NSError **outError) {
    if (@available(iOS 11.0, *)) {
        return [NSKeyedArchiver archivedDataWithRootObject:root
                                     requiringSecureCoding:NO
                                                     error:outError];
    }
    #pragma clang diagnostic push
    #pragma clang diagnostic ignored "-Wdeprecated-declarations"
    return [NSKeyedArchiver archivedDataWithRootObject:root];
    #pragma clang diagnostic pop
}

static NSData *archivePollLiveLayoutInfo(NSError **outError) {
    NSDictionary *layoutInfo = @{ @"layoutClass": @"MSMessageLiveLayout", @"userInfo": @{} };
    return tweakArchive(layoutInfo, outError);
}

static NSData *archivePollRequiredCapabilities(NSError **outError) {
    return tweakArchive(@[@"supports-polls"], outError);
}

// archivePollPayloadEnvelope (ported IMsgInjected.m:1762) - the 10-key
// MSMessageTemplateLayout envelope, NSKeyedArchiver'd. `ai` = our UIKit JPEG.
static NSData *archivePollPayloadEnvelope(NSURL *url, NSUUID *sessionIdentifier, NSString **outErr) {
    NSData *previewImage = pollPreviewImageData();
    if (!previewImage.length) { if (outErr) *outErr = @"Could not render poll preview image"; return nil; }

    NSError *le = nil; NSData *liveLayoutInfo = archivePollLiveLayoutInfo(&le);
    if (!liveLayoutInfo.length) { if (outErr) *outErr = le.localizedDescription ?: @"live layout archive failed"; return nil; }
    NSError *ce = nil; NSData *requiredCapabilities = archivePollRequiredCapabilities(&ce);
    if (!requiredCapabilities.length) { if (outErr) *outErr = ce.localizedDescription ?: @"capabilities archive failed"; return nil; }

    NSString *previewText = @"Sent a poll";
    NSDictionary *userInfo = @{
        @"caption": previewText, @"tertiary-subcaption": @"", @"image-subtitle": @"",
        @"subcaption": @"", @"image-title": @"", @"secondary-subcaption": @""
    };
    NSDictionary *envelope = @{
        @"userInfo": userInfo,
        @"ldtext": previewText,
        @"URL": url,
        @"layoutClass": @"MSMessageTemplateLayout",
        @"ai": previewImage,
        @"sessionIdentifier": sessionIdentifier,
        @"liveLayoutInfo": liveLayoutInfo,
        @"requiredCapabilities": requiredCapabilities,
        @"sendAsText": @YES,
        @"an": @"Polls"
    };
    NSError *ae = nil;
    NSData *out = tweakArchive(envelope, &ae);
    if (!out.length && outErr) *outErr = ae.localizedDescription ?: @"envelope archive failed";
    return out;
}

// buildPollCreationPayloadData (ported IMsgInjected.m:1823): the poll JSON ->
// data: URL -> archived envelope. creatorHandle = this line's own number.
static NSData *buildPollCreationPayloadData(NSString *question, NSArray<NSString *> *options,
                                            NSString *creatorHandle, NSString **outErr) {
    NSMutableArray *pollOptions = [NSMutableArray array];
    for (NSString *optionText in options) {
        NSMutableDictionary *option = [@{
            @"canBeEdited": @NO, @"attributedText": optionText, @"text": optionText,
            @"optionIdentifier": [[NSUUID UUID] UUIDString]
        } mutableCopy];
        if (creatorHandle.length) option[@"creatorHandle"] = creatorHandle;
        [pollOptions addObject:option];
    }
    NSMutableDictionary *item = [@{ @"title": question ?: @"", @"orderedPollOptions": pollOptions } mutableCopy];
    if (creatorHandle.length) item[@"creatorHandle"] = creatorHandle;
    NSDictionary *root = @{ @"item": item, @"version": @1 };

    NSError *je = nil;
    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:root options:0 error:&je];
    if (!jsonData) { if (outErr) *outErr = je.localizedDescription ?: @"poll JSON failed"; return nil; }
    if (jsonData.length > 4096) { if (outErr) *outErr = @"poll payload > 4096 bytes"; return nil; }

    NSString *encoded = [jsonData base64EncodedStringWithOptions:0];
    NSString *urlString = [NSString stringWithFormat:@"data:,%@?src=p&c=%lu",
                           encoded, (unsigned long)options.count];
    NSURL *url = [NSURL URLWithString:urlString];
    if (!url) { if (outErr) *outErr = @"poll URL invalid"; return nil; }

    NSUUID *session = [NSUUID UUID];
    return archivePollPayloadEnvelope(url, session, outErr);
}

// Resolve this line's own iMessage sender handle for the poll creatorHandle
// (ported from activeIMessageSenderHandle, IMsgInjected.m). Falls back to a
// caller-supplied default (this line's phone number).
static NSString *activeIMessageSenderHandle(NSString *fallback) {
    Class accClass = NSClassFromString(@"IMAccountController");
    id ctrl = accClass ? [accClass performSelector:@selector(sharedInstance)] : nil;
    id account = nil;
    if (ctrl && [ctrl respondsToSelector:@selector(activeIMessageAccount)])
        account = [ctrl performSelector:@selector(activeIMessageAccount)];
    if (account && [account respondsToSelector:@selector(loginIMHandle)]) {
        id login = [account performSelector:@selector(loginIMHandle)];
        if (login && [login respondsToSelector:@selector(ID)]) {
            NSString *lid = [login performSelector:@selector(ID)];
            if (lid.length) return lid;
        }
    }
    return fallback;
}

// ================= GENERIC BALLOON SEND ==================================

// iOS 15's direct IMMessage initializer keeps associated-message fields but
// regenerates replyToGUID from the chat's latest row during send. Build the
// underlying IMMessageItem first so reply + GamePigeon association are part of
// the same durable object before wrapping it as IMMessage. This is only used for
// associated balloon updates on iOS 15; every other OS/path keeps the proven
// direct initializer below.
static id buildIOS15AssociatedBalloonItem(NSString *bundleId,
                                           NSAttributedString *body,
                                           NSData *payloadData,
                                           NSArray *fileTransferGuids,
                                           NSString *associatedGuid) {
    NSOperatingSystemVersion osv = [[NSProcessInfo processInfo] operatingSystemVersion];
    if (osv.majorVersion != 15 || !associatedGuid.length) return nil;
    Class itemClass = NSClassFromString(@"IMMessageItem");
    Class messageClass = NSClassFromString(@"IMMessage");
    SEL initSel = @selector(initWithSender:time:body:attributes:fileTransferGUIDs:flags:error:guid:threadIdentifier:);
    SEL wrapSel = @selector(messageFromIMMessageItem:sender:subject:);
    if (!itemClass || !messageClass
        || ![itemClass instancesRespondToSelector:initSel]
        || ![messageClass respondsToSelector:wrapSel]) return nil;

    id item = [itemClass alloc];
    NSMethodSignature *sig = [itemClass instanceMethodSignatureForSelector:initSel];
    NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
    [inv setSelector:initSel]; [inv setTarget:item];
    id nilObj = nil;
    NSDate *now = [NSDate date];
    NSDictionary *attributes = nil;
    NSError *error = nil;
    NSString *guid = [[NSUUID UUID] UUIDString];
    NSString *threadIdentifier = nil;
    unsigned long long flags = flagsForBalloon();
    [inv setArgument:&nilObj atIndex:2];
    [inv setArgument:&now atIndex:3];
    [inv setArgument:&body atIndex:4];
    [inv setArgument:&attributes atIndex:5];
    [inv setArgument:&fileTransferGuids atIndex:6];
    [inv setArgument:&flags atIndex:7];
    [inv setArgument:&error atIndex:8];
    [inv setArgument:&guid atIndex:9];
    [inv setArgument:&threadIdentifier atIndex:10];
    [inv retainArguments]; [inv invoke];
    __unsafe_unretained id rawItem = nil;
    [inv getReturnValue:&rawItem];
    item = rawItem;
    if (!item) return nil;

    SEL bundleSel = NSSelectorFromString(@"setBalloonBundleID:");
    SEL payloadSel = NSSelectorFromString(@"setPayloadData:");
    SEL replySel = NSSelectorFromString(@"setReplyToGUID:");
    SEL assocSel = NSSelectorFromString(@"setAssociatedMessageGUID:");
    SEL assocTypeSel = NSSelectorFromString(@"setAssociatedMessageType:");
    if (![item respondsToSelector:bundleSel] || ![item respondsToSelector:payloadSel]
        || ![item respondsToSelector:replySel] || ![item respondsToSelector:assocSel]
        || ![item respondsToSelector:assocTypeSel]) return nil;
    ((void (*)(id, SEL, id))objc_msgSend)(item, bundleSel, bundleId);
    ((void (*)(id, SEL, id))objc_msgSend)(item, payloadSel, payloadData);
    ((void (*)(id, SEL, id))objc_msgSend)(item, replySel, associatedGuid);
    ((void (*)(id, SEL, id))objc_msgSend)(item, assocSel, associatedGuid);
    ((void (*)(id, SEL, long long))objc_msgSend)(item, assocTypeSel, 2LL);

    id wrapped = ((id (*)(id, SEL, id, id, id))objc_msgSend)(
        messageClass, wrapSel, item, nil, nil);
    KBLog(@"built iOS15 atomic associated balloon item=%@ wrapped=%@ guid=%@",
          NSStringFromClass([item class]), wrapped ? NSStringFromClass([wrapped class]) : @"(nil)", guid);
    return wrapped;
}

// Build a cold-send balloon IMMessage with the iOS-13 12-arg initializer,
// passing balloonBundleID (arg 11) + payloadData (arg 12) inline. Mirrors the
// Mac cold path but for the shorter iOS initializer the tweak already uses.
static id buildBalloonIMMessage(NSString *bundleId, NSAttributedString *body, NSData *payloadData,
                                NSArray *fileTransferGuids, NSString *associatedGuid) {
    Class messageClass = NSClassFromString(@"IMMessage");
    if (!messageClass) { KBLog(@"no IMMessage class"); return nil; }
    if (!fileTransferGuids) fileTransferGuids = @[];
    id ios15Associated = buildIOS15AssociatedBalloonItem(
        bundleId, body, payloadData, fileTransferGuids, associatedGuid);
    if (ios15Associated) return ios15Associated;
    SEL sel = @selector(initWithSender:time:text:messageSubject:fileTransferGUIDs:flags:error:guid:subject:balloonBundleID:payloadData:expressiveSendStyleID:);
    if (![messageClass instancesRespondToSelector:sel]) {
        KBLog(@"IMMessage does NOT respond to 12-arg initWithSender:...expressiveSendStyleID:");
        return nil;
    }
    unsigned long long flags = flagsForBalloon();
    id m = [[messageClass alloc] init];
    NSMethodSignature *sig = [messageClass instanceMethodSignatureForSelector:sel];
    NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
    [inv setSelector:sel]; [inv setTarget:m];
    id nilObj = nil; NSDate *now = [NSDate date]; NSAttributedString *subj = nil;
    NSString *effect = nil;
    __unsafe_unretained NSArray *ftg = fileTransferGuids;
    __unsafe_unretained NSString *bid = bundleId;
    __unsafe_unretained NSData *pd = payloadData;
    [inv setArgument:&nilObj atIndex:2];       // sender
    [inv setArgument:&now atIndex:3];          // time
    [inv setArgument:&body atIndex:4];         // text (breadcrumb, or 2-run card body)
    [inv setArgument:&subj atIndex:5];         // messageSubject
    [inv setArgument:&ftg atIndex:6];          // fileTransferGUIDs (card image or @[])
    [inv setArgument:&flags atIndex:7];
    [inv setArgument:&nilObj atIndex:8];       // error
    [inv setArgument:&nilObj atIndex:9];       // guid
    [inv setArgument:&nilObj atIndex:10];      // subject string
    [inv setArgument:&bid atIndex:11];         // balloonBundleID
    [inv setArgument:&pd atIndex:12];          // payloadData
    [inv setArgument:&effect atIndex:13];      // expressiveSendStyleID
    [inv retainArguments]; [inv invoke];
    __unsafe_unretained id result = nil; [inv getReturnValue:&result];
    id strongResult = result;
    KBLog(@"built balloon IMMessage=%@ bundle=%@ payloadBytes=%lu",
          strongResult ? NSStringFromClass([strongResult class]) : @"(nil)",
          bundleId, (unsigned long)payloadData.length);
    // Belt-and-suspenders: also set via setters in case an initializer arg slot
    // differs subtly on this build (a no-op if already set by the initializer).
    if (strongResult) {
        if ([strongResult respondsToSelector:@selector(setBalloonBundleID:)])
            [strongResult performSelector:@selector(setBalloonBundleID:) withObject:bundleId];
        if ([strongResult respondsToSelector:@selector(setPayloadData:)])
            [strongResult performSelector:@selector(setPayloadData:) withObject:payloadData];
        // IN-PLACE BALLOON UPDATE: a GamePigeon move that continues an existing game
        // is an ASSOCIATED message pointing at the balloon it updates. Real captured
        // pairs (invite -> move) on this line show the move carries
        // associatedMessageGUID = <invite guid> and associatedMessageType = 2; the
        // anchor uses type 3 self-association. Without this, our reply self-associates
        // (type 3) and Messages renders a SECOND balloon beside the untouched invite.
        // Setters are the private _associatedMessageGUID: / _associatedMessageType:
        // (IMMessage.h). No-op when associatedGuid is empty (a fresh anchor send).
        if (associatedGuid.length) {
            if ([strongResult respondsToSelector:@selector(_associatedMessageGUID:)])
                [strongResult performSelector:@selector(_associatedMessageGUID:) withObject:associatedGuid];
            SEL typeSel = @selector(_associatedMessageType:);
            if ([strongResult respondsToSelector:typeSel]) {
                NSMethodSignature *tsig = [strongResult methodSignatureForSelector:typeSel];
                NSInvocation *tinv = [NSInvocation invocationWithMethodSignature:tsig];
                long long assocType = 2; // 2 = update the associated interactive message in place
                [tinv setSelector:typeSel]; [tinv setTarget:strongResult];
                [tinv setArgument:&assocType atIndex:2];
                [tinv invoke];
            }
            // Pin the reply chain to the game turn as well as the interactive
            // balloon association. IMCore otherwise inherits the chat's newest
            // message. In the capture script that newest row is the intervening
            // "yeah yeah yeah whatever" text, causing iOS 15 to insert the game
            // locally but never transport it. Real delivered GamePigeon turns
            // carry reply_to_guid=<the inbound game move> even while association
            // type 2 updates the original balloon.
            SEL replySel = NSSelectorFromString(@"setReplyToGUID:");
            if ([strongResult respondsToSelector:replySel])
                ((void (*)(id, SEL, id))objc_msgSend)(strongResult, replySel, associatedGuid);
            if ([strongResult respondsToSelector:@selector(_imMessageItem)]) {
                id item = [strongResult performSelector:@selector(_imMessageItem)];
                if ([item respondsToSelector:replySel])
                    ((void (*)(id, SEL, id))objc_msgSend)(item, replySel, associatedGuid);
            }
            KBLog(@"balloon associated update -> guid=%@ type=2", associatedGuid);
        }
    }
    return strongResult;
}

// Generic balloon send: cold-send a message carrying bundleId + payloadData.
// If imagePath is non-nil (Target B / app card), stage it as a hidden transfer
// and use the 2-run card attributedBody so the full image renders INLINE.
static NSString *pocSendBalloon(NSString *to, NSString *bundleId, NSData *payloadData,
                                NSString *breadcrumb, NSString *imagePath, NSString *associatedGuid) {
    if (!to.length) return @"ERR missing to";
    if (!bundleId.length) return @"ERR missing bundleId";
    if (!payloadData.length) return @"ERR missing payloadData";

    NSString *chatGuid = [to hasPrefix:@"iMessage;"] ? to
        : [NSString stringWithFormat:@"iMessage;-;%@", to];
    KBLog(@"pocSendBalloon to=%@ bundle=%@ payloadBytes=%lu image=%@",
          to, bundleId, (unsigned long)payloadData.length, imagePath ?: @"(none)");

    id chat = resolveChatByGuid(chatGuid);
    if (!chat) return [NSString stringWithFormat:@"ERR chat not found: %@", chatGuid];

    @try {
        NSAttributedString *body = nil;
        NSArray *fileTransferGuids = @[];

        if (imagePath.length) {
            if (![[NSFileManager defaultManager] fileExistsAtPath:imagePath])
                return [NSString stringWithFormat:@"ERR image not found: %@", imagePath];
            NSURL *imageURL = [NSURL fileURLWithPath:imagePath];
            NSString *imageName = [imageURL lastPathComponent];
            NSString *prepErr = nil;
            IMFileTransfer *transfer = prepareOutgoingTransfer(imageURL, imageName, chatGuid, &prepErr);
            NSString *transferGuid = transfer ? [transfer guid] : nil;
            if (!transferGuid.length)
                return [NSString stringWithFormat:@"ERR card image transfer failed: %@", prepErr ?: @"unknown"];
            body = buildBalloonCardAttributed(breadcrumb, transferGuid);
            fileTransferGuids = @[transferGuid];
            KBLog(@"pocSendBalloon: inline card transferGuid=%@", transferGuid);
        } else {
            body = buildBalloonBreadcrumbAttributed(breadcrumb);
        }

        id imMessage = buildBalloonIMMessage(bundleId, body, payloadData, fileTransferGuids, associatedGuid);
        if (!imMessage) return @"ERR could not build balloon IMMessage";
        if (![chat respondsToSelector:@selector(sendMessage:)]) return @"ERR chat has no sendMessage:";
        [chat performSelector:@selector(sendMessage:) withObject:imMessage];
        NSString *messageGuid = nil;
        if ([imMessage respondsToSelector:@selector(guid)])
            messageGuid = [imMessage performSelector:@selector(guid)];
        KBLog(@"sendMessage: dispatched (balloon bundle=%@ transfers=%lu)",
              bundleId, (unsigned long)fileTransferGuids.count);
        return [NSString stringWithFormat:@"OK sent balloon guid=%@ bundle=%@ image=%@",
                messageGuid ?: @"", bundleId, imagePath.length ? @"inline" : @"none"];
    } @catch (NSException *ex) {
        KBLog(@"EXC pocSendBalloon: %@ %@", ex.name, ex.reason);
        return [NSString stringWithFormat:@"ERR exception: %@", ex.reason];
    }
}

// PoC: send a native Google Maps rich-link (URL-preview) CARD via our own IMCore
// path. Mirrors the Mac handleSendURLPreview (IMsgInjected.m:4442): each image in
// imagePaths (ORDERED [favicon idx0, hero idx1]) is staged as a HIDDEN
// .pluginPayloadAttachment transfer, the body is the URL text tagged as a rich
// link, and a com.apple.messages.URLBalloonProvider balloon carries the RichLink
// payload. SAME fail-closed staging + @try/@catch as pocSendBalloon: a staging
// failure aborts cleanly (the bridge falls back to a photo) and nothing escapes
// as an uncaught throw into SpringBoard. ADDITIVE - reuses prepareOutgoingTransfer
// and buildBalloonIMMessage unchanged.
static NSString *pocSendUrlPreview(NSString *to, NSString *url, NSData *payloadData,
                                   NSArray *imagePaths, NSData *dataDetected, NSString *bundleId) {
    if (!to.length) return @"ERR missing to";
    if (!url.length) return @"ERR missing url";
    if (!payloadData.length) return @"ERR missing payloadData";
    if (![imagePaths isKindOfClass:[NSArray class]] || imagePaths.count == 0)
        return @"ERR missing imagePaths (ordered [favicon, hero])";
    if (!bundleId.length) bundleId = @"com.apple.messages.URLBalloonProvider";

    NSString *chatGuid = [to hasPrefix:@"iMessage;"] ? to
        : [NSString stringWithFormat:@"iMessage;-;%@", to];
    KBLog(@"pocSendUrlPreview to=%@ url=%@ payloadBytes=%lu images=%lu",
          to, url, (unsigned long)payloadData.length, (unsigned long)imagePaths.count);

    id chat = resolveChatByGuid(chatGuid);
    if (!chat) return [NSString stringWithFormat:@"ERR chat not found: %@", chatGuid];

    @try {
        // Register each image as a HIDDEN .pluginPayloadAttachment transfer, IN ORDER.
        NSMutableArray *transferGuids = [NSMutableArray array];
        for (id rawPath in imagePaths) {
            if (![rawPath isKindOfClass:[NSString class]] || !((NSString *)rawPath).length)
                return @"ERR imagePaths entry not a non-empty string";
            NSString *imagePath = (NSString *)rawPath;
            if (![[NSFileManager defaultManager] fileExistsAtPath:imagePath])
                return [NSString stringWithFormat:@"ERR image not found: %@", imagePath];
            NSURL *imageURL = [NSURL fileURLWithPath:imagePath];
            NSString *imageName = [imageURL lastPathComponent];
            NSString *prepErr = nil;
            IMFileTransfer *transfer = prepareOutgoingTransfer(imageURL, imageName, chatGuid, &prepErr);
            NSString *transferGuid = transfer ? [transfer guid] : nil;
            if (!transferGuid.length)
                return [NSString stringWithFormat:@"ERR url-preview image transfer failed: %@", prepErr ?: @"unknown"];
            if ([transfer respondsToSelector:@selector(setHideAttachment:)])
                [transfer setHideAttachment:YES];
            [transferGuids addObject:transferGuid];
            KBLog(@"pocSendUrlPreview: transfer[%lu]=%@ (%@)",
                  (unsigned long)(transferGuids.count - 1), transferGuid, imageName);
        }

        NSAttributedString *body = buildRichLinkURLAttributed(url, dataDetected);
        id imMessage = buildBalloonIMMessage(bundleId, body, payloadData, transferGuids, nil);
        if (!imMessage) return @"ERR could not build url-preview IMMessage";
        if (![chat respondsToSelector:@selector(sendMessage:)]) return @"ERR chat has no sendMessage:";
        [chat performSelector:@selector(sendMessage:) withObject:imMessage];
        KBLog(@"sendMessage: dispatched (url-preview bundle=%@ transfers=%lu)",
              bundleId, (unsigned long)transferGuids.count);
        return [NSString stringWithFormat:@"OK sent url-preview bundle=%@ images=%lu",
                bundleId, (unsigned long)transferGuids.count];
    } @catch (NSException *ex) {
        KBLog(@"EXC pocSendUrlPreview: %@ %@", ex.name, ex.reason);
        return [NSString stringWithFormat:@"ERR exception: %@", ex.reason];
    }
}

// PoC-1: build a native Poll payload and cold-send it as a Polls balloon.
static NSString *pocSendPoll(NSString *to, NSString *question, NSArray<NSString *> *options) {
    if (!to.length) return @"ERR missing to";
    if (question.length == 0) return @"ERR missing question";
    if (options.count < 2) return @"ERR poll needs >=2 options";

#ifndef TWEAK_LINE_NUMBER
#error "TWEAK_LINE_NUMBER is required: build with make LINE_NUMBER=+1... (this line's own number)"
#endif
    // This line's own iMessage number, used ONLY as the poll creatorHandle
    // FALLBACK (activeIMessageSenderHandle resolves the real handle first).
    // Set per-build by the Makefile from the required LINE_NUMBER variable.
    NSString *ownNumber = @TWEAK_LINE_NUMBER;
    NSString *creatorHandle = activeIMessageSenderHandle(ownNumber);

    NSString *perr = nil;
    NSData *payload = buildPollCreationPayloadData(question, options, creatorHandle, &perr);
    if (!payload.length) return [NSString stringWithFormat:@"ERR poll payload: %@", perr ?: @"unknown"];
    KBLog(@"pocSendPoll built payload bytes=%lu creator=%@ q=%@ opts=%@",
          (unsigned long)payload.length, creatorHandle, question, options);

    NSString *bundleId = @"com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.messages.Polls";
    return pocSendBalloon(to, bundleId, payload, @"Sent a poll", nil, nil);
}

// ---- PoC-2 send (plain photo, unchanged) --------------------------------
static id buildAttachmentIMMessage(NSAttributedString *body, NSArray *fileTransferGuids, BOOL isAudioMessage) {
    Class messageClass = NSClassFromString(@"IMMessage");
    if (!messageClass) { KBLog(@"no IMMessage class"); return nil; }
    SEL sel = @selector(initWithSender:time:text:messageSubject:fileTransferGUIDs:flags:error:guid:subject:balloonBundleID:payloadData:expressiveSendStyleID:);
    if (![messageClass instancesRespondToSelector:sel]) return nil;
    // 0x300005 is the upstream imsg helper flag set for a NATIVE audio message
    // (flagsForMessagePayload in IMsgInjected.m): the 0x200000 bit is what makes
    // the receiver draw a waveform bubble instead of a file blob. Everything else
    // about the send is identical to a normal attachment.
    unsigned long long flags = isAudioMessage ? 0x300005ULL : flagsForBalloon();
    id m = [[messageClass alloc] init];
    NSMethodSignature *sig = [messageClass instanceMethodSignatureForSelector:sel];
    NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
    [inv setSelector:sel]; [inv setTarget:m];
    id nilObj = nil; NSDate *now = [NSDate date]; NSAttributedString *subj = nil; NSString *effect = nil;
    [inv setArgument:&nilObj atIndex:2]; [inv setArgument:&now atIndex:3]; [inv setArgument:&body atIndex:4];
    [inv setArgument:&subj atIndex:5]; [inv setArgument:&fileTransferGuids atIndex:6]; [inv setArgument:&flags atIndex:7];
    [inv setArgument:&nilObj atIndex:8]; [inv setArgument:&nilObj atIndex:9]; [inv setArgument:&nilObj atIndex:10];
    [inv setArgument:&nilObj atIndex:11]; [inv setArgument:&nilObj atIndex:12]; [inv setArgument:&effect atIndex:13];
    [inv retainArguments]; [inv invoke];
    __unsafe_unretained id result = nil; [inv getReturnValue:&result];
    id strongResult = result;
    KBLog(@"built attachment IMMessage=%@", strongResult ? NSStringFromClass([strongResult class]) : @"(nil)");
    return strongResult;
}

// Send one or MORE files as a single native attachment message. Several files on
// ONE message is what makes iMessage draw a stacked photo bundle ("3 Photos", tap
// to expand) instead of a full-width bubble per image. Same ordered N-transfer
// shape pocSendUrlPreview already runs in production for the Maps rich-link
// cards, so nothing new is being asked of IMCore here.
//
// Fails CLOSED before sendMessage: if ANY file can't be staged - a partial bundle
// is a worse outcome than no bundle, and the bridge falls back cleanly.
static NSString *pocSendPhoto(NSString *to, NSArray<NSString *> *filePaths, BOOL isAudioMessage) {
    if (!to.length) return @"ERR missing to";
    if (![filePaths isKindOfClass:[NSArray class]] || filePaths.count == 0)
        return @"ERR missing filePath";
    for (id raw in filePaths) {
        if (![raw isKindOfClass:[NSString class]] || !((NSString *)raw).length)
            return @"ERR filePaths entry was not a non-empty string";
        if (![[NSFileManager defaultManager] fileExistsAtPath:(NSString *)raw])
            return [NSString stringWithFormat:@"ERR file not found: %@", raw];
    }
    // A voice note is one waveform bubble by definition; bundling audio has no
    // native rendering, so refuse rather than send something misshapen.
    if (isAudioMessage && filePaths.count > 1)
        return @"ERR audio=1 takes exactly one file";
    NSString *chatGuid = [to hasPrefix:@"iMessage;"] ? to : [NSString stringWithFormat:@"iMessage;-;%@", to];
    KBLog(@"pocSendPhoto to=%@ chatGuid=%@ files=%lu first=%@",
          to, chatGuid, (unsigned long)filePaths.count, filePaths.firstObject);
    id chat = resolveChatByGuid(chatGuid);
    if (!chat) return [NSString stringWithFormat:@"ERR chat not found: %@", chatGuid];
    @try {
        // One transfer per file, IN ORDER: each placeholder must carry its own
        // transfer guid or Messages sends an empty body with nothing linked.
        NSMutableArray<NSString *> *transferGuids = [NSMutableArray array];
        NSMutableAttributedString *body = [[NSMutableAttributedString alloc] init];
        for (NSString *path in filePaths) {
            NSURL *fileURL = [NSURL fileURLWithPath:path];
            NSString *filename = [fileURL lastPathComponent];
            NSString *prepErr = nil;
            IMFileTransfer *transfer = prepareOutgoingTransfer(fileURL, filename, chatGuid, &prepErr);
            if (!transfer) return [NSString stringWithFormat:@"ERR prepareTransfer: %@", prepErr ? prepErr : @"unknown"];
            NSString *transferGuid = [transfer guid];
            if (!transferGuid.length) return @"ERR transfer has no guid";
            [body appendAttributedString:buildAttachmentAttributed(transferGuid, filename,
                                                                   (NSInteger)transferGuids.count)];
            [transferGuids addObject:transferGuid];
            KBLog(@"pocSendPhoto: transfer[%lu]=%@ (%@)",
                  (unsigned long)(transferGuids.count - 1), transferGuid, filename);
        }
        id imMessage = buildAttachmentIMMessage(body, transferGuids, isAudioMessage);
        if (!imMessage) return @"ERR could not build IMMessage";
        if ([chat respondsToSelector:@selector(sendMessage:)]) {
            [chat performSelector:@selector(sendMessage:) withObject:imMessage];
            NSString *messageGuid = nil;
            if ([imMessage respondsToSelector:@selector(guid)])
                messageGuid = [imMessage performSelector:@selector(guid)];
            KBLog(@"sendMessage: dispatched (files=%lu guid=%@)",
                  (unsigned long)transferGuids.count, messageGuid ?: @"");
            // guid + files let the Mac bridge verify against the phone's own sms.db
            // that all N attachments landed on this ONE message (/poc/message-status).
            return [NSString stringWithFormat:@"OK sent guid=%@ files=%lu transferGuid=%@",
                    messageGuid ?: @"", (unsigned long)transferGuids.count,
                    transferGuids.firstObject];
        }
        return @"ERR chat has no sendMessage:";
    } @catch (NSException *ex) {
        KBLog(@"EXC pocSendPhoto: %@ %@", ex.name, ex.reason);
        return [NSString stringWithFormat:@"ERR exception: %@", ex.reason];
    }
}

// ---- Plain text into a GROUP (/poc/send-text) ---------------------------
// SMServer's /send cannot post into an existing group on iOS 16: every group
// reply on an iOS 16 line committed with error=4 outside any chat while
// SMServer still answered 200 (a week of group replies in production, each
// forking the group). This resolves the group by its iMessage;+; guid, which finds the real
// chat, and sends the same plain-text message the photo path builds, with no
// transfers. The returned guid lets the Mac read the outcome from
// /poc/message-status.
static NSString *pocSendText(NSString *to, NSString *text) {
    if (!to.length) return @"ERR missing to";
    if (!text.length) return @"ERR missing text";
    NSString *chatGuid = [to hasPrefix:@"iMessage;"] ? to : [NSString stringWithFormat:@"iMessage;-;%@", to];
    KBLog(@"pocSendText chatGuid=%@ chars=%lu", chatGuid, (unsigned long)text.length);
    id chat = resolveChatByGuid(chatGuid);
    if (!chat) return [NSString stringWithFormat:@"ERR chat not found: %@", chatGuid];
    @try {
        NSAttributedString *body = [[NSAttributedString alloc] initWithString:text attributes:@{
            @"__kIMBaseWritingDirectionAttributeName": @"-1",
            @"__kIMMessagePartAttributeName": @0,
        }];
        id imMessage = buildAttachmentIMMessage(body, @[], NO);
        if (!imMessage) return @"ERR could not build IMMessage";
        if (![chat respondsToSelector:@selector(sendMessage:)]) return @"ERR chat has no sendMessage:";
        [chat performSelector:@selector(sendMessage:) withObject:imMessage];
        NSString *messageGuid = nil;
        if ([imMessage respondsToSelector:@selector(guid)])
            messageGuid = [imMessage performSelector:@selector(guid)];
        KBLog(@"sendMessage: dispatched (text guid=%@)", messageGuid ?: @"");
        return [NSString stringWithFormat:@"OK sent guid=%@", messageGuid ?: @""];
    } @catch (NSException *ex) {
        KBLog(@"EXC pocSendText: %@ %@", ex.name, ex.reason);
        return [NSString stringWithFormat:@"ERR exception: %@", ex.reason];
    }
}

// ---- sms.db reads (/poc/read-games, /poc/message-status) ----------------
// The queries live in SmsDbRead.h. Where this process may open sms.db
// (palera1n) they run here; on Dopamine SpringBoard may not, so the same code
// runs in the vanquel-smsdb helper, which is signed with the Messages storage
// entitlement, and its stdout is the answer.
static NSString *const TWEAK_SMSDB_HELPER = @"/var/jb/usr/local/libexec/vanquel-smsdb";

static BOOL tweakSmsDbReadableHere(void) {
    return [[NSFileManager defaultManager] fileExistsAtPath:TWEAK_PHONE_SMS_DB];
}

static NSString *tweakSmsDbViaHelper(NSArray<NSString *> *args) {
    const char *path = TWEAK_SMSDB_HELPER.fileSystemRepresentation;
    if (access(path, X_OK) != 0)
        return [NSString stringWithFormat:@"ERR sms.db not readable here and no helper at %@", TWEAK_SMSDB_HELPER];
    int fds[2];
    if (pipe(fds) != 0) return @"ERR helper pipe failed";
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_addopen(&fa, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
    posix_spawn_file_actions_adddup2(&fa, fds[1], STDOUT_FILENO);
    posix_spawn_file_actions_addclose(&fa, fds[0]);
    posix_spawn_file_actions_addclose(&fa, fds[1]);
    char *argv[args.count + 2];
    argv[0] = (char *)path;
    for (NSUInteger i = 0; i < args.count; i++) argv[i + 1] = (char *)args[i].UTF8String;
    argv[args.count + 1] = NULL;
    pid_t pid = 0;
    int rc = posix_spawn(&pid, path, &fa, NULL, argv, environ);
    posix_spawn_file_actions_destroy(&fa);
    close(fds[1]);
    if (rc != 0) {
        close(fds[0]);
        return [NSString stringWithFormat:@"ERR helper spawn rc=%d", rc];
    }
    NSMutableData *buf = [NSMutableData data];
    char chunk[16384];
    ssize_t r;
    while ((r = read(fds[0], chunk, sizeof chunk)) > 0) [buf appendBytes:chunk length:(NSUInteger)r];
    close(fds[0]);
    int status = 0;
    waitpid(pid, &status, 0);
    NSString *out = [[NSString alloc] initWithData:buf encoding:NSUTF8StringEncoding];
    return out.length ? out : [NSString stringWithFormat:@"ERR helper gave no answer (status=%d)", status];
}

static NSString *pocReadGames(NSString *afterRowidStr, NSString *limitStr) {
    long long afterRowid = afterRowidStr.length ? [afterRowidStr longLongValue] : 0;
    int limit = limitStr.length ? [limitStr intValue] : 25;
    if (limit <= 0 || limit > 200) limit = 25;
    NSString *out = tweakSmsDbReadableHere()
        ? tweakSmsDbReadGames(afterRowid, limit)
        : tweakSmsDbViaHelper(@[@"games", [NSString stringWithFormat:@"%lld", afterRowid], [NSString stringWithFormat:@"%d", limit]]);
    if ([out hasPrefix:@"ERR"]) KBLog(@"pocReadGames %@", out);
    return out;
}

static NSString *pocMessageStatus(NSString *guid) {
    if (!guid.length) return @"ERR missing guid";
    return tweakSmsDbReadableHere() ? tweakSmsDbMessageStatus(guid) : tweakSmsDbViaHelper(@[@"status", guid]);
}

// ---- Minimal HTTP server (raw socket + GCD) -----------------------------
static NSDictionary *parseForm(NSString *s) {
    NSMutableDictionary *d = [NSMutableDictionary dictionary];
    for (NSString *pair in [s componentsSeparatedByString:@"&"]) {
        NSRange r = [pair rangeOfString:@"="];
        if (r.location == NSNotFound) continue;
        NSString *k = [pair substringToIndex:r.location];
        NSString *v = [pair substringFromIndex:r.location+1];
        v = [v stringByReplacingOccurrencesOfString:@"+" withString:@" "];
        NSString *dec = [v stringByRemovingPercentEncoding];
        if (dec) v = dec;
        d[k] = v;
    }
    return d;
}

static void handleClient(int cfd) {
    // Read the full request. A single recv() can return just the headers (curl
    // may send headers + body in separate TCP segments), which truncated large
    // payloadBase64 bodies. Read the headers, then keep reading until the whole
    // Content-Length body has arrived.
    NSMutableData *acc = [NSMutableData data];
    char rbuf[65536];
    ssize_t got = recv(cfd, rbuf, sizeof(rbuf), 0);
    if (got <= 0) { close(cfd); return; }
    [acc appendBytes:rbuf length:got];

    // Locate header/body split and Content-Length.
    NSString *headStr = [[NSString alloc] initWithData:acc encoding:NSASCIIStringEncoding] ?: @"";
    NSRange split = [headStr rangeOfString:@"\r\n\r\n"];
    NSInteger contentLength = 0;
    {
        NSRange clr = [headStr rangeOfString:@"Content-Length:" options:NSCaseInsensitiveSearch];
        if (clr.location != NSNotFound) {
            NSString *rest = [headStr substringFromIndex:clr.location + clr.length];
            NSRange eol = [rest rangeOfString:@"\r\n"];
            if (eol.location != NSNotFound) rest = [rest substringToIndex:eol.location];
            contentLength = [[rest stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] integerValue];
        }
    }
    if (split.location != NSNotFound && contentLength > 0) {
        NSUInteger headerBytes = split.location + 4;  // ASCII == byte offset here
        NSInteger need = (NSInteger)headerBytes + contentLength - (NSInteger)acc.length;
        while (need > 0) {
            ssize_t m = recv(cfd, rbuf, sizeof(rbuf), 0);
            if (m <= 0) break;
            [acc appendBytes:rbuf length:m];
            need -= m;
        }
    }

    NSString *req = [[NSString alloc] initWithData:acc encoding:NSUTF8StringEncoding];
    if (!req) req = [[NSString alloc] initWithData:acc encoding:NSISOLatin1StringEncoding] ?: @"";
    NSString *responseBody = @"";
    NSString *statusLine = @"200 OK";
    @autoreleasepool {
        NSArray *lines = [req componentsSeparatedByString:@"\r\n"];
        NSString *reqLine = lines.count ? lines[0] : @"";
        NSArray *rlp = [reqLine componentsSeparatedByString:@" "];
        NSString *path = rlp.count > 1 ? rlp[1] : @"";
        NSRange bodyR = [req rangeOfString:@"\r\n\r\n"];
        NSString *body = bodyR.location != NSNotFound ? [req substringFromIndex:bodyR.location + 4] : @"";
        NSString *query = @"";
        NSRange q = [path rangeOfString:@"?"];
        if (q.location != NSNotFound) { query = [path substringFromIndex:q.location+1]; path = [path substringToIndex:q.location]; }

        NSMutableDictionary *params = [NSMutableDictionary dictionary];
        [params addEntriesFromDictionary:parseForm(query)];
        if ([body containsString:@"="] && ![body containsString:@"Content-Disposition"])
            [params addEntriesFromDictionary:parseForm(body)];

        // Robust large-payload path: params can point at files on the phone
        // instead of inlining base64 (avoids all URL-encoding fragility).
        NSData *(^payloadFromParams)(void) = ^NSData *{
            NSString *pf = params[@"payloadFile"];
            if (pf.length && [[NSFileManager defaultManager] fileExistsAtPath:pf])
                return [NSData dataWithContentsOfFile:pf];
            return [[NSData alloc] initWithBase64EncodedString:(params[@"payloadBase64"] ?: @"")
                    options:NSDataBase64DecodingIgnoreUnknownCharacters];
        };

        // ---- AUTH GATE ------------------------------------------------------
        // /poc/ping is open (health only, can't send). Every other endpoint
        // requires the shared secret via `X-Tweak-Secret` header or `secret=`
        // param. Fails CLOSED when the on-phone secret file is missing/empty.
        BOOL isPing = [path hasPrefix:@"/poc/ping"];
        if (!isPing) {
            NSString *want = tweakLoadSecret();
            NSString *got = tweakHeaderValue(req, @"X-Tweak-Secret");
            if (!got.length) got = params[@"secret"];
            if (!want.length) {
                statusLine = @"403 Forbidden";
                responseBody = @"forbidden: server secret not configured";
                KBLog(@"AUTH reject %@: no on-phone secret file (%@)", path, TWEAK_SECRET_PATH);
            } else if (!tweakSecretEquals(want, got)) {
                statusLine = @"403 Forbidden";
                responseBody = @"forbidden";
                KBLog(@"AUTH reject %@: bad/missing secret", path);
            }
        }

        if ([statusLine isEqualToString:@"200 OK"]) {
            if (isPing) {
                // Health only (open, no secret). Includes which process hosts the
                // listener + the IM class-resolution summary so the SpringBoard
                // migration test can confirm the force-load from the Mac.
                NSString *host = [[NSProcessInfo processInfo] processName] ?: @"?";
                responseBody = [NSString stringWithFormat:@"pong host=%@ %@", host, tweakImStatus];
            } else if ([path hasPrefix:@"/poc/send-photo"]) {
                // filePaths="/a.jpg|/b.jpg|/c.jpg" puts every file on ONE message
                // (stacked photo bundle). filePath stays the single-file form.
                // Pipe-separated because the form parser flattens repeated keys,
                // and it matches /poc/send-poll's existing options="a|b|c".
                NSMutableArray *files = [NSMutableArray array];
                NSString *multi = params[@"filePaths"];
                if (multi.length) {
                    for (NSString *piece in [multi componentsSeparatedByString:@"|"]) {
                        NSString *t = [piece stringByTrimmingCharactersInSet:
                            [NSCharacterSet whitespaceCharacterSet]];
                        if (t.length) [files addObject:t];
                    }
                } else if (((NSString *)params[@"filePath"]).length) {
                    [files addObject:params[@"filePath"]];
                }
                responseBody = tweakRunOnMainSync(^{
                    return pocSendPhoto(params[@"to"], files, [params[@"audio"] boolValue]);
                });
            } else if ([path hasPrefix:@"/poc/send-text"]) {
                responseBody = tweakRunOnMainSync(^{
                    return pocSendText(params[@"to"], params[@"text"]);
                });
            } else if ([path hasPrefix:@"/poc/send-poll"]) {
                NSString *opts = params[@"options"] ?: @"";
                NSMutableArray *options = [NSMutableArray array];
                for (NSString *o in [opts componentsSeparatedByString:@"|"]) {
                    NSString *t = [o stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
                    if (t.length) [options addObject:t];
                }
                responseBody = tweakRunOnMainSync(^{
                    return pocSendPoll(params[@"to"], params[@"question"] ?: @"Poll", options);
                });
            } else if ([path hasPrefix:@"/poc/send-card"]) {
                // Target B: inline-image balloon. imageFile = full card JPEG on the phone.
                responseBody = tweakRunOnMainSync(^{
                    return pocSendBalloon(params[@"to"], params[@"bundleId"], payloadFromParams(),
                                          params[@"breadcrumb"], params[@"imageFile"], nil);
                });
            } else if ([path hasPrefix:@"/poc/send-balloon"]) {
                responseBody = tweakRunOnMainSync(^{
                    return pocSendBalloon(params[@"to"], params[@"bundleId"], payloadFromParams(),
                                          params[@"breadcrumb"], nil, params[@"replyToGuid"]);
                });
            } else if ([path hasPrefix:@"/poc/send-tapback"]) {
                responseBody = tweakRunOnMainSync(^{
                    return pocSendTapback(params[@"to"], params[@"guid"], params[@"type"]);
                });
            } else if ([path hasPrefix:@"/poc/share-nickname"]) {
                BOOL dryRun = [params[@"dryRun"] boolValue];
                responseBody = tweakRunOnMainSync(^{
                    return pocShareNickname(params[@"to"], dryRun);
                });
            } else if ([path hasPrefix:@"/poc/send-url-preview"]) {
                // Native Google Maps rich-link CARD. faviconFile=idx0, heroFile=idx1
                // (ORDERED); payloadFile=RichLink archive; dataDetectedFile=optional.
                responseBody = tweakRunOnMainSync(^{
                    NSData *dd = nil;
                    NSString *ddf = params[@"dataDetectedFile"];
                    if (ddf.length && [[NSFileManager defaultManager] fileExistsAtPath:ddf])
                        dd = [NSData dataWithContentsOfFile:ddf];
                    NSMutableArray *images = [NSMutableArray array];
                    NSString *fav = params[@"faviconFile"];
                    if (fav.length) [images addObject:fav];
                    NSString *hero = params[@"heroFile"];
                    if (hero.length) [images addObject:hero];
                    return pocSendUrlPreview(params[@"to"], params[@"url"], payloadFromParams(),
                                             images, dd, @"com.apple.messages.URLBalloonProvider");
                });
            } else if ([path hasPrefix:@"/poc/read-games"]) {
                // Inbound GamePigeon cards from the phone's own sms.db (secret-gated:
                // reads private message payloads). Returns a JSON array.
                responseBody = pocReadGames(params[@"afterRowid"], params[@"limit"]);
            } else if ([path hasPrefix:@"/poc/message-status"]) {
                responseBody = pocMessageStatus(params[@"guid"]);
            } else {
                statusLine = @"404 Not Found";
                responseBody = @"not found";
            }
        }
    }
    NSString *resp = [NSString stringWithFormat:
        @"HTTP/1.1 %@\r\nContent-Type: text/plain\r\nContent-Length: %lu\r\nConnection: close\r\n\r\n%@",
        statusLine,
        (unsigned long)[responseBody lengthOfBytesUsingEncoding:NSUTF8StringEncoding], responseBody];
    const char *rb = [resp UTF8String];
    send(cfd, rb, strlen(rb), 0);
    close(cfd);
}

static void startServer(void) {
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        int sfd = socket(AF_INET, SOCK_STREAM, 0);
        if (sfd < 0) { KBLog(@"socket() failed"); return; }
        int one = 1; setsockopt(sfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        struct sockaddr_in addr; memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET; addr.sin_addr.s_addr = INADDR_ANY; addr.sin_port = htons(tweakHTTPPort);
        if (bind(sfd, (struct sockaddr *)&addr, sizeof(addr)) < 0) { KBLog(@"bind(:%d) failed errno=%d", tweakHTTPPort, errno); close(sfd); return; }
        if (listen(sfd, 8) < 0) { KBLog(@"listen failed"); close(sfd); return; }
        KBLog(@"VanquelTweak HTTP listening on :%d (host=%@)", tweakHTTPPort, tweakHostProcess);
        while (1) {
            struct sockaddr_in cli; socklen_t cl = sizeof(cli);
            int cfd = accept(sfd, (struct sockaddr *)&cli, &cl);
            if (cfd < 0) continue;
            // CRASH-SAFE: we are inside SpringBoard. A malformed request or an
            // IMCore hiccup must never escape as an uncaught exception (that would
            // respring the phone). handleClient always closes the socket; the
            // @catch is the last line of defense.
            @try {
                handleClient(cfd);
            } @catch (NSException *ex) {
                KBLog(@"EXC handleClient: %@ %@", ex.name, ex.reason);
                @try { close(cfd); } @catch (__unused NSException *e2) {}
            }
        }
    });
}

__attribute__((constructor))
static void VanquelTweakInit(void) {
    // TRIVIAL + DEFERRED + CRASH-SAFE. This runs inside SpringBoard now, so an
    // uncaught throw here would respring the phone. Do the bare minimum: identify
    // the process, bail out of everything else, and schedule the real work well
    // after SpringBoard has finished its own launch.
    @try {
        NSString *proc = [[NSProcessInfo processInfo] processName];
        if (!proc) proc = @"";
        KBLog(@"ctor loaded in process=%@", proc);
        // SpringBoard owns the always-on read/tapback/card listener on :8799.
        // MobileSMS owns a game-only-compatible send listener on :8800. Third-party
        // GamePigeon balloons can be inserted from SpringBoard but iOS 15 never
        // transports them; MobileSMS has the extension-aware IMCore context and does.
        // Keep the process gate even though the plist is filtered to both bundles.
        // (This mirrors how libsmserver gates its per-process behavior in its ctor
        // while its plist loads it into SpringBoard/MobileSMS/imagent.)
        BOOL isSpringBoard = [proc isEqualToString:@"SpringBoard"];
        BOOL isMobileSMS = [proc isEqualToString:@"MobileSMS"];
        if (!isSpringBoard && !isMobileSMS) return;
        tweakHostProcess = proc;
        tweakHTTPPort = isMobileSMS ? 8800 : 8799;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            @try {
                // Force-load the IMCore + IMDPersistence attachment path FIRST so
                // IMFileTransferCenter / IMDPersistentAttachmentController resolve
                // before the first card send (SpringBoard may not link them
                // natively). Logs + surfaces the result on /poc/ping.
                if (isSpringBoard) tweakForceLoadIMFrameworks();
                // Then connect to imagent so IMChatRegistry populates (SpringBoard
                // does not do this for us the way MobileSMS does on launch).
                if (isSpringBoard) tweakConnectIMDaemon();
                startServer();
            } @catch (NSException *ex) {
                KBLog(@"EXC deferred init: %@ %@", ex.name, ex.reason);
            }
        });
    } @catch (NSException *ex) {
        // Last-ditch: never let the ctor escape an exception into SpringBoard.
        KBLog(@"EXC ctor: %@ %@", ex.name, ex.reason);
    }
}
