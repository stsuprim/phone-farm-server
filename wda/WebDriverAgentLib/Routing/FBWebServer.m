/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBWebServer.h"

#import "FBHTTPServer.h"
// LOTUS: no MJPEG server in this build (FBMjpegServer is gone from the project): the live picture is the Mac's
// USB capture and stills come from GET /lotus/shot, so nothing ever listens on the MJPEG port (9100).

#import "FBCommandHandler.h"
#import "FBCommandStatus.h"
#import "FBErrorBuilder.h"
#import "FBExceptionHandler.h"
#import "FBResponsePayload.h"
#import "FBRouteRequest.h"
#import "FBRuntimeUtils.h"
#import "FBSession.h"
#import "FBUnknownCommands.h"
#import "FBConfiguration.h"
#import "FBLogger.h"

#import "XCUIDevice+FBHelpers.h"

static NSString *const FBServerURLBeginMarker = @"ServerURLHere->";
static NSString *const FBServerURLEndMarker = @"<-ServerURLHere";

@interface FBWebServer ()
@property (nonatomic, strong) FBExceptionHandler *exceptionHandler;
@property (nonatomic, strong) FBHTTPServer *server;
@property (atomic, assign) BOOL keepAlive;
@end

@implementation FBWebServer

+ (NSArray<Class<FBCommandHandler>> *)collectCommandHandlerClasses
{
  NSArray *handlersClasses = FBClassesThatConformsToProtocol(@protocol(FBCommandHandler));
  NSMutableArray *handlers = [NSMutableArray array];
  for (Class aClass in handlersClasses) {
    if ([aClass respondsToSelector:@selector(shouldRegisterAutomatically)]) {
      if (![aClass shouldRegisterAutomatically]) {
        continue;
      }
    }
    [handlers addObject:aClass];
  }
  return handlers.copy;
}

- (void)startServing
{
  [FBLogger logFmt:@"Built at %s %s", __DATE__, __TIME__];
  self.exceptionHandler = [FBExceptionHandler new];
  if (![self startHTTPServer]) {
    return;
  }
  self.keepAlive = YES;
  NSRunLoop *runLoop = [NSRunLoop mainRunLoop];
  while (self.keepAlive &&
         [runLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate distantFuture]]);
}

- (BOOL)startHTTPServer
{
  self.server = [[FBHTTPServer alloc] init];
  [self.server setRouteQueue:dispatch_get_main_queue()];
  [self.server setDefaultHeader:@"Server" value:@"WebDriverAgent/1.0"];
  [self.server setDefaultHeader:@"Access-Control-Allow-Origin" value:@"*"];
  [self.server setDefaultHeader:@"Access-Control-Allow-Headers" value:@"Content-Type, X-Requested-With"];

  [NSNotificationCenter.defaultCenter addObserver:self
                                          selector:@selector(sessionWasKilled:)
                                              name:FBSessionWasKilledNotification
                                            object:nil];

  [self registerRouteHandlers:[self.class collectCommandHandlerClasses]];
  [self registerServerKeyRouteHandlers];

  NSRange serverPortRange = FBConfiguration.sharedInstance.bindingPortRange;
  NSString *bindingIP = FBConfiguration.sharedInstance.bindingIPAddress;
  if (bindingIP != nil) {
    [self.server setInterface:bindingIP];
    [FBLogger logFmt:@"Using custom binding IP address: %@", bindingIP];
  }

  NSError *error;
  BOOL serverStarted = NO;

  for (NSUInteger index = 0; index < serverPortRange.length; index++) {
    NSInteger port = serverPortRange.location + index;
    [self.server setPort:(UInt16)port];

    serverStarted = [self attemptToStartServer:self.server onPort:port withError:&error];
    if (serverStarted) {
      break;
    }

    [FBLogger logFmt:@"Failed to start web server on port %ld with error %@", (long)port, [error description]];
  }

  if (!serverStarted) {
    [FBLogger logFmt:@"Last attempt to start web server failed with error %@", [error description]];
    id<FBWebServerDelegate> delegate = self.delegate;
    if ([delegate respondsToSelector:@selector(webServer:didFailToStartWithError:)]) {
      [delegate webServer:self didFailToStartWithError:(NSError * _Nonnull)error];
      return NO;
    }
    abort();
  }

  NSString *serverHost = bindingIP ?: ([XCUIDevice sharedDevice].fb_wifiIPAddress ?: @"127.0.0.1");
  [FBLogger logFmt:@"%@http://%@:%d%@", FBServerURLBeginMarker, serverHost, [self.server port], FBServerURLEndMarker];
  return YES;
}

- (void)sessionWasKilled:(NSNotification *)notification
{
  FBSession *session = notification.object;
  if (![session isKindOfClass:FBSession.class]) {
    return;
  }
  // Same "invalid session id" shape a still-queued request would eventually get anyway, once
  // -routeQueue drains and FBRoute.decorateRequest: finds the session gone - just delivered now
  // instead of after however long the request would otherwise have been stuck waiting.
  NSString *message = [NSString stringWithFormat:@"Session %@ was deleted while this request was still pending", session.identifier];
  id<FBResponsePayload> payload = FBResponseWithStatus([FBCommandStatus noSuchDriverErrorWithMessage:message
                                                                                            traceback:nil]);
  RouteResponse *response = [RouteResponse new];
  [payload dispatchWithResponse:response];
  [self.server abandonPendingRequestsForSessionID:session.identifier withResponse:response];
}

