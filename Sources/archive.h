#import <Foundation/Foundation.h>

// Read-only adapters from the daemon's published products to the legacy app shapes.
NSDictionary<NSString *, NSData *> *ArchiveObservationFiles(NSString *root);
NSDictionary<NSString *, NSData *> *ArchiveObservationFilesAtDate(NSString *root, NSDate *now);
NSData *ArchivePointFile(NSString *root, NSDictionary *place);
NSData *ArchiveKiteFile(NSString *root);
NSDictionary *ArchiveAviationProduct(NSString *root, NSString *name);

// Resolve the published Bureau chart snapshot. When the family has no
// current.json pointer, the legacy flat paths are still accepted. Once a
// pointer exists, malformed or incomplete snapshots fail closed.
NSString *ArchiveChartPath(NSString *root, BOOL previous);
NSString *ArchiveWarningDirectory(NSString *root);

// Exact configured beach ID; marine cells may be offshore of its coordinates.
NSDictionary *ArchiveMarineProduct(NSString *root, NSString *spotID);
// Exact airport identity; pressure-level heights remain AMSL.
NSDictionary *ArchiveAtmosphereProduct(NSString *root, NSString *airportCode);
