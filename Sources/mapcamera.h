// Pan, zoom, anchor and 2D/3D morph for the field camera.
// Shared by Map Lab and the expanded-map GPU view. Playback time is not here:
// the app's one playhead owns the forecast instant.
#import "fieldrender.h"

// A 2D/3D morph. Zero slope at both ends.
extern const double kMapMorphSeconds;

double MapWrap180(double longitude);
double MapEaseInOut(double t);
// reduced != 0 jumps to `to`. Otherwise eases across `duration` seconds.
double MapGlobeAt(double from, double to, double elapsed, double duration, int reduced);
// A pointer that stays inside `slop` pixels is a click. A longer move is a drag.
int MapPointerIsClick(double dx, double dy, double slop);
IsobarCamera MapCameraMake(double latitude, double longitude, double zoom, double globe,
    double viewportW, double viewportH);
// Keeps the geographic point on the cursor. Exact on the flat map and on the
// globe. Intermediate morphs use the flat solution so a drag does not run the
// renderer's front-face search on the pointer thread.
BOOL MapCameraAnchor(IsobarCamera *camera, double latitude, double longitude, double x, double y);
// Adjusts the physical vertical eye position while preserving geographic
// focus and horizontal stand-off.
BOOL MapCameraAdjustEyeHeight(IsobarCamera *camera, double delta);
