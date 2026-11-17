/**
 * Lotus's own routes (phone-farm). This file is not a member of the Xcode project: FBCustomCommands.m includes it
 * at its end, so adding it needs no project change. FBLotusCommands conforms to FBCommandHandler, so the web server
 * registers its routes by itself (FBWebServer collects every such class).
 *
 *   GET  /lotus/info      which build this is (the Mac's server tells our build from a stock WebDriverAgent by it)
 *   POST /lotus/gesture   one whole gesture in one command, played by the phone itself:
 *                         {"points": [[x, y, ms], ...], "hold": ms, "gap": ms, "orientation": 1} -> {"queued": n}
 *                         v3: "gap" (0-500 ms) is a pause the phone keeps after this gesture has played, before
 *                         the next record (live mode 5)
 *   POST /lotus/touch     one event of a live touch: {"phase": "down" | "move" | "up", "x": .., "y": .., "mode": 1-3}
 *                         The finger stays down on the phone between requests (see "Live touch" below).
 *   GET  /lotus/shot      one still as a JPEG: ?scale=1-100&quality=1-100 -> {"jpeg": "<base64>"}
 *   POST /lotus/selftest  finds out, on this phone, which way of live touch works (see "Self-test"): a held
 *                         finger (modes 1-3) or, v2 (2026-11-17), segmented drags (mode 4: short whole
 *                         gestures the Mac's server sends through /lotus/gesture as the finger moves) and, v3,
 *                         gapped segments (mode 5: the same with a pause between two segments)
 *
 * Coordinates are points of the screen as the record's orientation says (the Mac's server sends portrait points
 * with "orientation": 1, turning a landscape touch onto the panel itself).
 *
 * TO VERIFY ON A PHONE (none of this was compiled or run where it was written; see docs/MAC_STEPS_2026-11-15b.md):
 * that it compiles with the Mac's Xcode, that /lotus/selftest finds a working mode, and that a live drag feels
 * continuous. Until the self-test says a mode works, the Mac's server does not use /lotus/touch at all.
 */

#if !TARGET_OS_TV && !TARGET_OS_WATCH

#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

#import "FBCommandHandler.h"
#import "FBCommandStatus.h"
#import "FBImageProcessor.h"
#import "FBLogger.h"
#import "FBResponsePayload.h"
#import "FBRoute.h"
#import "FBRouteRequest.h"
#import "FBScreen.h"
#import "FBScreenshot.h"
#import "FBUnattachedAppLauncher.h"
#import "FBXCTestDaemonsProxy.h"
#import "XCPointerEventPath.h"
#import "XCSynthesizedEventRecord.h"
#import "XCUIDevice.h"
#import "XCUIDevice+FBHelpers.h"
#import "XCUIScreen.h"

// Our additions are kept clear of the project's -Weverything -Werror: a warning in them must never fail the build.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Weverything"

/** The version of our changes. The Mac's server installs this build on a phone whose build says another number. */
static const NSInteger LotusForkVersion = 3;
static NSString *const LotusUpstreamTag = @"v16.15.3";

/** How long one step of a live move takes on the phone (seconds): about a frame. */
static const double LotusLiveStepSeconds = 0.016;
/** A live finger nobody has said anything about for this long is lifted (the Mac's server lifts it far sooner). */
static const double LotusLiveStaleSeconds = 10.0;
static const NSUInteger LotusMostWaiting = 64;

// ---- state: touched only on the main queue (every route here but /lotus/info and /lotus/shot runs on it) ----

/** A record is with XCTest now (one at a time: the phone plays them in order). */
static BOOL LotusSynthBusy = NO;
static NSUInteger LotusSynthGeneration = 0;
/** Whole gestures waiting to be played: @{@"record": XCSynthesizedEventRecord, @"gap": seconds to wait after it}. */
static NSMutableArray *LotusGestureQueue;
/** Live touch events waiting to be played: @{@"phase", @"x", @"y", @"mode", @"orientation"}. */
static NSMutableArray *LotusLiveOps;
/** A finger of ours is down on the screen now, where, and how its contact is held (the mode). */
static BOOL LotusLiveDown = NO;
static CGPoint LotusLivePoint;
static NSInteger LotusLiveMode = 1;
static long long LotusLiveOrientation = 1;
/** The same as it will be once everything waiting has played (what the next request builds on). */
static BOOL LotusLiveQueuedDown = NO;
static CGPoint LotusLiveQueuedPoint;
/** When a live touch request last came, and what XCTest said of the last live record that failed. */
static CFAbsoluteTime LotusLiveHeardAt = 0;
static NSString *LotusLiveError;
static BOOL LotusLiveWatching = NO;

/** Records every touch our own window gets during the self-test: B began, M moved, E ended, C cancelled. */
@interface LotusProbeView : UIView
@property (nonatomic, strong) NSMutableString *seen;
@property (nonatomic, assign) CGPoint beganAt;
@property (nonatomic, assign) CGPoint lastAt;
@end

@implementation LotusProbeView

