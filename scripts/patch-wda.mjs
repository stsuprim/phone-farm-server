#!/usr/bin/env node
// Adds the fast touch route POST /wda/lotus/touch to a WebDriverAgent checkout (docs/BEST_METHOD.md, plan item 1b).
//
// WDA's own /wda/tap takes ~0.9 s on the phone: it looks up the active app through accessibility on every call, then
// XCTest waits for the daemon to confirm the event. This route builds the touch path at absolute coordinates (no app
// lookup) and answers as soon as it's queued; a small queue on the phone plays the touches in order.
//
// Body: {"points": [[x, y, ms], ...], "hold": ms (lift this long after the last point; 50 for a one-point tap),
//        "orientation": 1 (UIInterfaceOrientation; 1 = portrait)}  ->  {"value": {"queued": n, "lotus": 1}}
//
// Idempotent: run it again and it replaces its own block (markers below). Used by scripts/build-wda.sh.
// Usage: node scripts/patch-wda.mjs <WDA project folder> [--check | --remove]
//   --check: exit 0 if patched, 1 if not; --remove: take the route out again (then rebuild with scripts/build-wda.sh
//   and WDA_PATCH=0).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PATCH_VERSION = 1;
const BEGIN = '// >>> LOTUS_FAST_TOUCH';
const END = '// <<< LOTUS_FAST_TOUCH';
const TAG = `${BEGIN} v${PATCH_VERSION} (phone-farm scripts/patch-wda.mjs)`;

const IMPORTS = `${TAG}
#import "FBLogger.h"
#import "XCPointerEventPath.h"
#import "XCSynthesizedEventRecord.h"
#import "XCUIDevice.h"

#if !TARGET_OS_TV && !TARGET_OS_WATCH
static NSMutableArray *LotusTouchQueue;
static BOOL LotusTouchBusy = NO;
static NSUInteger LotusTouchGeneration = 0;
#endif
${END}
`;

const ROUTES = `    ${TAG}
#if !TARGET_OS_TV && !TARGET_OS_WATCH
    [[FBRoute POST:@"/wda/lotus/touch"].withoutSession respondWithTarget:self action:@selector(handleLotusTouch:)],
    [[FBRoute POST:@"/wda/lotus/touch"] respondWithTarget:self action:@selector(handleLotusTouch:)],
#endif
    ${END}
`;

const METHODS = `${TAG}
#if !TARGET_OS_TV && !TARGET_OS_WATCH
#pragma mark - Lotus fast touch

/** Plays the queued touches one after another (each was answered when it was queued). */
+ (void)lotus_pumpTouches
{
  if (LotusTouchBusy || LotusTouchQueue.count == 0) {
    return;
  }
  XCSynthesizedEventRecord *record = LotusTouchQueue.firstObject;
  [LotusTouchQueue removeObjectAtIndex:0];
  LotusTouchBusy = YES;
  NSUInteger generation = ++LotusTouchGeneration;
  // XCTest normally calls back; if it never does, the queue still moves on
  double timeout = record.maximumOffset + 10.0;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * (double)NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (LotusTouchBusy && LotusTouchGeneration == generation) {
      [FBLogger log:@"Lotus touch: no answer from XCTest, moving on"];
      LotusTouchBusy = NO;
      [FBCustomCommands lotus_pumpTouches];
    }
  });
  // the same call as WDA's own FBXCTestDaemonsProxy, without waiting for it (no run-loop spin)
  [[XCUIDevice.sharedDevice eventSynthesizer] synthesizeEvent:record completion:(id)^(BOOL result, NSError *invokeError) {
    if (nil != invokeError) {
      [FBLogger logFmt:@"Lotus touch failed: %@", invokeError.localizedDescription];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      if (LotusTouchGeneration == generation) {
        LotusTouchBusy = NO;
        [FBCustomCommands lotus_pumpTouches];
      }
    });
  }];
}

+ (id<FBResponsePayload>)handleLotusTouch:(FBRouteRequest *)request
{
  id pointsArg = request.arguments[@"points"];
  NSArray *points = [pointsArg isKindOfClass:NSArray.class] ? (NSArray *)pointsArg : nil;
  if (nil == points || points.count < 1 || points.count > 5000) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"'points' must be [[x, y, ms], ...] (1 to 5000)"
                                                                       traceback:nil]);
  }
  id orientationArg = request.arguments[@"orientation"];
  long long orientation = (long long)UIInterfaceOrientationPortrait;
  if ([orientationArg isKindOfClass:NSNumber.class]) {
    orientation = ((NSNumber *)orientationArg).longLongValue;
  }
  if (orientation < (long long)UIInterfaceOrientationPortrait || orientation > (long long)UIInterfaceOrientationLandscapeLeft) {
    orientation = (long long)UIInterfaceOrientationPortrait;
  }
  XCPointerEventPath *path = nil;
  double offset = 0;
  for (id item in points) {
    NSArray *p = [item isKindOfClass:NSArray.class] ? (NSArray *)item : nil;
    if (nil == p || p.count < 2 || ![p[0] isKindOfClass:NSNumber.class] || ![p[1] isKindOfClass:NSNumber.class]) {
      return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"each point must be [x, y, ms] (numbers)"
                                                                         traceback:nil]);
    }
    CGPoint point = CGPointMake(((NSNumber *)p[0]).doubleValue, ((NSNumber *)p[1]).doubleValue);
    if (p.count > 2 && [p[2] isKindOfClass:NSNumber.class]) {
      double at = ((NSNumber *)p[2]).doubleValue / 1000.0;
      if (at > offset) {
        offset = at;
      }
    }
    if (nil == path) {
      path = [[XCPointerEventPath alloc] initForTouchAtPoint:point offset:offset];
    } else {
      [path moveToPoint:point atOffset:offset];
    }
  }
  id holdArg = request.arguments[@"hold"];
  double hold = 0.0;
  if ([holdArg isKindOfClass:NSNumber.class] && ((NSNumber *)holdArg).doubleValue > 0.0) {
    hold = ((NSNumber *)holdArg).doubleValue / 1000.0;
  }
  if (points.count == 1 && hold <= 0.0) {
    hold = 0.05;
  }
  [path liftUpAtOffset:offset + hold];
  XCSynthesizedEventRecord *record = [[XCSynthesizedEventRecord alloc] initWithName:@"Lotus touch"
                                                               interfaceOrientation:orientation];
  [record addPointerEventPath:path];
  if (nil == LotusTouchQueue) {
    LotusTouchQueue = [NSMutableArray array];
  }
  if (LotusTouchQueue.count >= 64) {
    return FBResponseWithStatus([FBCommandStatus unknownErrorWithMessage:@"Too many touches are waiting on the phone"
                                                               traceback:nil]);
  }
  [LotusTouchQueue addObject:record];
  NSUInteger waiting = LotusTouchQueue.count + (LotusTouchBusy ? (NSUInteger)1 : (NSUInteger)0);
  [self lotus_pumpTouches];
  return FBResponseWithObject(@{@"queued": @(waiting), @"lotus": @(${PATCH_VERSION})});
}
#endif
${END}
`;

