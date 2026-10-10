# Earth-view prototype assets

- earth-october.jpg: NASA Blue Marble Next Generation, October **2004** cloud-free
  surface composite, 5400×2700. Static surface, not today's snow/vegetation/clouds.
  Source: https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/
  SHA256 ccfd9b7a5e5ee601e1466556716bba50ea418f3a8e068ab0194ae0425815b1b0.
- iss.glb: NASA Visualization Technology Applications and Development (VTAD).
  Source: https://science.nasa.gov/resource/international-space-station-3d-model/
  Original: https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/i/ISS_stationary.glb
  Source SHA256 26dba905b4b7555edbcb0c5f5a61b5c18659f5166076ab27dbb0e64025759fca.
  Optimized SHA256 36f17aa5605f145c7b38f1e2c6592d2637c8b3f0a0b2214bb77e5058ffdccfd9.
  glTF Transform CLI 4.2.1: optimize --texture-size 1024 --compress draco,
  then webp --quality 85, then draco. 44.50 MB became 3.65 MB.
  This changes mesh precision and texture detail; no current configuration claim.
  Model geometry/configuration and orientation are illustrative, not attitude telemetry.
  Longest dimension normalized to 109 m for this prototype.

NASA media usage: https://www.nasa.gov/nasa-brand-center/images-and-media/
Used for an informational simulation, with attribution and no endorsement claim.
Earth image is unmodified source bytes; model is optimized as above.
NASA branding is not used as Isobar branding.
The 5400-pixel texture needs a device texture-size check; lower-capability devices
use a browser-resampled bounded texture. No satellite clouds, aurora or night-light
observations are supplied by these files.
