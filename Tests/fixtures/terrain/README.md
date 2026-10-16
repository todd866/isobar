# Terrain fixture provenance

`8/189/107.webp` is a lossless, 512×512 WebP terrarium tile captured from
`https://tiles.mapterhorn.com/8/189/107.webp` on 2026-10-14. Its SHA-256 is
`b588285f9d6ee7a65fecca99ad40e4e7f508fd2875f8ec34ce24c26f24c141bb`.
The Everest summit sample at tile pixel (416,131), geographic
(86.925°E, 27.988°N), is RGB (161,122,0) = 8570 m (8568 m after binary16 storage).

`8/233/155.webp` is the Kosciuszko tile from
`https://tiles.mapterhorn.com/8/233/155.webp`, SHA-256
`c87511204686cd12d1e83281002245323b323a707f2363f8373b3a0a3b379b5b`.
The sample at pixel (221,447), geographic (148.263°E, 36.455°S), is RGB
(136,145,0) = 2193 m.

Mapterhorn documents the endpoint and format at
https://mapterhorn.com/data-access/ and the source-specific licence notices at
https://mapterhorn.com/attribution/ and the machine-readable source register at
https://download.mapterhorn.com/attribution.json; each source's licence is
retained (there is no blanket licence for the merged terrain).
Terrarium decoding is `R*256 + G + B/256 - 32768` metres. The fixture is test
data only; production requests use the URL template in `Sources/terrain.m` and
retain the Mapterhorn attribution in the native About Isobar window.

Additional closer tiles, acquired from the same endpoint on 2026-10-14:

| File | Summit coordinate | Pixel (x,y) | RGB | Decoded m | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `12/3037/1716.webp` | Everest 27.9881 N, 86.925 E | 6,41 | 162,14,0 | 8718 | `f4a4d0e358033cca2c921ab3a95635b1a31b8b10e05871cb5e2e1d1dfab1c277` |
| `12/3734/2493.webp` | Kosciuszko 36.455 S, 148.263 E | 462,500 | 136,158,0 | 2206 | `309923f62f5ffd03f618314ba2fb7a749cf1cd0b237620770efa821ea9994862` |

URLs are `https://tiles.mapterhorn.com/` plus each file path. Pixel oracles
were independently decoded with Pillow, before native ImageIO decoding. The
encoded values are tested exactly after binary16 rounding (at Everest ±4 m).
A gridded/smoothed DEM is not a surveyed summit: Everest's surveyed ~8849 m and
Kosciuszko's ~2228 m are separate facts, not substitutions for these samples.
The scalar encoding checks exercise those known height ranges separately.

Copernicus attribution: © DLR e.V. 2010–2014 and © Airbus Defence and Space
GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA.
Australian sources include Geoscience Australia (CC BY 4.0). The merged source
register above is authoritative; no per-pixel source identifier is provided
by the RGB endpoint. See also the map's full attribution tooltip.