/** The file without any earlier Lotus block. */
export function unpatch(src) {
  let out = src;
  for (;;) {
    const b = out.indexOf(BEGIN);
    if (b < 0) return out;
    const e = out.indexOf(END, b);
    if (e < 0) throw new Error('FBCustomCommands.m has a Lotus begin marker without its end marker');
    const lineStart = out.lastIndexOf('\n', b) + 1;
    let lineEnd = out.indexOf('\n', e);
    lineEnd = lineEnd < 0 ? out.length : lineEnd + 1;
    out = out.slice(0, lineStart) + out.slice(lineEnd);
  }
}

/** FBCustomCommands.m's text with the fast route added (any earlier version replaced). */
export function patchSource(src) {
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  let s = unpatch(src.replace(/\r\n/g, '\n'));
  // right before the class: after all of the file's own imports, outside any #if
  const impl = s.search(/^@implementation FBCustomCommands\b/m);
  if (impl < 0) throw new Error('FBCustomCommands.m: @implementation FBCustomCommands not found');
  s = s.slice(0, impl) + IMPORTS + s.slice(impl);

  const routes = s.indexOf('+ (NSArray *)routes');
  if (routes < 0) throw new Error('FBCustomCommands.m: + (NSArray *)routes not found');
  const arr = s.indexOf('@[', routes);
  if (arr < 0) throw new Error('FBCustomCommands.m: the routes array (@[) not found');
  const arrEnd = s.indexOf('\n', arr) + 1;
  s = s.slice(0, arrEnd) + ROUTES + s.slice(arrEnd);

  const end = s.lastIndexOf('@end');
  if (end < 0) throw new Error('FBCustomCommands.m: @end not found');
  s = s.slice(0, end) + METHODS + s.slice(end);
  return nl === '\n' ? s : s.replace(/\n/g, nl);
}

export function isPatched(src) {
  return src.includes(TAG);
}

export function targetFile(wdaProject) {
  return path.join(wdaProject, 'WebDriverAgentLib', 'Commands', 'FBCustomCommands.m');
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const remove = args.includes('--remove');
  const proj = args.find((a) => !a.startsWith('--'));
  if (!proj) {
    console.error('usage: node scripts/patch-wda.mjs <WDA project folder> [--check | --remove]');
    process.exit(2);
  }
  const file = targetFile(proj.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  const src = fs.readFileSync(file, 'utf8');
  if (check) {
    console.log(isPatched(src) ? `patched (v${PATCH_VERSION}): ${file}` : `not patched: ${file}`);
    process.exit(isPatched(src) ? 0 : 1);
  }
  if (remove) {
    fs.writeFileSync(file, unpatch(src));
    console.log(`removed the Lotus fast touch route from ${file}`);
    return;
  }
  if (isPatched(src)) {
    console.log(`WDA already has the Lotus fast touch route (v${PATCH_VERSION})`);
    return;
  }
  const backup = `${file}.orig`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, unpatch(src));
  fs.writeFileSync(file, patchSource(src));
  console.log(`added the Lotus fast touch route (v${PATCH_VERSION}) to ${file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
