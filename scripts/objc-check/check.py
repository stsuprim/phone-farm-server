"""Syntax and type check of the Lotus additions to the vendored WebDriverAgent, with libclang and stand-in headers.

It cannot replace a build with Xcode (the stand-ins are hand-written), but it parses the real code with clang's
Objective-C front end: unbalanced brackets, misspelt names, wrong argument counts and the like are caught here.

Usage: python scripts/objc-check/check.py .
"""
import os
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
wda = os.path.join(root, "wda", "WebDriverAgentLib")
sdk = os.path.join(HERE, "sdk")
stubs = os.path.join(HERE, "stubs")
os.makedirs(stubs, exist_ok=True)
# every header the Lotus file imports by name resolves to the one stand-in
for name in [
    "FBCommandHandler.h", "FBCommandStatus.h", "FBImageProcessor.h", "FBLogger.h", "FBResponsePayload.h", "FBRoute.h",
    "FBRouteRequest.h", "FBScreen.h", "FBScreenshot.h", "FBUnattachedAppLauncher.h", "FBXCTestDaemonsProxy.h",
    "XCPointerEventPath.h", "XCSynthesizedEventRecord.h", "XCUIDevice.h", "XCUIDevice+FBHelpers.h", "XCUIScreen.h",
]:
    with open(os.path.join(stubs, name), "w") as f:
        f.write('#import "wda.h"\n')

args = [
    "-x", "objective-c", "-fobjc-arc", "-fblocks", "-fsyntax-only", "-std=gnu11",
    "-target", "arm64-apple-ios15.0", "-nostdinc", "-fno-builtin",
    "-isystem", os.path.join(HERE, "libc"), "-I", sdk, "-I", stubs,
    "-Wall", "-Wextra", "-Wno-unused-parameter", "-Wno-nullability-completeness",
]
harness = os.path.join(tempfile.gettempdir(), "lotus_check_harness.m")
with open(harness, "w") as f:
    f.write('#import "wda.h"\n')
    f.write('#include "%s"\n' % os.path.join(wda, "Commands", "FBLotusCommands.inc").replace("\\", "/"))

index = cindex.Index.create()
bad = 0
tu = index.parse(harness, args=args)
for d in tu.diagnostics:
    where = "%s:%d" % (os.path.basename(str(d.location.file)), d.location.line) if d.location.file else "?"
    level = {0: "ignored", 1: "note", 2: "warning", 3: "error", 4: "fatal"}.get(d.severity, str(d.severity))
    print("%s %s: %s" % (level, where, d.spelling))
    if d.severity >= 3:
        bad += 1
print("FBLotusCommands.inc: %s" % ("FAILED (%d errors)" % bad if bad else "parsed without errors"))
sys.exit(1 if bad else 0)
