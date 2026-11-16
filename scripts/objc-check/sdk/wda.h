// What the Lotus changes use of WebDriverAgent and XCTest, declared as the vendored headers declare it (copied by
// hand from wda/: FBRoute.h, FBRouteRequest.h, FBResponsePayload.h, FBCommandStatus.h, FBCommandHandler.h,
// FBScreenshot.h, FBImageProcessor.h, FBScreen.h, FBLogger.h, FBUnattachedAppLauncher.h, FBXCTestDaemonsProxy.h,
// XCUIDevice+FBHelpers.h and PrivateHeaders/XCTest). Only for the syntax check on a PC.
#ifndef FAKE_WDA_H
#define FAKE_WDA_H
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

@class RouteResponse;
@protocol FBResponsePayload <NSObject>
- (void)dispatchWithResponse:(RouteResponse *)response;
@end
@interface FBCommandStatus : NSObject
+ (instancetype)unknownErrorWithMessage:(nullable NSString *)message traceback:(nullable NSString *)traceback;
+ (instancetype)invalidArgumentErrorWithMessage:(nullable NSString *)message traceback:(nullable NSString *)traceback;
+ (instancetype)unableToCaptureScreenErrorWithMessage:(nullable NSString *)message traceback:(nullable NSString *)traceback;
+ (instancetype)unknownCommandErrorWithMessage:(nullable NSString *)message traceback:(nullable NSString *)traceback;
+ (instancetype)noSuchDriverErrorWithMessage:(nullable NSString *)message traceback:(nullable NSString *)traceback;
@end
id<FBResponsePayload> FBResponseWithOK(void);
id<FBResponsePayload> FBResponseWithObject(id _Nullable object);
id<FBResponsePayload> FBResponseWithStatus(FBCommandStatus *status);

@interface FBRouteRequest : NSObject
@property (nonatomic, copy, readonly) NSDictionary *parameters;
@property (nonatomic, copy, readonly) NSDictionary *arguments;
@end
typedef id<FBResponsePayload> (^FBRouteSyncHandler)(FBRouteRequest *request);
@interface FBRoute : NSObject
+ (instancetype)GET:(NSString *)pathPattern;
+ (instancetype)POST:(NSString *)pathPattern;
- (instancetype)respondWithTarget:(id)target action:(SEL)selector;
- (instancetype)withoutSession;
- (instancetype)standalone;
@end
@protocol FBCommandHandler <NSObject>
+ (NSArray *)routes;
@end

@interface FBLogger : NSObject
+ (void)log:(NSString *)message;
+ (void)logFmt:(NSString *)format, ...;
@end

@interface XCUIScreen : NSObject
@property (readonly) long long displayID;
@end
@interface FBScreen : NSObject
+ (nullable XCUIScreen *)currentScreenWithError:(NSError **)error;
@end
@interface FBScreenshot : NSObject
+ (nullable NSData *)takeInOriginalResolutionWithScreenID:(long long)screenID
                                       compressionQuality:(CGFloat)compressionQuality
                                                      uti:(UTType *)uti
                                                  timeout:(NSTimeInterval)timeout
                                                    error:(NSError **)error;
@end
@interface FBImageProcessor : NSObject
- (nullable NSData *)scaledImageWithData:(NSData *)image
                                     uti:(UTType *)uti
                           scalingFactor:(CGFloat)scalingFactor
                      compressionQuality:(CGFloat)compressionQuality
                                   error:(NSError **)error;
@end
@interface FBUnattachedAppLauncher : NSObject
+ (BOOL)launchAppWithBundleId:(NSString *)bundleId;
@end

@interface XCPointerEventPath : NSObject
- (id)initForTouchAtPoint:(CGPoint)point offset:(double)offset;
- (void)moveToPoint:(CGPoint)point atOffset:(double)offset;
- (void)liftUpAtOffset:(double)offset;
@end
@interface XCSynthesizedEventRecord : NSObject
@property (readonly) double maximumOffset;
@property _Bool beginsPersistentState;
@property _Bool endsPersistentState;
- (id)initWithName:(id)name interfaceOrientation:(long long)orientation;
- (void)addPointerEventPath:(id)path;
@end
@protocol XCUIEventSynthesizing <NSObject>
- (void)synthesizeEvent:(id)event completion:(void (^)(_Bool success, NSError *error))completion;
@end
@interface XCUIDevice : NSObject
@property (class, readonly) XCUIDevice *sharedDevice;
- (id<XCUIEventSynthesizing>)eventSynthesizer;
- (BOOL)fb_goToHomescreenWithError:(NSError **)error;
@end
@interface FBXCTestDaemonsProxy : NSObject
+ (BOOL)synthesizeEventWithRecord:(XCSynthesizedEventRecord *)record error:(NSError *__autoreleasing *)error;
@end
#endif
