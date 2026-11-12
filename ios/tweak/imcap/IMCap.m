// ios/tweak/imcap/IMCap.m
// -----------------------------------------------------------------------------
// IMCap: two small hooks an iOS 16 line needs and an iOS 13/15 line already
// gets from libsmserver.
//
// 1. CAPABILITIES. imagent only serves IMCore clients whose capability bits
//    say so. SpringBoard, MobileSMS and SMServer are made to report the bits
//    Messages itself has: -processCapabilities == 4485895 (iOS 16) and the
//    legacy -_capabilities == 17159 (iOS 13/15). Without this, imagent does
//    not serve the tweak's IMCore calls in SpringBoard on iOS 16 and its
//    sends fail. On iOS 13/15 libsmserver already applies the same values, so
//    installing both is a no-op there.
//
// 2. TYPING. SMServer's websocket "typing:<chat>" frame calls
//    -[IWSSender sendTyping:forChat:] inside the SMServer app, which on iOS 16
//    cannot reach the chat. This forwards the call over MRYIPC (libmryipc,
//    already installed with SMServer) to SpringBoard, where
//    -setLocalUserIsTyping: on the conversation works. Each call leaves a
//    tiny receipt in /var/mobile/vanquel-imcap-typing-ack.json, so you can see
//    over SSH that a typing frame reached SpringBoard and not just SMServer.
//
// Build (on a Mac with Xcode) and install: scripts/phone/install-helper-tweak.sh imcap
// -----------------------------------------------------------------------------

#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <stdarg.h>
#import <sys/stat.h>

static NSString *const IMCapTypingCenterName = @"com.example.vanquel.typing";
static const char *IMCapLogPath = "/var/mobile/vanquel-imcap.log";
static const char *IMCapTypingAckPath = "/var/mobile/vanquel-imcap-typing-ack.json";

static unsigned long long (*origProcessCapabilities)(id self, SEL _cmd);
static unsigned (*origCapabilities)(id self, SEL _cmd);
static void (*origSendTyping)(id self, SEL _cmd, BOOL isTyping, NSString *chat);
static id imcapTypingCenter;
static BOOL imcapTypingHookInstalled;
static BOOL imcapTypingResponderInstalled;

static id IMCapMsgId(id target, SEL selector) {
    return ((id (*)(id, SEL))objc_msgSend)(target, selector);
}

static id IMCapMsgIdArg(id target, SEL selector, id arg) {
    return ((id (*)(id, SEL, id))objc_msgSend)(target, selector, arg);
}

static BOOL IMCapMsgBool(id target, SEL selector) {
    return ((BOOL (*)(id, SEL))objc_msgSend)(target, selector);
}

static void IMCapMsgVoidBool(id target, SEL selector, BOOL arg) {
    ((void (*)(id, SEL, BOOL))objc_msgSend)(target, selector, arg);
}

static void IMCapMsgVoidIdSel(id target, SEL selector, id arg, SEL action) {
    ((void (*)(id, SEL, id, SEL))objc_msgSend)(target, selector, arg, action);
}

static void IMCapMsgVoidSelId(id target, SEL selector, SEL action, id arg) {
    ((void (*)(id, SEL, SEL, id))objc_msgSend)(target, selector, action, arg);
}

static NSString *IMCapProcessName(void) {
    return [[NSProcessInfo processInfo] processName] ?: @"unknown";
}

static NSString *IMCapBundleID(void) {
    return [[NSBundle mainBundle] bundleIdentifier] ?: @"";
}

static BOOL IMCapIsSpringBoard(void) {
    return [IMCapProcessName() isEqualToString:@"SpringBoard"] ||
           [IMCapBundleID() isEqualToString:@"com.apple.springboard"];
}

static BOOL IMCapIsSMServerApp(void) {
    return [IMCapProcessName() isEqualToString:@"SMServer"] ||
           [IMCapBundleID() isEqualToString:@"com.ianwelker.smserver"];
}

static void IMCapLog(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);

    NSString *line = [NSString stringWithFormat:@"%@ [%@] %@\n", [NSDate date], IMCapProcessName(), message ?: @""];
    NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
    if (!data) return;

    NSString *path = [NSString stringWithUTF8String:IMCapLogPath];
    NSFileManager *manager = [NSFileManager defaultManager];
    if (![manager fileExistsAtPath:path]) {
        [manager createFileAtPath:path contents:nil attributes:@{ NSFilePosixPermissions: @0666 }];
        chmod(IMCapLogPath, 0666);
    }

    NSFileHandle *file = [NSFileHandle fileHandleForWritingAtPath:path];
    if (!file) return;
    @try {
        [file seekToEndOfFile];
        [file writeData:data];
        [file closeFile];
    } @catch (__unused id exception) {
    }
}