- (void)lotus_note:(NSString *)what touches:(NSSet<UITouch *> *)touches
{
  UITouch *touch = touches.anyObject;
  if (nil != touch) {
    self.lastAt = [touch locationInView:self];
    if ([what isEqualToString:@"B"]) {
      self.beganAt = self.lastAt;
    }
  }
  [self.seen appendString:what];
}

- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
  [self lotus_note:@"B" touches:touches];
}

- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
  [self lotus_note:@"M" touches:touches];
}

- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
  [self lotus_note:@"E" touches:touches];
}

- (void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
  [self lotus_note:@"C" touches:touches];
}

@end

@interface FBLotusCommands : NSObject <FBCommandHandler>
@end

@implementation FBLotusCommands

+ (NSArray *)routes
{
  return
  @[
    [[FBRoute GET:@"/lotus/info"].withoutSession.standalone respondWithTarget:self action:@selector(handleLotusInfo:)],
    [[FBRoute POST:@"/lotus/gesture"].withoutSession respondWithTarget:self action:@selector(handleLotusGesture:)],
    [[FBRoute POST:@"/lotus/touch"].withoutSession respondWithTarget:self action:@selector(handleLotusTouch:)],
    [[FBRoute GET:@"/lotus/shot"].withoutSession.standalone respondWithTarget:self action:@selector(handleLotusShot:)],
    [[FBRoute POST:@"/lotus/selftest"].withoutSession respondWithTarget:self action:@selector(handleLotusSelfTest:)],
  ];
}

#pragma mark - Helpers

/** A number from JSON or a query string, kept within [low, high]; `fallback` when it isn't one. */
+ (double)lotus_number:(id)value fallback:(double)fallback low:(double)low high:(double)high
{
  double number = fallback;
  if ([value isKindOfClass:NSNumber.class]) {
    number = ((NSNumber *)value).doubleValue;
  } else if ([value isKindOfClass:NSString.class] && ((NSString *)value).length > 0) {
    number = ((NSString *)value).doubleValue;
  }
  if (number != number) {
    number = fallback;
  }
  return MIN(high, MAX(low, number));
}

/** UIInterfaceOrientation from a request (1 = portrait, the default). */
+ (long long)lotus_orientation:(id)value
{
  long long orientation = (long long)UIInterfaceOrientationPortrait;
  if ([value isKindOfClass:NSNumber.class]) {
    orientation = ((NSNumber *)value).longLongValue;
  }
  if (orientation < (long long)UIInterfaceOrientationPortrait || orientation > (long long)UIInterfaceOrientationLandscapeLeft) {
    orientation = (long long)UIInterfaceOrientationPortrait;
  }
  return orientation;
}

+ (id<FBResponsePayload>)lotus_invalid:(NSString *)message
{
  return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:message traceback:nil]);
}

/** Lets the main run loop turn for `seconds` (touches reach our window, XCTest's answers come in). */
+ (void)lotus_spin:(NSTimeInterval)seconds
{
  NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
  while (until.timeIntervalSinceNow > 0) {
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  }
}

#pragma mark - One record at a time

/**
 Gives XCTest the next record: live touch events first (a finger that's down comes before anything else), then
 whole gestures. Each request was answered when it was queued; this plays them in the order they came.
 */
+ (void)lotus_pump
{
  if (LotusSynthBusy) {
    return;
  }
  XCSynthesizedEventRecord *record = nil;
  BOOL live = NO;
  // v3: how long the phone waits after this record has played before the next one (a gesture's "gap", live mode 5)
  double gapAfter = 0;
  while (nil == record && LotusLiveOps.count > 0) {
    NSDictionary *op = LotusLiveOps.firstObject;
    [LotusLiveOps removeObjectAtIndex:0];
    record = [self lotus_recordForLiveOp:op];
    live = nil != record;
  }
  if (nil == record && LotusGestureQueue.count > 0) {
    NSDictionary *entry = LotusGestureQueue.firstObject;
    [LotusGestureQueue removeObjectAtIndex:0];
    record = entry[@"record"];
    gapAfter = ((NSNumber *)entry[@"gap"]).doubleValue;
  }
  if (nil == record) {
    return;
  }
  LotusSynthBusy = YES;
  NSUInteger generation = ++LotusSynthGeneration;
  // XCTest normally calls back; if it never does, the queue still moves on
  double timeout = record.maximumOffset + (live ? 3.0 : 10.0);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * (double)NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (LotusSynthBusy && LotusSynthGeneration == generation) {
      [FBLogger log:@"Lotus: no answer from XCTest for a touch record, moving on"];
      if (live) {
        LotusLiveError = @"XCTest did not answer a live touch record";
      }
      LotusSynthBusy = NO;
      [FBLotusCommands lotus_pump];
    }
  });
  // the same call as WDA's own FBXCTestDaemonsProxy, without waiting for it (no run-loop spin)
  [[XCUIDevice.sharedDevice eventSynthesizer] synthesizeEvent:record completion:(id)^(BOOL result, NSError *invokeError) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (nil != invokeError) {
        [FBLogger logFmt:@"Lotus: a touch record failed: %@", invokeError.localizedDescription];
        if (live) {
          LotusLiveError = invokeError.localizedDescription ?: @"XCTest refused a live touch record";
        }
      }
      if (LotusSynthGeneration != generation) {
        return;
      }
      if (gapAfter <= 0) {
        LotusSynthBusy = NO;
        [FBLotusCommands lotus_pump];
        return;
      }
      // v3 (live mode 5): the queue stays busy for the gap, so the next record's press never comes straight after
      // this one's lift (iOS 18.5 lost one of two back-to-back segments). A new generation: the timeout above
      // no longer applies to this record.
      NSUInteger afterGap = ++LotusSynthGeneration;
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(gapAfter * (double)NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (LotusSynthBusy && LotusSynthGeneration == afterGap) {
          LotusSynthBusy = NO;
          [FBLotusCommands lotus_pump];
        }
      });
    });
  }];
}

