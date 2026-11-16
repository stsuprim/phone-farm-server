"""Syntax check of the changed FBHTTPServer.m and FBWebServer.m (whole files) against stand-in headers.

The files are copied to a temp folder with `@import X;` turned into `#import <X/X.h>`; WebDriverAgent's own headers
they need are the real ones, except a few with wide dependencies, which get small stand-ins here.

Usage: python scripts/objc-check/check2.py .
"""
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
# libclang: `python -m pip install libclang` (or into a folder named in LIBCLANG_DIR with `--target`)
if os.environ.get("LIBCLANG_DIR"):
    sys.path.insert(0, os.environ["LIBCLANG_DIR"])
try:
    from clang import cindex  # noqa: E402
except ImportError:
    sys.exit("libclang is missing: python -m pip install libclang")

root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
routing = os.path.join(root, "wda", "WebDriverAgentLib", "Routing")
tmp = os.path.join(tempfile.gettempdir(), "lotus_check2")
shutil.rmtree(tmp, ignore_errors=True)
os.makedirs(os.path.join(tmp, "WebDriverAgentLib"))

STAND_INS = {
    "FBConfiguration.h": "#import <Foundation/Foundation.h>\n@interface FBConfiguration : NSObject\n@property (class, readonly) FBConfiguration *sharedInstance;\n@property (nonatomic) uint64_t httpRequestBodySizeLimit;\n@property (nonatomic, readonly) NSRange bindingPortRange;\n@property (nonatomic, readonly, nullable) NSString *bindingIPAddress;\n@end\n",
    "FBSession.h": "#import <Foundation/Foundation.h>\nextern NSString *const FBSessionWasKilledNotification;\n@interface FBSession : NSObject\n@property (class, readonly, nullable) FBSession *activeSession;\n@property (readonly) NSString *identifier;\n+ (nullable instancetype)sessionWithIdentifier:(NSString *)identifier;\n- (void)kill;\n@end\n",
    "FBLogger.h": '#import "wda.h"\n@interface FBLogger (More)\n+ (void)verboseLog:(NSString *)message;\n@end\n',
    "FBCommandStatus.h": '#import "wda.h"\n',
    "FBResponsePayload.h": '#import "wda.h"\n',
    "FBCommandHandler.h": '#import "FBRoute.h"\n@protocol FBCommandHandlerMore\n+ (BOOL)shouldRegisterAutomatically;\n@end\n',
    "FBErrorBuilder.h": "#import <Foundation/Foundation.h>\n@interface FBErrorBuilder : NSObject\n+ (instancetype)builder;\n- (instancetype)withDescription:(NSString *)d;\n- (instancetype)withInnerError:(NSError *)e;\n- (BOOL)buildError:(NSError **)error;\n@end\n",
    "FBExceptionHandler.h": "#import <Foundation/Foundation.h>\n@class RouteResponse;\n@interface FBExceptionHandler : NSObject\n- (void)handleException:(NSException *)exception forResponse:(RouteResponse *)response;\n@end\n",
    "FBRouteRequest.h": '#import "wda.h"\n@interface FBRouteRequest (More)\n+ (instancetype)routeRequestWithURL:(NSURL *)URL parameters:(NSDictionary *)parameters arguments:(NSDictionary *)arguments;\n@end\n',
    "FBRuntimeUtils.h": "#import <Foundation/Foundation.h>\nNSArray<Class> *FBClassesThatConformsToProtocol(Protocol *protocol);\n",
    "FBUnknownCommands.h": '#import "wda.h"\n@interface FBUnknownCommands : NSObject <FBCommandHandler>\n@end\n',
    "XCUIDevice+FBHelpers.h": '#import "wda.h"\n@interface XCUIDevice (Wifi)\n@property (nullable, readonly) NSString *fb_wifiIPAddress;\n@end\n',
    "FBRoute.h": '#import "wda.h"\n@class RouteResponse;\n@interface FBRoute (More)\n@property (nonatomic, copy, readonly) NSString *verb;\n@property (nonatomic, copy, readonly) NSString *path;\n@property (nonatomic, assign, readonly) BOOL isStandalone;\n- (void)mountRequest:(FBRouteRequest *)request intoResponse:(RouteResponse *)response;\n@end\n',
}


def rewrite(text):
    return re.sub(r"^@import (\w+);", r"#import <\1/\1.h>", text, flags=re.M)


for name in os.listdir(routing):
    if not name.endswith(".h") and name not in ("FBHTTPServer.m", "FBWebServer.m"):
        continue
    if name in STAND_INS:
        continue
    with open(os.path.join(routing, name), encoding="utf8") as f:
        text = rewrite(f.read())
    for dest in (tmp, os.path.join(tmp, "WebDriverAgentLib")):
        with open(os.path.join(dest, name), "w", encoding="utf8", newline="\n") as f:
            f.write(text)
for name, text in STAND_INS.items():
    for dest in (tmp, os.path.join(tmp, "WebDriverAgentLib")):
        with open(os.path.join(dest, name), "w", newline="\n") as f:
            f.write(text)
os.makedirs(os.path.join(tmp, "Network"))
with open(os.path.join(tmp, "Network", "Network.h"), "w", newline="\n") as f:
    f.write("#import <Foundation/Foundation.h>\n@protocol OS_nw_connection;\ntypedef id<OS_nw_connection> nw_connection_t;\nvoid nw_connection_cancel(nw_connection_t c);\n")

args = [
    "-x", "objective-c", "-fobjc-arc", "-fblocks", "-fsyntax-only", "-std=gnu11",
    "-target", "arm64-apple-ios15.0", "-nostdinc", "-fno-builtin",
    "-isystem", os.path.join(HERE, "libc"), "-I", os.path.join(HERE, "sdk"), "-I", tmp,
    "-Wall", "-Wno-unused-parameter", "-Wno-nullability-completeness",
]
index = cindex.Index.create()
total = 0
for name in ("FBHTTPServer.m", "FBWebServer.m"):
    bad = 0
    tu = index.parse(os.path.join(tmp, name), args=args)
    for d in tu.diagnostics:
        where = "%s:%d" % (os.path.basename(str(d.location.file)), d.location.line) if d.location.file else "?"
        level = {1: "note", 2: "warning", 3: "error", 4: "fatal"}.get(d.severity, str(d.severity))
        print("%s %s: %s" % (level, where, d.spelling))
        if d.severity >= 3:
            bad += 1
    print("%s: %s" % (name, "FAILED (%d errors)" % bad if bad else "parsed without errors"))
    total += bad
sys.exit(1 if total else 0)