- (void)stopServing
{
  [NSNotificationCenter.defaultCenter removeObserver:self name:FBSessionWasKilledNotification object:nil];
  [FBSession.activeSession kill];
  if (self.server.isRunning) {
    [self.server stop:NO];
  }
  self.server = nil;
  self.exceptionHandler = nil;
  self.keepAlive = NO;
}

- (BOOL)attemptToStartServer:(FBHTTPServer *)server onPort:(NSInteger)port withError:(NSError **)error
{
  server.port = (UInt16)port;
  NSError *innerError = nil;
  BOOL started = [server start:&innerError];
  if (!started) {
    if (!error) {
      return NO;
    }

    NSString *description = @"Unknown Error when Starting server";
    if ([innerError.domain isEqualToString:NSPOSIXErrorDomain] && innerError.code == EADDRINUSE) {
      description = [NSString stringWithFormat:@"Unable to start web server on port %ld", (long)port];
    }
    return
    [[[[FBErrorBuilder builder]
       withDescription:description]
      withInnerError:innerError]
     buildError:error];
  }
  return YES;
}

- (void)registerRouteHandlers:(NSArray *)commandHandlerClasses
{
  __weak typeof(self) weakSelf = self;
  for (Class<FBCommandHandler> commandHandler in commandHandlerClasses) {
    NSArray *routes = [commandHandler routes];
    for (FBRoute *route in routes) {
      [self.server handleMethod:route.verb withPath:route.path standalone:route.isStandalone block:^(RouteRequest *request, RouteResponse *response) {
        __strong typeof(weakSelf) strongSelf = weakSelf;
        if (nil == strongSelf) {
          return;
        }
        // >>> LOTUS: a piece of a file comes as raw bytes, and nothing about a file (its name) is ever logged
        BOOL isLotusFile = [route.path hasPrefix:@"/lotus/files/"];
        NSDictionary *arguments = nil;
        if ([route.path isEqualToString:@"/lotus/files/put"]) {
          arguments = @{@"lotusBody": request.body ?: [NSData data]};
        } else {
          arguments = [NSJSONSerialization JSONObjectWithData:request.body options:NSJSONReadingMutableContainers error:NULL];
        }
        // <<< LOTUS
        FBRouteRequest *routeParams = [FBRouteRequest
          routeRequestWithURL:request.url
          parameters:request.params
          arguments:arguments ?: @{}
        ];

        if (!isLotusFile) { // LOTUS
          [FBLogger verboseLog:routeParams.description];
        }

        @try {
          [route mountRequest:routeParams intoResponse:response];
        }
        @catch (NSException *exception) {
          [strongSelf handleException:exception forResponse:response];
        }
      }];
    }
  }
}

- (void)handleException:(NSException *)exception forResponse:(RouteResponse *)response
{
  [self.exceptionHandler handleException:exception forResponse:response];
}

- (void)registerServerKeyRouteHandlers
{
  [self.server handleMethod:@"GET" withPath:@"/health" standalone:YES block:^(RouteRequest *request, RouteResponse *response) {
    [response respondWithString:@"<!DOCTYPE html><html><title>Health Check</title><body><p>I-AM-ALIVE</p></body></html>"];
  }];

  // Deprecated: no longer needed since appium-xcuitest-driver handles calibration
  // itself (https://github.com/appium/appium-xcuitest-driver/pull/2948). Kept for
  // backward compatibility; will be removed in a future major release.
  NSString *calibrationPage = @"<html>"
  "<title>{\"x\":null,\"y\":null}</title>"
  "<header>"
  "<script>document.addEventListener(\"click\",function(e){document.title=JSON.stringify({x:e.clientX,y:e.clientY})})</script>"
  "</header>"
  "</html>";
  [self.server get:@"/calibrate" withBlock:^(RouteRequest *request, RouteResponse *response) {
    [FBLogger logFmt:@"The /calibrate endpoint is deprecated and will be removed in a future release"];
    [response respondWithString:calibrationPage];
  }];

  __weak typeof(self) weakSelf = self;
  [self.server get:@"/wda/shutdown" withBlock:^(RouteRequest *request, RouteResponse *response) {
    __strong typeof(weakSelf) strongSelf = weakSelf;
    if (nil == strongSelf) {
      return;
    }
    [response respondWithString:@"Shutting down"];
    // Deferred so the "Shutting down" response is written to the client before
    // webServerDidRequestShutdown: tears down the server's socket out from under it.
    dispatch_async(dispatch_get_main_queue(), ^{
      [strongSelf.delegate webServerDidRequestShutdown:strongSelf];
    });
  }];

  [self registerRouteHandlers:@[FBUnknownCommands.class]];
}

@end