#pragma mark - Whole gestures

/**
 POST /lotus/gesture: one finger through every point at its own time, built at absolute coordinates (no lookup of
 the app in front) and answered as soon as it's queued. The phone plays the whole gesture by itself, so a curve
 stays smooth whatever the link to the Mac does meanwhile. A single point is a tap held `hold` ms (50 by default).
 */
+ (id<FBResponsePayload>)handleLotusGesture:(FBRouteRequest *)request
{
  id pointsArg = request.arguments[@"points"];
  NSArray *points = [pointsArg isKindOfClass:NSArray.class] ? (NSArray *)pointsArg : nil;
  if (nil == points || points.count < 1 || points.count > 5000) {
    return [self lotus_invalid:@"'points' must be [[x, y, ms], ...] (1 to 5000)"];
  }
  long long orientation = [self lotus_orientation:request.arguments[@"orientation"]];
  XCPointerEventPath *path = nil;
  double offset = 0;
  for (id item in points) {
    NSArray *p = [item isKindOfClass:NSArray.class] ? (NSArray *)item : nil;
    if (nil == p || p.count < 2 || ![p[0] isKindOfClass:NSNumber.class] || ![p[1] isKindOfClass:NSNumber.class]) {
      return [self lotus_invalid:@"each point must be [x, y, ms] (numbers)"];
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
  double hold = [self lotus_number:request.arguments[@"hold"] fallback:0 low:0 high:60000] / 1000.0;
  if (points.count == 1 && hold <= 0.0) {
    hold = 0.05;
  }
  [path liftUpAtOffset:offset + hold];
  // v3: a pause after this gesture before the next record (live mode 5); 0, the default, is v2's behaviour
  double gap = [self lotus_number:request.arguments[@"gap"] fallback:0 low:0 high:500] / 1000.0;
  XCSynthesizedEventRecord *record = [[XCSynthesizedEventRecord alloc] initWithName:@"Lotus gesture"
                                                               interfaceOrientation:orientation];
  [record addPointerEventPath:path];
  if (nil == LotusGestureQueue) {
    LotusGestureQueue = [NSMutableArray array];
  }
  if (LotusGestureQueue.count >= LotusMostWaiting) {
    return FBResponseWithStatus([FBCommandStatus unknownErrorWithMessage:@"Too many touches are waiting on the phone"
                                                               traceback:nil]);
  }
  // a finger held down by a live touch is lifted first: two touches of ours never overlap
  if (LotusLiveQueuedDown) {
    [self lotus_queueLive:@"up" at:LotusLiveQueuedPoint mode:LotusLiveMode orientation:LotusLiveOrientation];
  }
  [LotusGestureQueue addObject:@{@"record": record, @"gap": @(gap)}];
  NSUInteger waiting = LotusGestureQueue.count + LotusLiveOps.count + (LotusSynthBusy ? (NSUInteger)1 : (NSUInteger)0);
  [self lotus_pump];
  return FBResponseWithObject(@{@"queued": @(waiting), @"lotus": @(LotusForkVersion)});
}

#pragma mark - Live touch

/**
 Live touch. XCTest plays whole records, so a finger that stays down across requests is made of several: a record
 that presses and does not lift, records that start where the finger is and move it on (not lifting either), and a
 last one that lifts. Whether the contact survives between two records depends on XCTest, and there are three ways
 to ask for it (`mode`):
   1  plain: the records simply don't lift
   2  the press record sets beginsPersistentState, the lift record endsPersistentState
   3  as 2, and every move record sets beginsPersistentState too
 Which one works (if any) is found on the phone itself by POST /lotus/selftest; the Mac's server then sends that
 mode with every event, and sends none at all when the self-test found no working mode.
 */
+ (XCSynthesizedEventRecord *)lotus_recordFrom:(CGPoint)from
                                            to:(CGPoint)to
                                       seconds:(double)seconds
                                          lift:(BOOL)lift
                                        begins:(BOOL)begins
                                          ends:(BOOL)ends
                                   orientation:(long long)orientation
{
  XCPointerEventPath *path = [[XCPointerEventPath alloc] initForTouchAtPoint:from offset:0];
  double offset = 0;
  if (seconds > 0) {
    offset = seconds;
    [path moveToPoint:to atOffset:offset];
  }
  if (lift) {
    [path liftUpAtOffset:offset + 0.01];
  }
  XCSynthesizedEventRecord *record = [[XCSynthesizedEventRecord alloc] initWithName:@"Lotus live touch"
                                                               interfaceOrientation:orientation];
  [record addPointerEventPath:path];
  // not every XCTest has these two (they came with a later Xcode): asked for only where they exist
  if (begins && [record respondsToSelector:@selector(setBeginsPersistentState:)]) {
    record.beginsPersistentState = YES;
  }
  if (ends && [record respondsToSelector:@selector(setEndsPersistentState:)]) {
    record.endsPersistentState = YES;
  }
  return record;
}

/** The record of one waiting live event, or nil when it has nothing to do (a move to where the finger is). */
+ (XCSynthesizedEventRecord *)lotus_recordForLiveOp:(NSDictionary *)op
{
  NSString *phase = op[@"phase"];
  CGPoint point = CGPointMake(((NSNumber *)op[@"x"]).doubleValue, ((NSNumber *)op[@"y"]).doubleValue);
  if ([phase isEqualToString:@"down"]) {
    LotusLiveMode = ((NSNumber *)op[@"mode"]).integerValue;
    LotusLiveOrientation = ((NSNumber *)op[@"orientation"]).longLongValue;
    LotusLiveDown = YES;
    LotusLivePoint = point;
    return [self lotus_recordFrom:point to:point seconds:0 lift:NO begins:(LotusLiveMode >= 2) ends:NO orientation:LotusLiveOrientation];
  }
  if (!LotusLiveDown) {
    return nil;
  }
  CGPoint from = LotusLivePoint;
  BOOL moved = fabs(point.x - from.x) > 0.01 || fabs(point.y - from.y) > 0.01;
  if ([phase isEqualToString:@"move"]) {
    if (!moved) {
      return nil;
    }
    LotusLivePoint = point;
    return [self lotus_recordFrom:from to:point seconds:LotusLiveStepSeconds lift:NO begins:(LotusLiveMode == 3) ends:NO orientation:LotusLiveOrientation];
  }
  // up
  LotusLiveDown = NO;
  LotusLivePoint = point;
  return [self lotus_recordFrom:from to:point seconds:(moved ? LotusLiveStepSeconds : 0) lift:YES begins:NO ends:(LotusLiveMode >= 2) orientation:LotusLiveOrientation];
}

/** Queues one live event. A move replaces a move still waiting (the newest place is the one that matters). */
+ (void)lotus_queueLive:(NSString *)phase at:(CGPoint)point mode:(NSInteger)mode orientation:(long long)orientation
{
  if (nil == LotusLiveOps) {
    LotusLiveOps = [NSMutableArray array];
  }
  NSDictionary *op = @{@"phase": phase, @"x": @(point.x), @"y": @(point.y), @"mode": @(mode), @"orientation": @(orientation)};
  NSDictionary *last = LotusLiveOps.lastObject;
  if ([phase isEqualToString:@"move"] && nil != last && [last[@"phase"] isEqualToString:@"move"]) {
    [LotusLiveOps removeLastObject];
  }
  [LotusLiveOps addObject:op];
  LotusLiveQueuedPoint = point;
  if ([phase isEqualToString:@"down"]) {
    LotusLiveQueuedDown = YES;
    LotusLiveMode = mode;
    LotusLiveOrientation = orientation;
  } else if ([phase isEqualToString:@"up"]) {
    LotusLiveQueuedDown = NO;
  }
}

/** While a live finger is down: lifts it if nothing was heard of it for LotusLiveStaleSeconds (no stuck fingers). */
+ (void)lotus_watchLive
{
  if (LotusLiveWatching) {
    return;
  }
  LotusLiveWatching = YES;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.0 * (double)NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    LotusLiveWatching = NO;
    if (!LotusLiveQueuedDown) {
      return;
    }
    if (CFAbsoluteTimeGetCurrent() - LotusLiveHeardAt > LotusLiveStaleSeconds) {
      [FBLogger log:@"Lotus: a live touch went quiet; lifting it"];
      [FBLotusCommands lotus_queueLive:@"up" at:LotusLiveQueuedPoint mode:LotusLiveMode orientation:LotusLiveOrientation];
      [FBLotusCommands lotus_pump];
      return;
    }
    [FBLotusCommands lotus_watchLive];
  });
}

