/**
 * Files from the PC onto the phone (v6, 2026-11-24). Included at the end of FBLotusCommands.inc, so it needs no entry
 * in the Xcode project. Photos and videos go into Photos through PhotoKit (add-only access: nothing is ever read from
 * the library), everything else into this app's own Documents folder, which Files shows as "On My iPhone > Lotus"
 * (the keys for both are put into the runner's Info.plist by the repo's scripts/lotus-runner-plist.sh). Nothing here opens an app,
 * a share sheet or a connection, overwrites a file or deletes one that landed. Names are never logged.
 *
 *   GET  /lotus/files/can            {photos: {key, status}, files: {shared, folder}, free}
 *   POST /lotus/files/ask            shows iOS's own "add to Photos" prompt (this app comes to the front for it) and
 *                                    goes Home once it's answered -> {asked, status, why?}
 *   POST /lotus/files/begin?id=      {size} -> {offset}: how much of it is here already
 *   POST /lotus/files/put?id=&offset=   raw bytes -> {offset}; nothing is written when the offset is another one
 *   POST /lotus/files/land?id=       {where, fallback, rel, name, video, mtime?, size, sha256} -> {where, path?, why?} or
 *                                    {refused, again?, files?}; asked again it gives the same answer
 *   POST /lotus/files/dir?id=        {rel, unique} -> {rel}
 *   POST /lotus/files/drop?id=       forgets an unfinished one
 *
 * All but /ask are standalone: off the main queue, so a file never waits for a touch nor a touch for a file.
 * TO SEE ON THE MAC: it compiles; /ask brings the prompt up; a picture and a video land in Photos with their date; a
 * folder shows in Files; a touch while a big file is on its way is as quick as before.
 */

#import <AVFoundation/AVFoundation.h>
#import <CommonCrypto/CommonDigest.h>
#import <ImageIO/ImageIO.h>
#import <Photos/Photos.h>

/** An unfinished file nobody went on with for this long is deleted. */
static const NSTimeInterval LotusFilesKeepSeconds = 24 * 3600;
static const NSUInteger LotusFilesMaxName = 255;

@interface FBLotusFilesCommands : NSObject <FBCommandHandler>
@end

@implementation FBLotusFilesCommands

+ (NSArray *)routes
{
  return
  @[
    [[FBRoute GET:@"/lotus/files/can"].withoutSession.standalone respondWithTarget:self action:@selector(handleFilesCan:)],
    [[FBRoute POST:@"/lotus/files/ask"].withoutSession respondWithTarget:self action:@selector(handleFilesAsk:)],
    [[FBRoute POST:@"/lotus/files/begin"].withoutSession.standalone respondWithTarget:self action:@selector(handleFilesBegin:)],
    [[FBRoute POST:@"/lotus/files/put"].withoutSession.standalone respondWithTarget:self action:@selector(handleFilesPut:)],
    [[FBRoute POST:@"/lotus/files/land"].withoutSession.standalone respondWithTarget:self action:@selector(handleFilesLand:)],
    [[FBRoute POST:@"/lotus/files/dir"].withoutSession.standalone respondWithTarget:self action:@selector(handleFilesDir:)],
    [[FBRoute POST:@"/lotus/files/drop"].withoutSession.standalone respondWithTarget:self action:@selector(handleFilesDrop:)],
  ];
}

#pragma mark - Places

/** Where unfinished files wait: this app's own tmp, which Files never shows. */
+ (NSString *)lotus_temp
{
  NSString *dir = [NSTemporaryDirectory() stringByAppendingPathComponent:@"lotus-send"];
  [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
  return dir;
}

+ (NSString *)lotus_documents
{
  return NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
}

/** The request's id, or nil: 1-40 of 0-9 and a-z, so it can be a file's name. */
+ (NSString *)lotus_id:(FBRouteRequest *)request
{
  id value = request.parameters[@"id"];
  if (![value isKindOfClass:NSString.class]) {
    return nil;
  }
  NSString *text = (NSString *)value;
  if (text.length < 1 || text.length > 40) {
    return nil;
  }
  for (NSUInteger i = 0; i < text.length; i++) {
    unichar c = [text characterAtIndex:i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z'))) {
      return nil;
    }
  }
  return text;
}

+ (NSString *)lotus_file:(NSString *)identifier kind:(NSString *)kind
{
  return [[self lotus_temp] stringByAppendingPathComponent:[NSString stringWithFormat:@"%@.%@", identifier, kind]];
}

/** A file's size, or -1 when there's none. */
+ (long long)lotus_size:(NSString *)path
{
  NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:path error:NULL];
  if (nil == attributes || ![attributes.fileType isEqualToString:NSFileTypeRegular]) {
    return -1;
  }
  return (long long)attributes.fileSize;
}

