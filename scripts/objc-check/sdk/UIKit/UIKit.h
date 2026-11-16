// A small stand-in for UIKit (see Foundation/Foundation.h here). Not the real header.
#ifndef FAKE_UIKIT_H
#define FAKE_UIKIT_H
#import <Foundation/Foundation.h>
typedef NS_ENUM(NSInteger, UIInterfaceOrientation) { UIInterfaceOrientationUnknown = 0, UIInterfaceOrientationPortrait = 1, UIInterfaceOrientationPortraitUpsideDown = 2, UIInterfaceOrientationLandscapeRight = 3, UIInterfaceOrientationLandscapeLeft = 4 };
typedef NS_ENUM(NSInteger, UIApplicationState) { UIApplicationStateActive, UIApplicationStateInactive, UIApplicationStateBackground };
typedef NS_ENUM(NSInteger, UISceneActivationState) { UISceneActivationStateUnattached = -1, UISceneActivationStateForegroundActive, UISceneActivationStateForegroundInactive, UISceneActivationStateBackground };
typedef CGFloat UIWindowLevel;
extern const UIWindowLevel UIWindowLevelAlert;
@interface UIColor : NSObject
@property (class, nonatomic, readonly) UIColor *blackColor;
@end
@interface UIResponder : NSObject
@end
@class UIView, UIEvent, UIWindowScene, UIViewController;
@interface UITouch : NSObject
- (CGPoint)locationInView:(UIView *)view;
@end
@interface UIEvent : NSObject
@end
@interface UIView : UIResponder
- (instancetype)initWithFrame:(CGRect)frame;
@property (nonatomic) CGRect frame;
@property (nonatomic) CGRect bounds;
@property (nonatomic, getter=isHidden) BOOL hidden;
@property (nonatomic, copy) UIColor *backgroundColor;
@property (nonatomic, getter=isMultipleTouchEnabled) BOOL multipleTouchEnabled;
- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event;
- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event;
- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event;
- (void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event;
@end
@interface UIViewController : UIResponder
@property (nonatomic, strong) UIView *view;
@end
@interface UIWindow : UIView
- (instancetype)initWithWindowScene:(UIWindowScene *)windowScene;
@property (nonatomic, strong) UIViewController *rootViewController;
@property (nonatomic) UIWindowLevel windowLevel;
@end
@protocol UICoordinateSpace
@property (readonly, nonatomic) CGRect bounds;
@end
@interface UIScene : UIResponder
@property (nonatomic, readonly) UISceneActivationState activationState;
@end
@interface UIWindowScene : UIScene
@property (nonatomic, readonly) UIInterfaceOrientation interfaceOrientation;
@property (nonatomic, readonly) id<UICoordinateSpace> coordinateSpace;
@end
@interface UIApplication : UIResponder
@property (class, nonatomic, readonly) UIApplication *sharedApplication;
@property (nonatomic, readonly) UIApplicationState applicationState;
@property (nonatomic, readonly) NSSet<UIScene *> *connectedScenes;
@end
#endif