/**
 POST /lotus/touch {"phase", "x", "y", "mode", "orientation"}: one event of a live touch, answered when it's queued:
 {"down": whether the finger is (or is about to be) down, "waiting": events not played yet, "stray": true for a move
 or an up with no finger down, "failed": what XCTest said of an earlier live record that failed (the server then
 stops using live touch on this phone)}.
 */
+ (id<FBResponsePayload>)handleLotusTouch:(FBRouteRequest *)request
{
  id phaseArg = request.arguments[@"phase"];
  NSString *phase = [phaseArg isKindOfClass:NSString.class] ? (NSString *)phaseArg : @"";
  if (![phase isEqualToString:@"down"] && ![phase isEqualToString:@"move"] && ![phase isEqualToString:@"up"]) {
    return [self lotus_invalid:@"'phase' must be down, move or up"];
  }
  if (![request.arguments[@"x"] isKindOfClass:NSNumber.class] || ![request.arguments[@"y"] isKindOfClass:NSNumber.class]) {
    return [self lotus_invalid:@"'x' and 'y' must be numbers"];
  }
  CGPoint point = CGPointMake(((NSNumber *)request.arguments[@"x"]).doubleValue, ((NSNumber *)request.arguments[@"y"]).doubleValue);
  NSInteger mode = (NSInteger)[self lotus_number:request.arguments[@"mode"] fallback:1 low:1 high:3];
  long long orientation = [self lotus_orientation:request.arguments[@"orientation"]];
  if (LotusLiveOps.count >= LotusMostWaiting) {
    return FBResponseWithStatus([FBCommandStatus unknownErrorWithMessage:@"Too many touches are waiting on the phone"
                                                               traceback:nil]);
  }
  LotusLiveHeardAt = CFAbsoluteTimeGetCurrent();
  NSString *error = LotusLiveError;
  LotusLiveError = nil;
  BOOL stray = NO;
  if ([phase isEqualToString:@"down"]) {
    // a new press lifts a finger still down
    if (LotusLiveQueuedDown) {
      [self lotus_queueLive:@"up" at:LotusLiveQueuedPoint mode:LotusLiveMode orientation:LotusLiveOrientation];
    }
    [self lotus_queueLive:@"down" at:point mode:mode orientation:orientation];
    [self lotus_watchLive];
  } else if (!LotusLiveQueuedDown) {
    stray = YES;
  } else {
    [self lotus_queueLive:phase at:point mode:LotusLiveMode orientation:LotusLiveOrientation];
  }
  [self lotus_pump];
  NSMutableDictionary *answer = [NSMutableDictionary dictionary];
  answer[@"lotus"] = @(LotusForkVersion);
  answer[@"down"] = @(LotusLiveQueuedDown);
  answer[@"waiting"] = @(LotusLiveOps.count + (LotusSynthBusy ? (NSUInteger)1 : (NSUInteger)0));
  if (stray) {
    answer[@"stray"] = @YES;
  }
  if (nil != error) {
    answer[@"failed"] = error;
  }
  return FBResponseWithObject(answer);
}