/** The parts of a path inside the shared folder, or nil when it could lead out of it (the Mac's server checked too). */
+ (NSArray *)lotus_parts:(id)value
{
  if (![value isKindOfClass:NSString.class]) {
    return nil;
  }
  NSArray *parts = [(NSString *)value componentsSeparatedByString:@"/"];
  if (parts.count < 1 || parts.count > 32) {
    return nil;
  }
  for (NSString *part in parts) {
    if (part.length < 1 || [part isEqualToString:@"."] || [part isEqualToString:@".."]
        || [part lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > LotusFilesMaxName
        || [part rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) {
      return nil;
    }
  }
  return parts;
}

/** "name.ext" as "name (2).ext" (the Mac's server: src/files.ts, numbered). */
+ (NSString *)lotus_name:(NSString *)name number:(NSInteger)number folder:(BOOL)folder
{
  if (number < 2) {
    return name;
  }
  NSString *extension = @"";
  NSString *stem = name;
  NSRange dot = [name rangeOfString:@"." options:NSBackwardsSearch];
  if (!folder && dot.location != NSNotFound && dot.location > 0 && name.length - dot.location <= 17) {
    extension = [name substringFromIndex:dot.location];
    stem = [name substringToIndex:dot.location];
  }
  NSString *end = [NSString stringWithFormat:@" (%ld)%@", (long)number, extension];
  NSUInteger endBytes = [end lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  while (stem.length > 0 && [stem lengthOfBytesUsingEncoding:NSUTF8StringEncoding] + endBytes > LotusFilesMaxName) {
    NSRange last = [stem rangeOfComposedCharacterSequenceAtIndex:stem.length - 1];
    stem = [stem substringToIndex:last.location];
  }
  return [stem stringByAppendingString:end];
}

/** The answer kept for a request that's asked again (the Mac never heard the first one). */
+ (NSDictionary *)lotus_noted:(NSString *)path
{
  return [NSDictionary dictionaryWithContentsOfFile:path];
}

+ (void)lotus_note:(NSDictionary *)answer at:(NSString *)path
{
  [answer writeToFile:path atomically:YES];
}

+ (void)lotus_sweep
{
  NSString *dir = [self lotus_temp];
  NSDate *old = [NSDate dateWithTimeIntervalSinceNow:-LotusFilesKeepSeconds];
  for (NSString *name in [NSFileManager.defaultManager contentsOfDirectoryAtPath:dir error:NULL]) {
    NSString *path = [dir stringByAppendingPathComponent:name];
    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:path error:NULL];
    NSDate *date = attributes.fileModificationDate;
    if (nil != date && [date compare:old] == NSOrderedAscending) {
      [NSFileManager.defaultManager removeItemAtPath:path error:NULL];
    }
  }
}

+ (id<FBResponsePayload>)lotus_bad
{
  return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"bad file request" traceback:nil]);
}

+ (id<FBResponsePayload>)lotus_failed
{
  return FBResponseWithStatus([FBCommandStatus unknownErrorWithMessage:@"the file could not be written" traceback:nil]);
}

+ (NSDictionary *)lotus_refused:(NSString *)why again:(BOOL)again
{
  return @{@"refused": why, @"again": @(again)};
}

#pragma mark - What this phone takes

/** The runner's Info.plist has the text iOS shows when it asks; without it a request would end this app, so none is made. */
+ (BOOL)lotus_photosKey
{
  id text = NSBundle.mainBundle.infoDictionary[@"NSPhotoLibraryAddUsageDescription"];
  return [text isKindOfClass:NSString.class] && ((NSString *)text).length > 0;
}

+ (BOOL)lotus_shared
{
  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  id sharing = info[@"UIFileSharingEnabled"];
  id inPlace = info[@"LSSupportsOpeningDocumentsInPlace"];
  return [sharing respondsToSelector:@selector(boolValue)] && [sharing boolValue]
    && [inPlace respondsToSelector:@selector(boolValue)] && [inPlace boolValue];
}

