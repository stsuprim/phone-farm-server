// A small stand-in for Foundation, for syntax and type checks on a PC without the iOS SDK. Not the real header.
#ifndef FAKE_FOUNDATION_H
#define FAKE_FOUNDATION_H
#include <TargetConditionals.h>
#include <stdint.h>
#include <stddef.h>
#include <math.h>
#define NS_ASSUME_NONNULL_BEGIN _Pragma("clang assume_nonnull begin")
#define NS_ASSUME_NONNULL_END _Pragma("clang assume_nonnull end")
#define NS_FORMAT_FUNCTION(a, b)
#define NS_ENUM(type, name) enum name : type name; enum name : type
#define NS_OPTIONS(type, name) enum name : type name; enum name : type
#define NS_DESIGNATED_INITIALIZER
#define NS_UNAVAILABLE
#define NS_SWIFT_NAME(x)
#define NS_REFINED_FOR_SWIFT
#define NS_REQUIRES_SUPER
#define FOUNDATION_EXPORT extern
#define FOUNDATION_EXTERN extern
#define UIKIT_EXTERN extern
#define API_AVAILABLE(...)
#define API_UNAVAILABLE(...)
#define __TVOS_PROHIBITED
#define __WATCHOS_PROHIBITED
#define YES ((BOOL)1)
#define NO ((BOOL)0)
#define nil ((id)0)
#define Nil ((Class)0)
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define NSEC_PER_SEC 1000000000ull
#define NSUIntegerMax UINT64_MAX
#define NSNotFound INT64_MAX
#define DISPATCH_TIME_NOW 0ull
#define DISPATCH_QUEUE_SERIAL ((id)0)
#define DISPATCH_SOURCE_TYPE_TIMER 0
#define EADDRINUSE 48
typedef signed char BOOL;
typedef long long NSInteger;
typedef unsigned long long NSUInteger;
typedef double NSTimeInterval;
typedef double CFAbsoluteTime;
typedef double CGFloat;
typedef unsigned short unichar;
typedef NSUInteger NSStringEncoding;
typedef unsigned short UInt16;
void abort(void);
typedef struct CGPoint { CGFloat x; CGFloat y; } CGPoint;
typedef struct CGSize { CGFloat width; CGFloat height; } CGSize;
typedef struct CGRect { CGPoint origin; CGSize size; } CGRect;
typedef struct CGVector { CGFloat dx; CGFloat dy; } CGVector;
typedef struct _NSRange { NSUInteger location; NSUInteger length; } NSRange;
static inline CGPoint CGPointMake(CGFloat x, CGFloat y) { CGPoint p; p.x = x; p.y = y; return p; }
static inline CGSize CGSizeMake(CGFloat w, CGFloat h) { CGSize s; s.width = w; s.height = h; return s; }
static inline NSRange NSMakeRange(NSUInteger loc, NSUInteger len) { NSRange r; r.location = loc; r.length = len; return r; }
extern const CGRect CGRectNull;
CFAbsoluteTime CFAbsoluteTimeGetCurrent(void);
typedef long dispatch_once_t;
typedef unsigned long long dispatch_time_t;
@protocol OS_dispatch_queue;
typedef id<OS_dispatch_queue> dispatch_queue_t;
@protocol OS_dispatch_source;
typedef id<OS_dispatch_source> dispatch_source_t;
void dispatch_once(dispatch_once_t *predicate, void (^block)(void));
dispatch_time_t dispatch_time(dispatch_time_t when, int64_t delta);
dispatch_queue_t dispatch_get_main_queue(void);
dispatch_queue_t dispatch_queue_create(const char *label, id attr);
void dispatch_after(dispatch_time_t when, dispatch_queue_t queue, void (^block)(void));
void dispatch_async(dispatch_queue_t queue, void (^block)(void));
dispatch_source_t dispatch_source_create(int type, unsigned long handle, unsigned long mask, dispatch_queue_t queue);
void dispatch_source_set_timer(dispatch_source_t source, dispatch_time_t start, uint64_t interval, uint64_t leeway);
void dispatch_source_set_event_handler(dispatch_source_t source, void (^handler)(void));
void dispatch_resume(id object);
void dispatch_source_cancel(dispatch_source_t source);

