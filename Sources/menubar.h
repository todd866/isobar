// Compact menu-bar weather reading. Keep this header self-contained so the
// native status item and its screenshot fixture use exactly the same drawing.
#import <Cocoa/Cocoa.h>
#import "pure.h"

static NSNumber *IsobarMenuBarNumber(NSDictionary *obs, NSArray<NSString *> *keys) {
    for (NSString *key in keys) {
        id value = obs[key];
        if ([value isKindOfClass:NSNumber.class] && isfinite([value doubleValue])) return value;
    }
    return nil;
}

static NSString *IsobarMenuBarDirection(NSDictionary *obs, double *from) {
    NSString *direction = [obs[@"windDir"] isKindOfClass:NSString.class] ? [obs[@"windDir"] uppercaseString] : nil;
    if (!direction.length) direction = [obs[@"wind_direction"] isKindOfClass:NSString.class] ? [obs[@"wind_direction"] uppercaseString] : nil;
    if (direction.length && WindFromDegrees(direction, from)) return direction;
    NSNumber *degrees = IsobarMenuBarNumber(obs, @[@"windFrom", @"wind_from", @"wind_direction_deg"]);
    if (degrees) {
        *from = degrees.doubleValue;
        return @"";
    }
    return nil;
}

static NSDictionary *IsobarMenuBarModel(NSDictionary *obs) {
    if (![obs isKindOfClass:NSDictionary.class]) return @{};
    NSNumber *temp = IsobarMenuBarNumber(obs, @[@"airTemp", @"air_temp", @"temperature"]);
    NSNumber *kt = IsobarMenuBarNumber(obs, @[@"windKt", @"wind_spd_kt", @"wind_speed_kt"]);
    if (!kt) {
        NSNumber *kmh = IsobarMenuBarNumber(obs, @[@"windKmh", @"wind_spd_kmh", @"wind_speed_kmh"]);
        if (kmh) kt = @(KnotsFromKmh(kmh.doubleValue));
    }
    double from = 0;
    NSString *direction = IsobarMenuBarDirection(obs, &from);
    BOOL hasSpeed = kt && kt.doubleValue >= 0;
    // "Calm" replaces the text only when the measured speed rounds to zero.
    // At 1–2 kt the exact reading stays visible.
    BOOL calm = hasSpeed && kt.doubleValue < .5;
    BOOL hasDirection = direction.length > 0;
    if (!hasDirection) {
        NSNumber *numeric = IsobarMenuBarNumber(obs, @[@"windFrom", @"wind_from", @"wind_direction_deg"]);
        hasDirection = numeric && isfinite(numeric.doubleValue) && numeric.doubleValue >= 0 && numeric.doubleValue <= 360;
    }
    return @{ @"temp": temp ?: NSNull.null, @"kt": kt ?: NSNull.null,
              @"direction": direction ?: @"",
              @"from": @(from), @"hasSpeed": @(hasSpeed), @"calm": @(calm),
              @"hasDirection": @(hasDirection) };
}

static NSString *IsobarMenuBarAccessibility(NSDictionary *obs) {
    NSDictionary *model = IsobarMenuBarModel(obs);
    NSNumber *temp = model[@"temp"], *kt = model[@"kt"];
    NSMutableString *label = [NSMutableString string];
    if ([temp isKindOfClass:NSNumber.class]) [label appendFormat:@"%.0f degrees", round(temp.doubleValue)];
    else [label appendString:@"Temperature unavailable"];
    if ([model[@"calm"] boolValue]) [label appendString:@", calm"];
    else if ([model[@"hasSpeed"] boolValue]) {
        NSString *direction = model[@"direction"];
        if ([model[@"hasDirection"] boolValue] && direction.length)
            [label appendFormat:@", wind from %@ %.0f knots", direction, round(kt.doubleValue)];
        else if ([model[@"hasDirection"] boolValue])
            [label appendFormat:@", wind from %.0f° %.0f knots", [model[@"from"] doubleValue], round(kt.doubleValue)];
        else [label appendFormat:@", wind %.0f knots", round(kt.doubleValue)];
    }
    return label;
}