/** The folder's name in Files: this app's name. */
+ (NSString *)lotus_folder
{
  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  id name = info[@"CFBundleDisplayName"];
  if (![name isKindOfClass:NSString.class] || ((NSString *)name).length < 1) {
    name = info[@"CFBundleName"];
  }
  return [name isKindOfClass:NSString.class] ? (NSString *)name : @"Lotus";
}

+ (NSString *)lotus_photosStatus
{
  if (![self lotus_photosKey]) {
    return @"none";
  }
  switch ([PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelAddOnly]) {
    case PHAuthorizationStatusAuthorized:
      return @"authorized";
    case PHAuthorizationStatusLimited:
      return @"limited";
    case PHAuthorizationStatusDenied:
      return @"denied";
    case PHAuthorizationStatusNotDetermined:
      return @"notDetermined";
    default:
      return @"restricted";
  }
}

+ (id<FBResponsePayload>)handleFilesCan:(FBRouteRequest *)request
{
  NSNumber *available = nil;
  NSURL *home = [NSURL fileURLWithPath:[self lotus_documents]];
  [home getResourceValue:&available forKey:NSURLVolumeAvailableCapacityForImportantUsageKey error:NULL];
  return FBResponseWithObject(@{
    @"lotus": @(LotusForkVersion),
    @"photos": @{@"key": @([self lotus_photosKey]), @"status": [self lotus_photosStatus]},
    @"files": @{@"shared": @([self lotus_shared]), @"folder": [self lotus_folder]},
    @"free": nil != available ? available : @0,
  });
}

/**
 iOS shows its own prompt only for an app that's in front, so this app comes to the front for it, once. The owner
 answers it on the phone (nothing here taps it); then the phone goes to its Home Screen, as after the self-test.
 */
+ (id<FBResponsePayload>)handleFilesAsk:(FBRouteRequest *)request
{
  NSString *status = [self lotus_photosStatus];
  if (![status isEqualToString:@"notDetermined"]) {
    return FBResponseWithObject(@{@"asked": @NO, @"status": status});
  }
  UIApplication *app = UIApplication.sharedApplication;
  if (app.applicationState != UIApplicationStateActive) {
    NSString *bundleId = NSBundle.mainBundle.bundleIdentifier;
    if (nil != bundleId) {
      [FBUnattachedAppLauncher launchAppWithBundleId:bundleId];
    }
    for (int i = 0; i < 40 && app.applicationState != UIApplicationStateActive; i++) {
      [FBLotusCommands lotus_spin:0.1];
    }
  }
  if (app.applicationState != UIApplicationStateActive) {
    return FBResponseWithObject(@{@"asked": @NO, @"status": status, @"why": @"the screen is off or locked"});
  }
  [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelAddOnly handler:^(PHAuthorizationStatus answer) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [[XCUIDevice sharedDevice] fb_goToHomescreenWithError:NULL];
    });
  }];
  return FBResponseWithObject(@{@"asked": @YES, @"status": status});
}

#pragma mark - Receiving

+ (id<FBResponsePayload>)handleFilesBegin:(FBRouteRequest *)request
{
  NSString *identifier = [self lotus_id:request];
  id sizeArg = request.arguments[@"size"];
  if (nil == identifier || ![sizeArg isKindOfClass:NSNumber.class]) {
    return [self lotus_bad];
  }
  [self lotus_sweep];
  if (nil != [self lotus_noted:[self lotus_file:identifier kind:@"done"]]) {
    return FBResponseWithObject(@{@"offset": sizeArg}); // it landed already: the Mac asks for its place next
  }
  NSString *part = [self lotus_file:identifier kind:@"part"];
  long long have = [self lotus_size:part];
  if (have < 0 || have > ((NSNumber *)sizeArg).longLongValue) {
    if (![NSFileManager.defaultManager createFileAtPath:part contents:[NSData data] attributes:nil]) {
      return [self lotus_failed];
    }
    have = 0;
  }
  return FBResponseWithObject(@{@"offset": @(have)});
}

