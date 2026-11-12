// ios/tweak/taskguard/TaskGuard.m
// TaskGuard: keeps SMServer's "is SMServer running?" check from crashing
// SpringBoard on the rootless iPhone lines.
//
// libsmserver's -[SMServerIPC checkIfRunning:] answers by launching
// `/var/sh -c "ps aux | grep <name> | grep -v grep"` with NSTask, inside
// SpringBoard, on every IMCore chat notification. Under memory pressure the
// spawn fails, -[NSTask launch] throws, nothing catches it, and SpringBoard
// aborts. palera1n then comes back in Safe Mode with every tweak off and the
// line stays down until someone taps the banner on the phone. An iOS 16 line
// did this twice in one day in production, both crash logs ending in
// -[NSConcreteTask launchWithDictionary:error:] under checkIfRunning:.
//
// The guard wraps the original method. A throw unwinds out of it before the
// pipe read, so returning NO cannot hang; every caller treats NO as "skip this
// update", and the bridge's /requests polling still picks the message up.

#import <Foundation/Foundation.h>
#import <objc/runtime.h>

static const char *TaskGuardLogPath = "/var/mobile/vanquel-taskguard.log";

static id (*origCheckIfRunning)(id self, SEL _cmd, id name);

static void TaskGuardLog(NSString *line) {
    FILE *f = fopen(TaskGuardLogPath, "a");
    if (!f) return;
    fprintf(f, "%s %s\n", [[[NSDate date] description] UTF8String], [line UTF8String]);
    fclose(f);
}

static id TaskGuardedCheckIfRunning(id self, SEL _cmd, id name) {
    @try {
        return origCheckIfRunning(self, _cmd, name);
    } @catch (NSException *e) {
        TaskGuardLog([NSString stringWithFormat:@"checkIfRunning:%@ threw %@: %@ -> NO", name, e.name, e.reason]);
        return @NO;
    }
}

// The tweak loader may run us before libsmserver has registered SMServerIPC,
// so retry once on the main queue, which runs after every tweak has loaded.
static BOOL TaskGuardInstall(void) {
    Class ipc = objc_getClass("SMServerIPC");
    Method m = ipc ? class_getInstanceMethod(ipc, @selector(checkIfRunning:)) : NULL;
    if (!m) return NO;
    origCheckIfRunning = (id (*)(id, SEL, id))method_setImplementation(m, (IMP)TaskGuardedCheckIfRunning);
    TaskGuardLog(@"installed on -[SMServerIPC checkIfRunning:]");
    return YES;
}

__attribute__((constructor))
static void TaskGuardInit(void) {
    if (TaskGuardInstall()) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!TaskGuardInstall()) TaskGuardLog(@"SMServerIPC not found; guard not installed");
    });
}
