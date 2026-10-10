# Worldwide coastline asset

`world.bin` is OCST version 1: little-endian `uint16` ring counts followed by
signed hundredths-of-a-degree longitude/latitude pairs. Rings are kept as
separate polygon parts, including holes; the web renderer uses an even-odd fill.

The source is Natural Earth 10m land, version 3.0.1, WGS84:

Licence: [public domain](https://www.naturalearthdata.com/about/terms-of-use/).

<https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-land/>

- source file: `ne_10m_land.shp` (pass its local path as `SOURCE`)
- source SHA-256: `e723e2607efb43957f2bfe2446dbc16bc2bd16894915bcf64258790a51ecbdef`
- source version: `3.0.1` (`ne_10m_land.VERSION.txt`)
- generator: `python3 web/scripts/pack-world-coast.py SOURCE web/public/coast/world.bin`
- simplification candidates: `0.01`, `0.015`, `0.02` degrees
- selected tolerance: `0.01` degrees, the finest candidate under the 1 MiB budget
- rings: `8,648`
- vertices: `219,508`
- payload bytes: `895,336`
- output SHA-256: `eb986e033ee3c8e704c3c64977a67ed7b5a54c731501288d374f83af8b68fc96`

The generator quantizes before simplifying, removes only consecutive duplicate
vertices and duplicate closing vertices, and does not discard broad global rings.
`1,068` source parts collapse below three distinct points at OCST precision and
are explicitly omitted as unrepresentable. Valid three-point-or-larger parts
that simplification would collapse retain their original quantized geometry.
The generator rejects rings over the OCST `uint16` limit and outputs the first
candidate that fits the 1 MiB bound.