+ (id<FBResponsePayload>)handleFilesPut:(FBRouteRequest *)request
{
  NSString *identifier = [self lotus_id:request];
  id body = request.arguments[@"lotusBody"]; // the request's raw bytes (FBWebServer.m)
  id offsetArg = request.parameters[@"offset"];
  if (nil == identifier || ![body isKindOfClass:NSData.class] || ![offsetArg isKindOfClass:NSString.class]) {
    return [self lotus_bad];
  }
  long long offset = ((NSString *)offsetArg).longLongValue;
  NSString *part = [self lotus_file:identifier kind:@"part"];
  long long have = [self lotus_size:part];
  if (have < 0 || have != offset) {
    return FBResponseWithObject(@{@"offset": @(MAX(have, 0))});
  }
  NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:part];
  if (nil == handle) {
    return [self lotus_failed];
  }
  BOOL written = [handle seekToEndReturningOffset:NULL error:NULL] && [handle writeData:(NSData *)body error:NULL];
  if (!written) {
    [handle truncateAtOffset:(unsigned long long)offset error:NULL];
  }
  [handle closeAndReturnError:NULL];
  if (!written) {
    return [self lotus_failed];
  }
  return FBResponseWithObject(@{@"offset": @(offset + (long long)((NSData *)body).length)});
}

+ (id<FBResponsePayload>)handleFilesDrop:(FBRouteRequest *)request
{
  NSString *identifier = [self lotus_id:request];
  if (nil == identifier) {
    return [self lotus_bad];
  }
  [NSFileManager.defaultManager removeItemAtPath:[self lotus_file:identifier kind:@"part"] error:NULL];
  return FBResponseWithObject(@{@"dropped": @YES});
}

#pragma mark - Into its place

/** The file's SHA-256 as hex, read in pieces; nil when it can't be read. */
+ (NSString *)lotus_sha256:(NSString *)path
{
  FILE *file = fopen(path.fileSystemRepresentation, "rb");
  if (NULL == file) {
    return nil;
  }
  size_t room = 1024 * 1024;
  unsigned char *buffer = malloc(room);
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  size_t got = 0;
  while (NULL != buffer && (got = fread(buffer, 1, room, file)) > 0) {
    CC_SHA256_Update(&context, buffer, (CC_LONG)got);
  }
  BOOL good = NULL != buffer && 0 == ferror(file);
  free(buffer);
  fclose(file);
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  if (!good) {
    return nil;
  }
  NSMutableString *hex = [NSMutableString string];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
    [hex appendFormat:@"%02x", digest[i]];
  }
  return hex;
}

/** The picture or video says itself when it was taken (Photos reads that; only one that doesn't is given the file's date). */
+ (BOOL)lotus_hasDate:(NSURL *)url video:(BOOL)video
{
  if (video) {
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
    return nil != asset.creationDate;
  }
  CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
  if (NULL == source) {
    return NO;
  }
  NSDictionary *properties = (__bridge_transfer NSDictionary *)CGImageSourceCopyPropertiesAtIndex(source, 0, NULL);
  CFRelease(source);
  NSDictionary *exif = properties[(__bridge NSString *)kCGImagePropertyExifDictionary];
  NSDictionary *tiff = properties[(__bridge NSString *)kCGImagePropertyTIFFDictionary];
  return nil != exif[(__bridge NSString *)kCGImagePropertyExifDateTimeOriginal] || nil != tiff[(__bridge NSString *)kCGImagePropertyTIFFDateTime];
}