#pragma mark - Self-test

/** YES when `text` holds only characters of `allowed`. */
+ (BOOL)lotus_text:(NSString *)text only:(NSString *)allowed
{
  NSCharacterSet *others = [[NSCharacterSet characterSetWithCharactersInString:allowed] invertedSet];
  return [text rangeOfCharacterFromSet:others].location == NSNotFound;
}

/** One record to XCTest, waited for; what it said when it failed. */
+ (NSString *)lotus_play:(XCSynthesizedEventRecord *)record
{
  NSError *error = nil;
  if ([FBXCTestDaemonsProxy synthesizeEventWithRecord:record error:&error]) {
    return nil;
  }
  return error.localizedDescription ?: @"XCTest refused the record";
}

/**
 v3: the touches in what the probe saw, one by one: a touch is "B", then only "M", then "E". `complete` counts those,
 `moved` the complete ones with at least one "M"; anything else (a "B" while a touch is open, a "C", an "M" or "E" with
 no touch open, a touch never ended) counts in `broken`. 'BMMEBMME' is 2 complete, 2 moved, 0 broken; 'BMMMMMMMME' is
 1 complete. The Mac's server counts the same way from `seen` (src/fork.ts countTouches) and has the last word.
 */
+ (void)lotus_count:(NSString *)seen complete:(NSUInteger *)complete moved:(NSUInteger *)moved broken:(NSUInteger *)broken
{
  NSUInteger c = 0, m = 0, b = 0, moves = 0;
  BOOL open = NO;
  for (NSUInteger i = 0; i < seen.length; i++) {
    unichar ch = [seen characterAtIndex:i];
    if (ch == 'B') {
      if (open) {
        b++;
      }
      open = YES;
      moves = 0;
    } else if (ch == 'M') {
      if (open) {
        moves++;
      } else {
        b++;
      }
    } else if (ch == 'E') {
      if (open) {
        c++;
        if (moves > 0) {
          m++;
        }
      } else {
        b++;
      }
      open = NO;
    } else {
      // "C" (cancelled) or anything unknown
      b++;
      open = NO;
    }
  }
  if (open) {
    b++;
  }
  *complete = c;
  *moved = m;
  *broken = b;
}

/** v3: one segment as the Mac's server sends it: its own new record and path (offset 0), moving 80 ms, still 30 ms, lifting. */
+ (XCSynthesizedEventRecord *)lotus_segmentFrom:(CGPoint)from to:(CGPoint)to orientation:(long long)orientation
{
  XCPointerEventPath *path = [[XCPointerEventPath alloc] initForTouchAtPoint:from offset:0];
  [path moveToPoint:to atOffset:0.08];
  [path liftUpAtOffset:0.11];
  XCSynthesizedEventRecord *record = [[XCSynthesizedEventRecord alloc] initWithName:@"Lotus self-test segment" interfaceOrientation:orientation];
  [record addPointerEventPath:path];
  return record;
}