// The number already gives the exact speed. At this size, show only the
// direction the air moves; a barb's feathers are too easy to read as digits.
static void IsobarDrawMenuBarWindArrow(double fromDegrees, NSRect box) {
    NSColor *ink = NSColor.labelColor;
    [ink setStroke]; [ink setFill];
    NSPoint centre = NSMakePoint(NSMidX(box), NSMidY(box));
    double radians = fmod(fromDegrees + 180.0 + 360.0, 360.0) * M_PI / 180.0;
    NSPoint direction = NSMakePoint(sin(radians), cos(radians));
    NSPoint side = NSMakePoint(direction.y, -direction.x);
    NSPoint root = NSMakePoint(centre.x - direction.x * 5.2, centre.y - direction.y * 5.2);
    NSPoint tip = NSMakePoint(centre.x + direction.x * 6.0, centre.y + direction.y * 6.0);
    NSBezierPath *shaft = [NSBezierPath bezierPath];
    shaft.lineWidth = 2.4; shaft.lineCapStyle = NSLineCapStyleRound;
    [shaft moveToPoint:root]; [shaft lineToPoint:tip]; [shaft stroke];
    NSPoint base = NSMakePoint(tip.x - direction.x * 5.0, tip.y - direction.y * 5.0);
    NSBezierPath *head = [NSBezierPath bezierPath];
    [head moveToPoint:tip];
    [head lineToPoint:NSMakePoint(base.x + side.x * 3.3, base.y + side.y * 3.3)];
    [head lineToPoint:NSMakePoint(base.x - side.x * 3.3, base.y - side.y * 3.3)];
    [head closePath]; [head fill];
}

static NSImage *IsobarMenuBarImage(NSDictionary *obs, BOOL warning) {
    NSDictionary *model = IsobarMenuBarModel(obs);
    NSNumber *temp = model[@"temp"], *kt = model[@"kt"];
    BOOL hasSpeed = [model[@"hasSpeed"] boolValue], calm = [model[@"calm"] boolValue];
    BOOL hasDirection = [model[@"hasDirection"] boolValue];
    BOOL hasArrow = hasSpeed && !calm && hasDirection;
    NSString *temperature = [temp isKindOfClass:NSNumber.class] ? [NSString stringWithFormat:@"%.0f°", round(temp.doubleValue)] : @"—";
    NSString *speed = hasSpeed && !calm ? [NSString stringWithFormat:@"%.0f kt", round(kt.doubleValue)] : (calm ? @"calm" : @"");
    NSFont *font = [NSFont monospacedDigitSystemFontOfSize:12.5 weight:NSFontWeightMedium];
    NSDictionary *attributes = @{NSFontAttributeName: font, NSForegroundColorAttributeName: NSColor.labelColor};
    CGFloat textWidth = [temperature sizeWithAttributes:attributes].width;
    CGFloat speedWidth = speed.length ? [speed sizeWithAttributes:attributes].width : 0;
    CGFloat width = 6 + textWidth + (speed.length ? (hasArrow ? 29 : 14) + speedWidth : 0) + (warning ? 8 : 4);
    NSImage *image = [NSImage imageWithSize:NSMakeSize(ceil(width), 18) flipped:NO drawingHandler:^BOOL(NSRect dirtyRect) {
        (void)dirtyRect;
        CGFloat x = 2;
        [temperature drawAtPoint:NSMakePoint(x, 2) withAttributes:attributes];
        x += textWidth;
        if (speed.length) {
            // A quiet separator keeps the temperature and wind reading as two
            // related values without turning the status item into a pill.
            [NSColor.labelColor setFill];
            [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x + 4, 8, 2, 2)] fill];
            x += 10;
        }
        if (hasArrow) {
            NSRect box = NSMakeRect(x, 1, 17, 16);
            IsobarDrawMenuBarWindArrow([model[@"from"] doubleValue], box);
            x += 19;
        } else if (speed.length) {
            x += 4;
        }
        if (speed.length) [speed drawAtPoint:NSMakePoint(x, 2) withAttributes:attributes];
        if (warning) {
            [[NSColor systemRedColor] setFill];
            NSRect dot = NSMakeRect(width - 5, 7, 4, 4);
            [[NSBezierPath bezierPathWithOvalInRect:dot] fill];
        }
        return YES;
    }];
    image.template = !warning;
    return image;
}