/** Into Photos as it is (its own bytes). nil when it's there, else why not; `format`: Photos doesn't take such a file. */
+ (NSString *)lotus_addToPhotos:(NSString *)path name:(NSString *)name video:(BOOL)video date:(NSDate *)date format:(BOOL *)format
{
  NSString *cant = video ? @"Photos can't take this video (its format or codec)" : @"Photos can't take this picture (its format)";
  *format = YES;
  if (video && !UIVideoAtPathIsCompatibleWithSavedPhotosAlbum(path)) {
    return cant;
  }
  NSURL *url = [NSURL fileURLWithPath:path];
  NSDate *given = nil != date && ![self lotus_hasDate:url video:video] ? date : nil;
  NSError *error = nil;
  BOOL added = NO;
  @try {
    added = [[PHPhotoLibrary sharedPhotoLibrary] performChangesAndWait:^{
      PHAssetResourceCreationOptions *options = [[PHAssetResourceCreationOptions alloc] init];
      options.originalFilename = name;
      options.shouldMoveFile = YES;
      PHAssetCreationRequest *creation = [PHAssetCreationRequest creationRequestForAsset];
      [creation addResourceWithType:(video ? PHAssetResourceTypeVideo : PHAssetResourceTypePhoto) fileURL:url options:options];
      if (nil != given) {
        creation.creationDate = given;
      }
    } error:&error];
  } @catch (NSException *exception) {
    added = NO;
  }
  if (added) {
    return nil;
  }
  // PHPhotosErrorNotEnoughSpace, PHPhotosErrorAccessUserDenied, PHPhotosErrorAccessRestricted (PHPhotosErrorDomain)
  if (3305 == error.code) {
    *format = NO;
    return @"the phone is too full for it";
  }
  if (3311 == error.code || 3310 == error.code) {
    *format = NO;
    return @"Photos permission is off for Lotus on the phone (Settings > Privacy & Security > Photos)";
  }
  if (nil == error || 3302 == error.code) {
    return cant;
  }
  return [NSString stringWithFormat:@"Photos did not take it (%ld)", (long)error.code];
}

/** Into the shared folder under a free name; nothing there is ever overwritten. Its path there, or nil. */
+ (NSString *)lotus_place:(NSString *)path parts:(NSArray *)parts date:(NSDate *)date
{
  NSFileManager *files = NSFileManager.defaultManager;
  NSString *parent = [[parts subarrayWithRange:NSMakeRange(0, parts.count - 1)] componentsJoinedByString:@"/"];
  NSString *directory = [[self lotus_documents] stringByAppendingPathComponent:parent];
  if (![files createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL]) {
    return nil;
  }
  for (NSInteger n = 1; n < 10000; n++) {
    NSString *name = [self lotus_name:parts.lastObject number:n folder:NO];
    NSString *target = [directory stringByAppendingPathComponent:name];
    if ([files fileExistsAtPath:target]) {
      continue;
    }
    if ([files moveItemAtPath:path toPath:target error:NULL]) { // it refuses a name that's taken
      if (nil != date) {
        [files setAttributes:@{NSFileModificationDate: date} ofItemAtPath:target error:NULL];
      }
      return parent.length > 0 ? [NSString stringWithFormat:@"%@/%@", parent, name] : name;
    }
    if (![files fileExistsAtPath:target]) {
      return nil;
    }
  }
  return nil;
}