/** Why a held-finger mode's run didn't give one clean touch, in words (for /api/wda and the control app status). */
+ (NSString *)lotus_whyDown:(NSString *)afterDown move:(NSString *)afterMove up:(NSString *)afterUp travelled:(double)travelled
{
  if (0 == afterUp.length) {
    return @"no touch reached the test window (is the phone awake and unlocked?)";
  }
  if ([afterDown rangeOfString:@"E"].location != NSNotFound || [afterDown rangeOfString:@"C"].location != NSNotFound) {
    return [NSString stringWithFormat:@"the press was lifted when its record ended ('%@'): XCTest ends every finger with its record", afterDown];
  }
  if (![afterDown isEqualToString:@"B"]) {
    return [NSString stringWithFormat:@"the press gave '%@', not one begin", afterDown];
  }
  if (afterMove.length > 1 && [[afterMove substringFromIndex:1] rangeOfString:@"B"].location != NSNotFound) {
    return [NSString stringWithFormat:@"the move began a new touch ('%@'): the contact did not survive between records", afterMove];
  }
  if (travelled < 30.0) {
    return [NSString stringWithFormat:@"the touch moved only %.0f pt of 60 ('%@')", travelled, afterMove];
  }
  return [NSString stringWithFormat:@"the lift gave '%@'", afterUp];
}

/**
 POST /lotus/selftest: which mode of live touch works on this phone. The WebDriverAgent app comes to the front, puts
 a window of its own over the screen and touches it, watching what the window receives.
   modes 1-3 (a held finger): press, move, lift as three records. Works when the window sees ONE touch: it begins
     once, moves without ending, and ends once at the lift.
   mode 4 (segmented, v2, 2026-11-17): two short whole gestures one after the other, each press -> move -> a still
     moment -> lift, the second starting where the first ended (what the Mac's server sends through /lotus/gesture as
     a finger moves when no finger can be held). Works when the window sees two complete touches that moved.
   mode 5 (v3): as 4 with a pause between the two (40, 100 then 200 ms; the first that works is said as `gapMs`).
 The answer is the first of 1-5 that works, else 0. Every run's result is said (`modes`, with `seen` and `gapMs` for
 4 and 5); the Mac's server recounts `seen` itself and picks the mode (and gap) it uses.
 The Mac's server wakes and unlocks the phone before it asks (v1 also ran on a locked phone, which saw nothing).
 Nothing else on the phone is touched; afterwards the phone goes back to its Home Screen ({"home": false} leaves the
 app in front).
 -> {"tested": true, "mode": 0-5, "modes": [{"mode", "works", "why", "seen"?, "gapMs"?}], "notes": [...]}
 -> {"tested": false, "why": "..."} when the app couldn't come to the front (a locked or dark phone): try later.
 TO VERIFY ON THE MAC (v3): it compiles; GET /api/wda shows fork.perDevice.<udid>.live.mode 4 on iPhone-2 (as with
 v2) and 5 with a gapMs on iPhone-1, each run's "seen"; a drag on the Phones page moves while the pointer moves.
 */