@class NSString, NSDictionary<KeyType, ObjectType>, NSArray<ObjectType>, NSData, NSError, NSDate, NSNumber, NSSet<ObjectType>;
@protocol NSObject
- (BOOL)isKindOfClass:(Class)aClass;
- (BOOL)respondsToSelector:(SEL)aSelector;
- (BOOL)isEqual:(id)object;
@property (readonly, copy) NSString *description;
@end
@protocol NSCopying
@end
@protocol NSSecureCoding
@end
@protocol NSFastEnumeration
- (NSUInteger)countByEnumeratingWithState:(void *)state objects:(id *)buffer count:(NSUInteger)len;
@end
__attribute__((objc_root_class))
@interface NSObject <NSObject>
+ (instancetype)alloc;
+ (instancetype)new;
- (instancetype)init;
- (id)copy;
- (id)mutableCopy;
+ (Class)class;
- (Class)class;
+ (BOOL)respondsToSelector:(SEL)aSelector;
+ (BOOL)instancesRespondToSelector:(SEL)aSelector;
@end
@interface NSString : NSObject <NSCopying>
@property (readonly) NSUInteger length;
@property (readonly) double doubleValue;
@property (readonly) float floatValue;
@property (readonly) NSInteger integerValue;
@property (readonly) BOOL boolValue;
@property (readonly, copy) NSString *uppercaseString;
@property (readonly, copy) NSString *lowercaseString;
@property (readonly) const char *UTF8String;
+ (instancetype)stringWithFormat:(NSString *)format, ...;
+ (instancetype)stringWithString:(NSString *)s;
- (BOOL)isEqualToString:(NSString *)aString;
- (BOOL)hasPrefix:(NSString *)str;
- (BOOL)hasSuffix:(NSString *)str;
- (NSString *)substringFromIndex:(NSUInteger)from;
- (NSString *)substringToIndex:(NSUInteger)to;
- (NSString *)substringWithRange:(NSRange)range;
- (NSString *)stringByAppendingString:(NSString *)aString;
- (NSData *)dataUsingEncoding:(NSUInteger)encoding;
- (unichar)characterAtIndex:(NSUInteger)index;
- (NSRange)rangeOfString:(NSString *)s;
- (NSRange)rangeOfCharacterFromSet:(id)set;
- (NSArray<NSString *> *)componentsSeparatedByString:(NSString *)sep;
- (NSString *)stringByTrimmingCharactersInSet:(id)set;
- (instancetype)initWithData:(NSData *)data encoding:(NSUInteger)encoding;
@end
@interface NSMutableString : NSString
+ (instancetype)string;
- (void)appendString:(NSString *)aString;
- (void)setString:(NSString *)aString;
- (void)replaceCharactersInRange:(NSRange)range withString:(NSString *)aString;
@end
enum { NSUTF8StringEncoding = 4 };
@interface NSCharacterSet : NSObject
+ (NSCharacterSet *)characterSetWithCharactersInString:(NSString *)aString;
@property (readonly, copy) NSCharacterSet *invertedSet;
@property (class, readonly, copy) NSCharacterSet *whitespaceCharacterSet;
@property (class, readonly, copy) NSCharacterSet *whitespaceAndNewlineCharacterSet;
@end
@interface NSNumber : NSObject
@property (readonly) double doubleValue;
@property (readonly) NSInteger integerValue;
@property (readonly) long long longLongValue;
@property (readonly) BOOL boolValue;
+ (NSNumber *)numberWithDouble:(double)v;
+ (NSNumber *)numberWithFloat:(float)v;
+ (NSNumber *)numberWithInteger:(NSInteger)v;
+ (NSNumber *)numberWithUnsignedInteger:(NSUInteger)v;
+ (NSNumber *)numberWithLong:(long)v;
+ (NSNumber *)numberWithLongLong:(long long)v;
+ (NSNumber *)numberWithUnsignedLong:(unsigned long)v;
+ (NSNumber *)numberWithUnsignedLongLong:(unsigned long long)v;
+ (NSNumber *)numberWithBool:(BOOL)v;
+ (NSNumber *)numberWithInt:(int)v;
+ (NSNumber *)numberWithUnsignedInt:(unsigned int)v;
+ (NSNumber *)numberWithChar:(char)v;
@end
typedef NSUInteger NSDataBase64EncodingOptions;
typedef NSUInteger NSDataSearchOptions;
@interface NSData : NSObject
@property (readonly) NSUInteger length;
@property (readonly) const void *bytes;
+ (instancetype)data;
- (NSString *)base64EncodedStringWithOptions:(NSDataBase64EncodingOptions)options;
- (NSData *)subdataWithRange:(NSRange)range;
- (NSRange)rangeOfData:(NSData *)d options:(NSDataSearchOptions)o range:(NSRange)r;
@end
@interface NSMutableData : NSData
- (void)appendData:(NSData *)other;
- (void)replaceBytesInRange:(NSRange)range withBytes:(const void *)bytes length:(NSUInteger)len;
@end
@interface NSArray<__covariant ObjectType> : NSObject <NSFastEnumeration>
@property (readonly) NSUInteger count;
@property (nullable, readonly) ObjectType firstObject;
@property (nullable, readonly) ObjectType lastObject;
+ (instancetype)array;
+ (instancetype)arrayWithObjects:(const ObjectType [])objects count:(NSUInteger)cnt;
- (ObjectType)objectAtIndexedSubscript:(NSUInteger)idx;
- (ObjectType)objectAtIndex:(NSUInteger)idx;
- (NSString *)componentsJoinedByString:(NSString *)separator;
- (NSArray<ObjectType> *)arrayByAddingObjectsFromArray:(NSArray<ObjectType> *)o;
@end
@interface NSMutableArray<ObjectType> : NSArray<ObjectType>
- (void)addObject:(ObjectType)anObject;
- (void)removeObjectAtIndex:(NSUInteger)index;
- (void)removeLastObject;
- (void)removeAllObjects;
- (void)setObject:(ObjectType)obj atIndexedSubscript:(NSUInteger)idx;
@end
@interface NSDictionary<__covariant KeyType, __covariant ObjectType> : NSObject <NSFastEnumeration>
@property (readonly) NSUInteger count;
+ (instancetype)dictionary;
+ (instancetype)dictionaryWithObjects:(const ObjectType [])objects forKeys:(const KeyType [])keys count:(NSUInteger)cnt;
- (nullable ObjectType)objectForKeyedSubscript:(KeyType)key;
- (nullable ObjectType)objectForKey:(KeyType)key;
- (void)enumerateKeysAndObjectsUsingBlock:(void (^)(KeyType key, ObjectType obj, BOOL *stop))block;
@end
@interface NSMutableDictionary<KeyType, ObjectType> : NSDictionary<KeyType, ObjectType>
- (void)setObject:(nullable ObjectType)obj forKeyedSubscript:(KeyType)key;
- (void)setObject:(ObjectType)obj forKey:(KeyType)key;
- (void)removeObjectForKey:(KeyType)key;
@end
@interface NSSet<__covariant ObjectType> : NSObject <NSFastEnumeration>
@property (readonly) NSUInteger count;
@property (nullable, readonly) ObjectType anyObject;
+ (instancetype)set;
- (BOOL)containsObject:(ObjectType)o;
@end
@interface NSMutableSet<ObjectType> : NSSet<ObjectType>
- (void)addObject:(ObjectType)o;
- (void)removeObject:(ObjectType)o;
- (void)removeAllObjects;
@end
typedef NSUInteger NSPointerFunctionsOptions;
enum { NSMapTableObjectPointerPersonality = 1, NSMapTableStrongMemory = 2 };
@interface NSMapTable<KeyType, ObjectType> : NSObject <NSFastEnumeration>
+ (instancetype)mapTableWithKeyOptions:(NSPointerFunctionsOptions)k valueOptions:(NSPointerFunctionsOptions)v;
- (nullable ObjectType)objectForKey:(KeyType)key;
- (void)setObject:(ObjectType)obj forKey:(KeyType)key;
- (void)removeObjectForKey:(KeyType)key;
- (void)removeAllObjects;
@end
@interface NSNull : NSObject
+ (NSNull *)null;
@end
extern NSString *const NSPOSIXErrorDomain;
@interface NSError : NSObject
@property (readonly, copy) NSString *localizedDescription;
@property (readonly, copy) NSString *domain;
@property (readonly) NSInteger code;
@end
@interface NSException : NSObject
@end
@interface NSDate : NSObject
@property (readonly) NSTimeInterval timeIntervalSinceNow;
+ (instancetype)date;
+ (instancetype)dateWithTimeIntervalSinceNow:(NSTimeInterval)secs;
@property (class, readonly, copy) NSDate *distantFuture;
@end
typedef NSString *NSRunLoopMode;
extern NSRunLoopMode const NSDefaultRunLoopMode;
@interface NSRunLoop : NSObject
@property (class, readonly, strong) NSRunLoop *currentRunLoop;
@property (class, readonly, strong) NSRunLoop *mainRunLoop;
- (BOOL)runMode:(NSRunLoopMode)mode beforeDate:(NSDate *)limitDate;
@end
@interface NSBundle : NSObject
@property (class, readonly, strong) NSBundle *mainBundle;
@property (nullable, readonly, copy) NSString *bundleIdentifier;
@end
@interface NSProcessInfo : NSObject
@property (class, readonly, strong) NSProcessInfo *processInfo;
@property (readonly, copy) NSDictionary<NSString *, NSString *> *environment;
@end
@interface NSURL : NSObject
+ (instancetype)URLWithString:(NSString *)s;
@end
@interface NSURLQueryItem : NSObject
@property (readonly) NSString *name;
@property (nullable, readonly) NSString *value;
@end
@interface NSURLComponents : NSObject
+ (instancetype)componentsWithString:(NSString *)s;
@property (nullable, copy) NSString *path;
@property (nullable, copy) NSArray<NSURLQueryItem *> *queryItems;
@end
@interface NSNotification : NSObject
@property (nullable, readonly, retain) id object;
@end
@interface NSNotificationCenter : NSObject
@property (class, readonly, strong) NSNotificationCenter *defaultCenter;
- (void)addObserver:(id)observer selector:(SEL)aSelector name:(nullable NSString *)aName object:(nullable id)anObject;
- (void)removeObserver:(id)observer name:(nullable NSString *)aName object:(nullable id)anObject;
@end
@interface NSJSONSerialization : NSObject
+ (nullable id)JSONObjectWithData:(NSData *)data options:(NSUInteger)opt error:(NSError **)error;
@end
enum { NSJSONReadingMutableContainers = 1 };
@interface NSTextCheckingResult : NSObject
@property (readonly) NSRange range;
@property (readonly) NSUInteger numberOfRanges;
- (NSRange)rangeAtIndex:(NSUInteger)idx;
@end
typedef NSUInteger NSRegularExpressionOptions;
typedef NSUInteger NSMatchingOptions;
typedef NSUInteger NSMatchingFlags;
enum { NSRegularExpressionCaseInsensitive = 1 };
@interface NSRegularExpression : NSObject
+ (nullable NSRegularExpression *)regularExpressionWithPattern:(NSString *)pattern options:(NSRegularExpressionOptions)options error:(NSError **)error;
- (nullable NSTextCheckingResult *)firstMatchInString:(NSString *)string options:(NSMatchingOptions)options range:(NSRange)range;
- (NSString *)stringByReplacingMatchesInString:(NSString *)string options:(NSMatchingOptions)options range:(NSRange)range withTemplate:(NSString *)templ;
- (void)enumerateMatchesInString:(NSString *)string options:(NSMatchingOptions)options range:(NSRange)range usingBlock:(void (^)(NSTextCheckingResult *result, NSMatchingFlags flags, BOOL *stop))block;
@end
#endif