+ (id<FBResponsePayload>)handleFilesLand:(FBRouteRequest *)request
{
  NSString *identifier = [self lotus_id:request];
  NSDictionary *arguments = request.arguments;
  id where = arguments[@"where"];
  id name = arguments[@"name"];
  id sizeArg = arguments[@"size"];
  id sha = arguments[@"sha256"];
  NSArray *parts = [self lotus_parts:arguments[@"rel"]];
  if (nil == identifier || nil == parts || ![where isKindOfClass:NSString.class] || [self lotus_parts:name].count != 1
      || ![sizeArg isKindOfClass:NSNumber.class] || ![sha isKindOfClass:NSString.class]) {
    return [self lotus_bad];
  }
  NSString *note = [self lotus_file:identifier kind:@"done"];
  NSDictionary *before = [self lotus_noted:note];
  if (nil != before) {
    return FBResponseWithObject(before);
  }
  NSString *part = [self lotus_file:identifier kind:@"part"];
  // "again": what's here isn't the file (or it's gone): the Mac sends it once more
  if ([self lotus_size:part] != ((NSNumber *)sizeArg).longLongValue || ![(NSString *)sha isEqualToString:[self lotus_sha256:part]]) {
    return FBResponseWithObject([self lotus_refused:@"what reached the phone is not the file" again:YES]);
  }
  BOOL video = [FBLotusCommands lotus_number:arguments[@"video"] fallback:0 low:0 high:1] > 0.5;
  BOOL fallback = [FBLotusCommands lotus_number:arguments[@"fallback"] fallback:0 low:0 high:1] > 0.5;
  id mtime = arguments[@"mtime"];
  NSDate *date = nil;
  if ([mtime isKindOfClass:NSNumber.class] && ((NSNumber *)mtime).doubleValue > 0) {
    date = [NSDate dateWithTimeIntervalSince1970:((NSNumber *)mtime).doubleValue / 1000.0];
  }
  NSMutableDictionary *answer = [NSMutableDictionary dictionary];
  if ([(NSString *)where isEqualToString:@"photos"]) {
    NSString *status = [self lotus_photosStatus];
    if (![status isEqualToString:@"authorized"] && ![status isEqualToString:@"limited"]) {
      return FBResponseWithObject([self lotus_refused:@"Photos permission is off for Lotus on the phone (Settings > Privacy & Security > Photos)" again:NO]);
    }
    // Photos tells the kind of a file by its name's end
    NSString *extension = ((NSString *)name).pathExtension.lowercaseString;
    NSString *ready = [self lotus_file:identifier kind:[@"photo." stringByAppendingString:extension]];
    [NSFileManager.defaultManager removeItemAtPath:ready error:NULL];
    if (![NSFileManager.defaultManager moveItemAtPath:part toPath:ready error:NULL]) {
      return [self lotus_failed];
    }
    BOOL format = NO;
    NSString *why = [self lotus_addToPhotos:ready name:(NSString *)name video:video date:date format:&format];
    if (nil == why) {
      [NSFileManager.defaultManager removeItemAtPath:ready error:NULL];
      answer[@"where"] = @"Photos";
      [self lotus_note:answer at:note];
      return FBResponseWithObject(answer);
    }
    if (![NSFileManager.defaultManager moveItemAtPath:ready toPath:part error:NULL]) {
      // Photos kept the file though it didn't take it: sent once more, straight to Files
      BOOL next = fallback && format;
      return FBResponseWithObject(@{@"refused": why, @"again": @(next), @"files": @(next)});
    }
    if (!fallback || !format) {
      return FBResponseWithObject([self lotus_refused:why again:NO]);
    }
    answer[@"why"] = [why stringByAppendingString:@": it is in Files"];
  }
  if (![self lotus_shared]) {
    return FBResponseWithObject([self lotus_refused:@"this phone's control app has no shared folder, so Files can't show it" again:NO]);
  }
  NSString *path = [self lotus_place:part parts:parts date:date];
  if (nil == path) {
    return FBResponseWithObject([self lotus_refused:@"the phone could not put it in its folder (a file with the folder's name may be in the way, or the phone is full)" again:NO]);
  }
  answer[@"where"] = @"Files";
  answer[@"path"] = [NSString stringWithFormat:@"%@/%@", [self lotus_folder], path];
  [self lotus_note:answer at:note];
  return FBResponseWithObject(answer);
}

+ (id<FBResponsePayload>)handleFilesDir:(FBRouteRequest *)request
{
  NSString *identifier = [self lotus_id:request];
  NSArray *parts = [self lotus_parts:request.arguments[@"rel"]];
  if (nil == identifier || nil == parts) {
    return [self lotus_bad];
  }
  NSString *note = [self lotus_file:identifier kind:@"dir"];
  NSDictionary *before = [self lotus_noted:note];
  if (nil != before) {
    return FBResponseWithObject(before);
  }
  if (![self lotus_shared]) {
    return [self lotus_failed];
  }
  NSFileManager *files = NSFileManager.defaultManager;
  BOOL unique = [FBLotusCommands lotus_number:request.arguments[@"unique"] fallback:0 low:0 high:1] > 0.5;
  NSString *parent = [[parts subarrayWithRange:NSMakeRange(0, parts.count - 1)] componentsJoinedByString:@"/"];
  NSString *directory = [[self lotus_documents] stringByAppendingPathComponent:parent];
  if (![files createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL]) {
    return [self lotus_failed];
  }
  for (NSInteger n = 1; n < 10000; n++) {
    NSString *name = [self lotus_name:parts.lastObject number:n folder:YES];
    NSString *target = [directory stringByAppendingPathComponent:name];
    if (unique && [files fileExistsAtPath:target]) {
      continue;
    }
    if (![files createDirectoryAtPath:target withIntermediateDirectories:!unique attributes:nil error:NULL]) {
      if (unique && [files fileExistsAtPath:target]) {
        continue;
      }
      return [self lotus_failed];
    }
    NSDictionary *answer = @{@"rel": parent.length > 0 ? [NSString stringWithFormat:@"%@/%@", parent, name] : name};
    [self lotus_note:answer at:note];
    return FBResponseWithObject(answer);
  }
  return [self lotus_failed];
}

@end