+ (id<FBResponsePayload>)handleLotusSelfTest:(FBRouteRequest *)request
{
  if (LotusSynthBusy || LotusLiveQueuedDown || LotusLiveOps.count > 0 || LotusGestureQueue.count > 0) {
    return FBResponseWithObject(@{@"lotus": @(LotusForkVersion), @"tested": @NO, @"mode": @0, @"why": @"a touch is being played"});
  }
  UIApplication *app = UIApplication.sharedApplication;
  if (app.applicationState != UIApplicationStateActive) {
    NSString *bundleId = NSBundle.mainBundle.bundleIdentifier;
    if (nil != bundleId) {
      [FBUnattachedAppLauncher launchAppWithBundleId:bundleId];
    }
    for (int i = 0; i < 40 && app.applicationState != UIApplicationStateActive; i++) {
      [self lotus_spin:0.1];
    }
  }
  if (app.applicationState != UIApplicationStateActive) {
    return FBResponseWithObject(@{@"lotus": @(LotusForkVersion), @"tested": @NO, @"mode": @0,
                                  @"why": @"the WebDriverAgent app could not come to the front (the screen may be off or locked)"});
  }
  UIWindowScene *scene = nil;
  for (UIScene *candidate in app.connectedScenes) {
    if (![candidate isKindOfClass:UIWindowScene.class]) {
      continue;
    }
    if (nil == scene || candidate.activationState == UISceneActivationStateForegroundActive) {
      scene = (UIWindowScene *)candidate;
    }
  }
  if (nil == scene) {
    return FBResponseWithObject(@{@"lotus": @(LotusForkVersion), @"tested": @NO, @"mode": @0,
                                  @"why": @"the WebDriverAgent app has no window scene"});
  }
  UIWindow *window = [[UIWindow alloc] initWithWindowScene:scene];
  window.frame = scene.coordinateSpace.bounds;
  LotusProbeView *probe = [[LotusProbeView alloc] initWithFrame:window.bounds];
  probe.seen = [NSMutableString string];
  probe.backgroundColor = UIColor.blackColor;
  probe.multipleTouchEnabled = YES;
  UIViewController *controller = [[UIViewController alloc] init];
  controller.view = probe;
  window.rootViewController = controller;
  window.windowLevel = UIWindowLevelAlert + 100;
  window.hidden = NO;
  [self lotus_spin:0.5];

  CGSize size = window.bounds.size;
  CGPoint a = CGPointMake(floor(size.width / 2.0), floor(size.height / 2.0));
  CGPoint b = CGPointMake(a.x, a.y + 60.0);
  CGPoint c = CGPointMake(a.x, a.y + 120.0);
  long long orientation = (long long)scene.interfaceOrientation;
  if (orientation < (long long)UIInterfaceOrientationPortrait || orientation > (long long)UIInterfaceOrientationLandscapeLeft) {
    orientation = (long long)UIInterfaceOrientationPortrait;
  }
  NSMutableArray<NSString *> *notes = [NSMutableArray array];
  NSMutableArray<NSDictionary *> *modes = [NSMutableArray array];
  NSInteger found = 0;
  // 1-3: a held finger. Each is tried even after one works, so every mode's result is said.
  for (NSInteger mode = 1; mode <= 3; mode++) {
    [probe.seen setString:@""];
    NSString *e1 = [self lotus_play:[self lotus_recordFrom:a to:a seconds:0 lift:NO begins:(mode >= 2) ends:NO orientation:orientation]];
    [self lotus_spin:0.35];
    NSString *afterDown = [probe.seen copy];
    NSString *e2 = [self lotus_play:[self lotus_recordFrom:a to:b seconds:0.05 lift:NO begins:(mode == 3) ends:NO orientation:orientation]];
    [self lotus_spin:0.35];
    NSString *afterMove = [probe.seen copy];
    double travelled = hypot(probe.lastAt.x - probe.beganAt.x, probe.lastAt.y - probe.beganAt.y);
    NSString *e3 = [self lotus_play:[self lotus_recordFrom:b to:b seconds:0 lift:YES begins:NO ends:(mode >= 2) orientation:orientation]];
    [self lotus_spin:0.35];
    NSString *afterUp = [probe.seen copy];
    // one touch from the press to the lift: "B", then "B" and moves only, then the same with one "E" at the end
    BOOL pressed = [afterDown isEqualToString:@"B"];
    BOOL dragged = afterMove.length > 1 && [afterMove hasPrefix:@"B"] && [self lotus_text:[afterMove substringFromIndex:1] only:@"M"] && travelled >= 30.0;
    BOOL lifted = afterUp.length > afterMove.length && [afterUp hasPrefix:afterMove] && [afterUp hasSuffix:@"E"]
      && [self lotus_text:[afterUp substringWithRange:NSMakeRange(afterMove.length, afterUp.length - afterMove.length - 1)] only:@"M"];
    BOOL good = nil == e1 && nil == e2 && nil == e3 && pressed && dragged && lifted;
    NSString *why = nil;
    if (!good) {
      if (nil != e1) {
        why = [@"XCTest refused the press: " stringByAppendingString:e1];
      } else if (nil != e2) {
        why = [@"XCTest refused the move: " stringByAppendingString:e2];
      } else if (nil != e3) {
        why = [@"XCTest refused the lift: " stringByAppendingString:e3];
      } else {
        why = [self lotus_whyDown:afterDown move:afterMove up:afterUp travelled:travelled];
      }
    }
    [modes addObject:@{@"mode": @(mode), @"works": @(good), @"why": (nil != why ? why : (id)[NSNull null])}];
    [notes addObject:[NSString stringWithFormat:@"mode %ld: press '%@' move '%@' (%.0f pt) lift '%@' -> %@", (long)mode,
                      afterDown, afterMove, travelled, afterUp, good ? @"works" : why]];
    if (good && 0 == found) {
      found = mode;
    }
    if (!good) {
      // whatever this mode left behind, no finger of ours stays down for the next one
      [self lotus_play:[self lotus_recordFrom:b to:b seconds:0 lift:YES begins:NO ends:YES orientation:orientation]];
      [self lotus_spin:0.3];
    }
  }
  // 4: segmented, and v3's 5: segmented with a gap. Two whole gestures a -> b then b -> c, each a new record with its
  // own path, played one after the other and each waited for (XCTest's completion) as the phone's queue does. Mode 4
  // sends the second at once; mode 5 waits `gap` ms between them (the first gap of 40, 100, 200 that works). iOS
  // 18.5 (iPhone-1, v2) showed one touch of one segment's length ('BMMMMMMMME', 48 pt, 811 ms for both): one of the
  // two back-to-back segments never reached the window. Each segment's own letters and time are in the notes.
  NSArray<NSNumber *> *gaps = @[@0, @40, @100, @200];
  BOOL gappedDone = NO;
  for (NSNumber *gapMs in gaps) {
    NSInteger mode = gapMs.integerValue > 0 ? 5 : 4;
    if (mode == 5 && gappedDone) {
      break;
    }
    [probe.seen setString:@""];
    CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent();
    NSString *e1 = [self lotus_play:[self lotus_segmentFrom:a to:b orientation:orientation]];
    double ms1 = (CFAbsoluteTimeGetCurrent() - t0) * 1000.0;
    NSString *seen1 = [probe.seen copy];
    if (gapMs.integerValue > 0) {
      [self lotus_spin:gapMs.doubleValue / 1000.0];
    }
    CFAbsoluteTime t1 = CFAbsoluteTimeGetCurrent();
    NSString *e2 = [self lotus_play:[self lotus_segmentFrom:b to:c orientation:orientation]];
    double ms2 = (CFAbsoluteTimeGetCurrent() - t1) * 1000.0;
    [self lotus_spin:0.35];
    NSString *seen = [probe.seen copy];
    // the last touch began at b: it travelled about 60 pt (less a frame)
    double travelled = hypot(probe.lastAt.x - probe.beganAt.x, probe.lastAt.y - probe.beganAt.y);
    NSUInteger complete = 0, moved = 0, broken = 0;
    [self lotus_count:seen complete:&complete moved:&moved broken:&broken];
    BOOL good = nil == e1 && nil == e2 && 2 == complete && 2 == moved && 0 == broken && travelled >= 30.0;
    NSString *why = nil;
    if (!good) {
      if (nil != e1) {
        why = [@"XCTest refused the first segment: " stringByAppendingString:e1];
      } else if (nil != e2) {
        why = [@"XCTest refused the second segment: " stringByAppendingString:e2];
      } else if (0 == seen.length) {
        why = @"no touch reached the test window (is the phone awake and unlocked?)";
      } else {
        why = [NSString stringWithFormat:@"the two segments gave '%@' (%lu complete, %lu broken, %.0f pt)", seen,
               (unsigned long)complete, (unsigned long)broken, travelled];
      }
    }
    [modes addObject:@{@"mode": @(mode), @"works": @(good), @"why": (nil != why ? why : (id)[NSNull null]),
                       @"seen": seen, @"gapMs": gapMs}];
    [notes addObject:[NSString stringWithFormat:@"mode %ld (segmented, gap %ld ms): first '%@' in %.0f ms, both '%@' (second in %.0f ms, %.0f pt) -> %@",
                      (long)mode, (long)gapMs.integerValue, seen1, ms1, seen, ms2, travelled, good ? @"works" : why]];
    if (good && 0 == found) {
      found = mode;
    }
    if (good && mode == 5) {
      gappedDone = YES;
    }
    // what a failed run left behind settles before the next one
    [self lotus_spin:0.3];
  }
  window.hidden = YES;
  window.rootViewController = nil;
  window = nil;
  id homeArg = request.arguments[@"home"];
  if (![homeArg isKindOfClass:NSNumber.class] || ((NSNumber *)homeArg).boolValue) {
    [[XCUIDevice sharedDevice] fb_goToHomescreenWithError:NULL];
  }
  [FBLogger logFmt:@"Lotus: live touch self-test: mode %ld (%@)", (long)found, [notes componentsJoinedByString:@"; "]];
  return FBResponseWithObject(@{@"lotus": @(LotusForkVersion), @"tested": @YES, @"mode": @(found), @"modes": modes, @"notes": notes});
}