// The Mac watchdog reads this tiny receipt over key-based SSH after sending its
// harmless idle canary. A successful WebSocket upgrade only proves that
// SMServer accepted bytes; this receipt proves the IPC reached SpringBoard.
static void IMCapWriteTypingAck(NSString *chatID, BOOL typing, NSString *result) {
    NSDictionary *payload = @{
        @"at": @((long long)([[NSDate date] timeIntervalSince1970] * 1000.0)),
        @"chat": chatID ?: @"",
        @"typing": @(typing),
        @"result": result ?: @"received"
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
    if (!data) return;
    NSString *path = [NSString stringWithUTF8String:IMCapTypingAckPath];
    if ([data writeToFile:path atomically:YES]) chmod(IMCapTypingAckPath, 0666);
}

static BOOL IMCapShouldGrant(void) {
    NSString *process = IMCapProcessName();
    return [process isEqualToString:@"SpringBoard"] ||
           [process isEqualToString:@"MobileSMS"] ||
           [process isEqualToString:@"SMServer"];
}

static unsigned long long IMCapProcessCapabilities(id self, SEL _cmd) {
    if (IMCapShouldGrant()) {
        return 4485895ULL;
    }
    return origProcessCapabilities ? origProcessCapabilities(self, _cmd) : 0;
}

static unsigned IMCapCapabilities(id self, SEL _cmd) {
    if (IMCapShouldGrant()) {
        return 17159U;
    }
    return origCapabilities ? origCapabilities(self, _cmd) : 0;
}

static void IMCapLoadMessagingFrameworks(void) {
    [[NSBundle bundleWithPath:@"/System/Library/PrivateFrameworks/IMCore.framework"] load];
    [[NSBundle bundleWithPath:@"/System/Library/PrivateFrameworks/ChatKit.framework"] load];
}

static id IMCapCenterNamed(NSString *name) {
    Class centerClass = objc_getClass("MRYIPCCenter");
    if (!centerClass) return nil;
    return IMCapMsgIdArg((id)centerClass, sel_registerName("centerNamed:"), name);
}

static id IMCapTypingCenter(void) {
    if (!imcapTypingCenter) {
        imcapTypingCenter = IMCapCenterNamed(IMCapTypingCenterName);
    }
    return imcapTypingCenter;
}

static id IMCapExistingChat(NSString *chatID) {
    Class registryClass = objc_getClass("IMChatRegistry");
    id registry = registryClass ? IMCapMsgId((id)registryClass, sel_registerName("sharedInstance")) : nil;
    if (!registry) return nil;
    return IMCapMsgIdArg(registry, sel_registerName("existingChatWithChatIdentifier:"), chatID);
}

static id IMCapExistingConversation(NSString *chatID) {
    Class listClass = objc_getClass("CKConversationList");
    id list = listClass ? IMCapMsgId((id)listClass, sel_registerName("sharedConversationList")) : nil;
    if (!list) return nil;
    return IMCapMsgIdArg(list, sel_registerName("conversationForExistingChatWithGroupID:"), chatID);
}

static BOOL IMCapConnectToDaemon(void) {
    Class controllerClass = objc_getClass("IMDaemonController");
    id controller = controllerClass ? IMCapMsgId((id)controllerClass, sel_registerName("sharedController")) : nil;
    return controller ? IMCapMsgBool(controller, sel_registerName("connectToDaemon")) : NO;
}

@interface VanquelTypingHandler : NSObject
+ (instancetype)sharedInstance;
- (void)vanquelSetTyping:(NSDictionary *)payload;
@end

@implementation VanquelTypingHandler

+ (instancetype)sharedInstance {
    static VanquelTypingHandler *shared;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        shared = [[VanquelTypingHandler alloc] init];
    });
    return shared;
}

- (void)vanquelSetTyping:(NSDictionary *)payload {
    if (![payload isKindOfClass:[NSDictionary class]]) return;

    NSString *chatID = [[payload objectForKey:@"chat"] description];
    BOOL typing = [[payload objectForKey:@"typing"] boolValue];
    if (![chatID length]) return;

    dispatch_async(dispatch_get_main_queue(), ^{
        IMCapWriteTypingAck(chatID, typing, @"received");
        IMCapLoadMessagingFrameworks();
        BOOL connected = IMCapConnectToDaemon();
        id target = nil;
        NSString *source = @"none";

        if (connected) {
            id conversation = IMCapExistingConversation(chatID);
            if (conversation && [conversation respondsToSelector:sel_registerName("setLocalUserIsTyping:")]) {
                target = conversation;
                source = @"CKConversation";
            }

            if (!target) {
                id chat = IMCapExistingChat(chatID);
                if (chat && [chat respondsToSelector:sel_registerName("setLocalUserIsTyping:")]) {
                    target = chat;
                    source = @"IMChat";
                }
            }
        }

        if (!target) {
            IMCapLog(@"vanquelSetTyping chat nil chat=%@ typing=%d connected=%d", chatID, typing, connected);
            IMCapWriteTypingAck(chatID, typing, @"chat_nil");
            return;
        }

        @try {
            IMCapMsgVoidBool(target, sel_registerName("setLocalUserIsTyping:"), typing);
            IMCapLog(@"vanquelSetTyping OK source=%@ chat=%@ typing=%d", source, chatID, typing);
            IMCapWriteTypingAck(chatID, typing, @"ok");
        } @catch (id exception) {
            IMCapLog(@"vanquelSetTyping exception chat=%@ typing=%d exception=%@", chatID, typing, exception);
            IMCapWriteTypingAck(chatID, typing, @"exception");
        }
    });
}