#pragma mark - Info and stills

/** GET /lotus/info: answers at once whatever else the phone is doing (it's off the main queue). */
+ (id<FBResponsePayload>)handleLotusInfo:(FBRouteRequest *)request
{
  return FBResponseWithObject(@{
    @"lotus": @(LotusForkVersion),
    @"upstream": LotusUpstreamTag,
    @"mjpeg": @NO,
    @"built": [NSString stringWithFormat:@"%s %s", __DATE__, __TIME__],
    @"touchDown": @(LotusLiveQueuedDown),
  });
}

/**
 GET /lotus/shot?scale=1-100&quality=1-100: one still of the screen as a JPEG (what the Mac's server and Lotus's
 phone agent look at: this build has no MJPEG stream). Off the main queue, like WDA's own /screenshot.
 */
+ (id<FBResponsePayload>)handleLotusShot:(FBRouteRequest *)request
{
  double scale = [self lotus_number:request.parameters[@"scale"] fallback:100 low:5 high:100] / 100.0;
  double quality = [self lotus_number:request.parameters[@"quality"] fallback:60 low:1 high:100] / 100.0;
  NSError *error = nil;
  XCUIScreen *screen = [FBScreen currentScreenWithError:&error];
  if (nil == screen) {
    return FBResponseWithStatus([FBCommandStatus unableToCaptureScreenErrorWithMessage:error.description traceback:nil]);
  }
  NSData *shot = [FBScreenshot takeInOriginalResolutionWithScreenID:screen.displayID
                                                 compressionQuality:quality
                                                                uti:UTTypeJPEG
                                                            timeout:8.0
                                                              error:&error];
  if (nil == shot) {
    return FBResponseWithStatus([FBCommandStatus unableToCaptureScreenErrorWithMessage:error.description traceback:nil]);
  }
  if (scale < 0.999) {
    NSData *smaller = [[[FBImageProcessor alloc] init] scaledImageWithData:shot
                                                                       uti:UTTypeJPEG
                                                             scalingFactor:scale
                                                        compressionQuality:quality
                                                                     error:NULL];
    if (nil != smaller) {
      shot = smaller;
    }
  }
  return FBResponseWithObject(@{
    @"lotus": @(LotusForkVersion),
    @"jpeg": [shot base64EncodedStringWithOptions:(NSDataBase64EncodingOptions)0],
  });
}

@end

#pragma clang diagnostic pop

#endif