@end

static void IMCapForwardSendTyping(id self, SEL _cmd, BOOL isTyping, NSString *chat) {
    if (![chat length]) {
        if (origSendTyping) origSendTyping(self, _cmd, isTyping, chat);
        return;
    }

    id center = IMCapTypingCenter();
    if (!center) {
        IMCapLog(@"sendTyping no MRYIPCCenter chat=%@ typing=%d", chat, isTyping);
        if (origSendTyping) origSendTyping(self, _cmd, isTyping, chat);
        return;
    }

    NSDictionary *payload = @{ @"chat": chat, @"typing": @(isTyping) };
    @try {
        IMCapMsgVoidSelId(center, sel_registerName("callExternalVoidMethod:withArguments:"), sel_registerName("vanquelSetTyping:"), payload);
        IMCapLog(@"sendTyping forwarded chat=%@ typing=%d", chat, isTyping);
    } @catch (id exception) {
        IMCapLog(@"sendTyping exception chat=%@ typing=%d exception=%@", chat, isTyping, exception);
        if (origSendTyping) origSendTyping(self, _cmd, isTyping, chat);
    }
}

static void IMCapInstallTypingAppHook(int attempt);
static void IMCapInstallTypingResponder(int attempt);

static void IMCapScheduleTypingAppHookRetry(int attempt) {
    if (attempt >= 40) {
        IMCapLog(@"IWSSender hook gave up");
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        IMCapInstallTypingAppHook(attempt + 1);
    });
}

static void IMCapScheduleTypingResponderRetry(int attempt) {
    if (attempt >= 40) {
        IMCapLog(@"typing responder gave up waiting for MRYIPCCenter");
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        IMCapInstallTypingResponder(attempt + 1);
    });
}

static void IMCapInstallTypingAppHook(int attempt) {
    if (!IMCapIsSMServerApp() || imcapTypingHookInstalled) return;

    Class senderClass = objc_getClass("IWSSender");
    if (!senderClass) {
        IMCapScheduleTypingAppHookRetry(attempt);
        return;
    }

    Method method = class_getInstanceMethod(senderClass, @selector(sendTyping:forChat:));
    if (!method) {
        IMCapScheduleTypingAppHookRetry(attempt);
        return;
    }

    origSendTyping = (void (*)(id, SEL, BOOL, NSString *))method_getImplementation(method);
    method_setImplementation(method, (IMP)IMCapForwardSendTyping);
    imcapTypingHookInstalled = YES;
    IMCapLog(@"hooked IWSSender sendTyping:forChat: attempt=%d", attempt);
}

static void IMCapInstallTypingResponder(int attempt) {
    if (!IMCapIsSpringBoard() || imcapTypingResponderInstalled) return;

    id center = IMCapTypingCenter();
    if (!center) {
        IMCapScheduleTypingResponderRetry(attempt);
        return;
    }

    @try {
        IMCapMsgVoidIdSel(center, sel_registerName("addTarget:action:"), [VanquelTypingHandler sharedInstance], sel_registerName("vanquelSetTyping:"));
        imcapTypingResponderInstalled = YES;
        IMCapLog(@"registered typing responder in SpringBoard attempt=%d", attempt);
    } @catch (id exception) {
        IMCapLog(@"typing responder register exception attempt=%d exception=%@", attempt, exception);
        IMCapScheduleTypingResponderRetry(attempt);
    }
}

__attribute__((constructor))
static void IMCapInstallIMDaemonCapabilityHooks(void) {
    IMCapLoadMessagingFrameworks();

    Class controller = objc_getClass("IMDaemonController");
    if (controller) {
        Method processMethod = class_getInstanceMethod(controller, @selector(processCapabilities));
        if (processMethod) {
            origProcessCapabilities = (unsigned long long (*)(id, SEL))method_getImplementation(processMethod);
            method_setImplementation(processMethod, (IMP)IMCapProcessCapabilities);
        }

        Method legacyMethod = class_getInstanceMethod(controller, @selector(_capabilities));
        if (legacyMethod) {
            origCapabilities = (unsigned (*)(id, SEL))method_getImplementation(legacyMethod);
            method_setImplementation(legacyMethod, (IMP)IMCapCapabilities);
        }
    }

    IMCapInstallTypingAppHook(0);
    IMCapInstallTypingResponder(0);
}
