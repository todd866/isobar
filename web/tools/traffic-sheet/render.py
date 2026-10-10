#!/usr/bin/env python3
"""Offline traffic design study; does not import or change product code.

Requires Python 3.10+ and Pillow. From any directory:
  python3 web/tools/traffic-sheet/render.py
  python3 web/tools/traffic-sheet/render.py --check
  python3 web/tools/traffic-sheet/render.py --make-fixture  # deterministic rebuild

Outputs light/dark PNG sheets and individual panels to build/traffic-sheet/.
The committed fixture is synthetic, nested (300/200 → 40/25 → 10/8), not a
recording. Coast geometry is the repo's Natural Earth OCST; plate tokens match
web/src/lib/overlay.ts. Isobars are illustrative, not a weather analysis.
Perth traffic uses approximate 03/21 and 06/24 axes, not SID/STAR procedures.
Vectors are great-circle constant-track projections: knots × minutes / 60 NM.
No minimum length, screen-space stretching or speed-dependent glyph sizing.
"""

from __future__ import annotations

import argparse
from collections import Counter
from functools import lru_cache
import json
import math
from pathlib import Path
import random
import struct

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
OUT = ROOT / 'build/traffic-sheet'
AIR = ('heavy', 'narrowbody', 'regional', 'bizjet', 'ga', 'helicopter')
SEA = ('tanker', 'cargo', 'passenger', 'fishing', 'sail', 'tug')
W = 640
S = 3  # supersampling, then native-size output; never enlarge icons for export
VIEWS = {
    'global': dict(west=-180, east=180, south=-78, north=82, h=285),
    'australia': dict(west=104, east=164, south=-44, north=-9, h=417),
    # 60 km east–west, equal local x/y scale, centred between Fremantle and YPPH.
    'perth': dict(west=115.885 - 30 / (111.195 * math.cos(math.radians(-31.96))),
                  east=115.885 + 30 / (111.195 * math.cos(math.radians(-31.96))),
                  south=-31.96 - 20 / 111.195, north=-31.96 + 20 / 111.195, h=427),
}
VARIANTS = [('A', 'SHADE', 'Fixed silhouette · four altitude tones'),
            ('B', 'SIZE', 'One tone · four altitude sizes'),
            ('C', 'TICKS', 'One tone · one to four altitude ticks'),
            ('D', 'SHADE + INDEX', 'Fixed silhouette · one vertical altitude index')]
PALETTES = {
    'light': dict(paper='#f7f6f0', sea='#e9eff4', land='#f1ecbb', coast='#676a62',
                  ink='#282d30', muted='#646b70', grid='#d4dcdd', rule='#cbd0ca',
                  air='#284e6b', ship='#746349', dot_air='#567d91', dot_ship='#9a8261',
                  levels=('#839aa3', '#607f91', '#3f627d', '#234665'), halo='#f7f6ed'),
    'dark': dict(paper='#19232e', sea='#232f3e', land='#665839', coast='#b6b09b',
                 ink='#eee7d4', muted='#b4b9b9', grid='#3e4951', rule='#46515a',
                 air='#bdd8e8', ship='#e2bd86', dot_air='#86aabd', dot_ship='#b99d70',
                 levels=('#94a8b0', '#a5becc', '#bfd8e6', '#e2eef5'), halo='#26333c'),
}


def destination(lon, lat, track, km):
    """Spherical forward geodesic, true degrees clockwise from north."""
    p, b, d = math.radians(lat), math.radians(track), km / 6371.0088
    q = math.asin(math.sin(p) * math.cos(d) + math.cos(p) * math.sin(d) * math.cos(b))
    l = math.radians(lon) + math.atan2(math.sin(b) * math.sin(d) * math.cos(p),
                                     math.cos(d) - math.sin(p) * math.sin(q))
    return ((math.degrees(l) + 180) % 360 - 180, math.degrees(q))


def bearing(a, b):
    p, q = math.radians(a[1]), math.radians(b[1])
    d = math.radians(b[0] - a[0])
    return math.degrees(math.atan2(math.sin(d) * math.cos(q),
                                   math.cos(p) * math.sin(q) - math.sin(p) * math.cos(q) * math.cos(d))) % 360


def distance(a, b):
    p, q = math.radians(a[1]), math.radians(b[1])
    return 2 * 6371.0088 * math.asin(min(1, math.sqrt(math.sin((q-p)/2)**2 +
        math.cos(p)*math.cos(q)*math.sin(math.radians(b[0]-a[0])/2)**2)))


def in_view(t, name):
    v = VIEWS[name]
    return v['west'] <= t['lon'] <= v['east'] and v['south'] <= t['lat'] <= v['north']


@lru_cache(None)
def coast(world=False):
    data = (ROOT / ('web/public/coast/world.bin' if world else 'Resources/ownchart-coast.bin')).read_bytes()
    assert data[:4] == b'OCST'
    version, count = struct.unpack_from('<HH', data, 4)
    assert version == 1
    result, cursor = [], 8
    for _ in range(count):
        n, = struct.unpack_from('<H', data, cursor)
        cursor += 2
        ring = [tuple(v / 100 for v in struct.unpack_from('<hh', data, cursor + i * 4)) for i in range(n)]
        cursor += n * 4
        result.append(ring)
    assert cursor == len(data)
    return result


@lru_cache(None)
def land_rings():
    return [(min(x for x,y in r), max(x for x,y in r), min(y for x,y in r),
             max(y for x,y in r), r) for r in coast(True)]


def on_land(lon, lat):
    # Exact polygon test: a coarse land raster misclassifies nearshore vessels.
    inside=False
    for west,east,south,north,ring in land_rings():
        if not (west<=lon<=east and south<=lat<=north):
            continue
        a,b=ring[-1]
        for x,y in ring:
            if (y>lat)!=(b>lat) and lon<(a-x)*(lat-y)/(b-y)+x:
                inside=not inside
            a,b=x,y
    return inside


def make_fixture():
    rng = random.Random(9102026)
    tracks = []

    def add(kind, typ, lon, lat, alt, speed, track, name=None, **extra):
        n = sum(t['kind'] == kind for t in tracks) + 1
        tracks.append(dict(id=f'{kind}-{n:03}', kind=kind, type=typ,
                           callsign=name or (f'SIM{n:03}' if kind == 'air' else f'VESSEL {n:03}'),
                           lon=round(lon, 6), lat=round(lat, 6), altitude_ft=alt,
                           speed_kt=speed, track_deg=round(track % 360, 1), **extra))

    # Final approach to approximate runway 21 true axis: northeast to southwest.
    for typ, km, alt, spd, name in [('narrowbody', 5.0, 1100, 145, 'QFA581'),
                                  ('heavy', 13.5, 2600, 170, 'SIA213'),
                                  ('narrowbody', 19.0, 4500, 205, 'QFA642')]:
        lon, lat = destination(115.967, -31.941, 29, km)
        add('air', typ, lon, lat, alt, spd, 209, name, phase='arrival 21', selected=name == 'QFA642')
    # Departures southwest, then southeast; 06/24 axis and local Jandakot traffic.
    for row in [('regional', 115.929, -32.002, 2400, 185, 209, 'SKP812', 'departure 21'),
                ('bizjet', 116.077, -32.055, 7800, 270, 125, 'VH-LNX', 'departure turn'),
                ('narrowbody', 116.142, -31.849, 6200, 245, 242, 'VOZ684', 'arrival 24 axis'),
                ('ga', 115.864, -32.073, 1600, 100, 65, 'VH-ABC', 'Jandakot local'),
                ('ga', 115.939, -32.116, 1200, 95, 240, 'VH-JKT', 'Jandakot local'),
                ('helicopter', 115.733, -31.912, 900, 90, 175, 'POL61', 'coastal transit'),
                ('heavy', 115.665, -31.812, 37000, 450, 130, 'QFA10', 'overflight')]:
        typ, lon, lat, alt, spd, trk, name, phase = row
        add('air', typ, lon, lat, alt, spd, trk, name, phase=phase)
    for row in [('cargo', 115.665, -31.970, 16, 150, 'PACIFIC STAR'),
                ('tanker', 115.681, -32.112, 10, 350, 'WESTERN DAWN'),
                ('passenger', 115.614, -32.026, 22, 70, 'ROTTNEST EXPRESS'),
                ('fishing', 115.626, -31.865, 6, 310, 'FV MARLIN'),
                ('sail', 115.710, -32.020, 5, 285, 'SEA BREEZE'),
                ('tug', 115.736, -32.067, 7, 285, 'SVITZER 3'),
                ('cargo', 115.595, -31.920, 13, 165, 'CAPE MERIDIAN'),
                ('fishing', 115.705, -31.797, 4, 210, 'FV SOUTHERN')]:
        typ, lon, lat, spd, trk, name = row
        add('ship', typ, lon, lat, None, spd, trk, name, selected=name == 'PACIFIC STAR')

    def fill_routes(kind, routes, count, exclude, australian=False):
        made, attempts = 0, 0
        while made < count:
            attempts += 1
            assert attempts < 20000
            route = routes[rng.randrange(len(routes))]
            a, b = route[0], route[1]
            if rng.random() < .5:
                a, b = b, a
            t = rng.uniform(.07, .93)
            lon, lat = destination(*a, bearing(a, b), distance(a, b)*t)
            lon += rng.uniform(-.5, .5)
            lat += rng.uniform(-.4, .4)
            pt = dict(lon=lon, lat=lat)
            if in_view(pt, exclude) or not in_view(pt, 'global'):
                continue
            if australian and not in_view(pt, 'australia'):
                continue
            if kind == 'ship' and on_land(lon, lat):
                continue
            if kind == 'air':
                # Long ocean corridors use airliners, short corridors allow GA/rotor.
                types = AIR[:4] if distance(a, b) > 1600 else AIR
                typ = rng.choices(types, weights=[25, 43, 18, 9, 3, 2][:len(types)])[0]
                alt = rng.choice({'heavy':[33000, 35000, 37000, 39000], 'narrowbody':[31000, 35000, 37000],
                                  'regional':[14000, 18000, 23000], 'bizjet':[28000, 39000, 41000],
                                  'ga':[3500, 5500, 7500], 'helicopter':[800, 1500, 2500]}[typ])
                spd = rng.randint(*{'heavy':(440,490), 'narrowbody':(420,470), 'regional':(230,310),
                                   'bizjet':(360,460), 'ga':(90,145), 'helicopter':(85,125)}[typ])
                add(kind, typ, lon, lat, alt, spd, bearing((lon,lat), b))
            else:
                # Offshore routes primarily merchant shipping; coastal short legs mix all six.
                types = SEA[:3] if distance(a, b) > 1000 else SEA
                typ = rng.choice(types)
                spd = rng.randint(*{'tanker':(10,16),'cargo':(12,21),'passenger':(16,25),
                                   'fishing':(3,9),'sail':(3,8),'tug':(5,12)}[typ])
                add(kind, typ, lon, lat, None, spd, bearing((lon,lat), b))
            made += 1

    aus_air = [((116,-32),(151,-34)), ((145,-38),(153,-27)), ((151,-34),(153,-27)),
               ((116,-32),(122,-18)), ((116,-32),(131,-12)), ((139,-35),(145,-38)),
               ((134,-24),(131,-12)), ((145,-38),(147,-43)), ((151,-34),(146,-19)),
               ((115,-28),(118,-25)), ((121,-30),(123,-27))]
    aus_sea = [((113,-31),(110,-23)), ((114,-35),(126,-36)), ((128,-36),(136,-38)),
               ((139,-40),(149,-40)), ((153,-35),(156,-28)), ((153,-26),(148,-18)),
               ((123,-16),(127,-12)), ((133,-11),(140,-10)), ((153,-34),(155,-31))]
    fill_routes('air', aus_air, 30, 'perth', True)
    fill_routes('ship', aus_sea, 17, 'perth', True)
    air_routes = [((-123,49),(-118,34)), ((-122,38),(-74,41)), ((-118,34),(-97,33)),
                  ((-87,42),(-74,41)), ((-74,41),(-80,26)), ((-74,41),(-.5,51)),
                  ((-5,54),(12,50)), ((2,49),(13,42)), ((-4,40),(8,50)),
                  ((12,50),(29,41)), ((29,41),(55,25)), ((55,25),(73,19)),
                  ((77,29),(103,1)), ((103,1),(114,22)), ((114,22),(140,36)),
                  ((127,38),(140,36)), ((117,40),(121,31)), ((103,1),(101,14)),
                  ((-47,-24),(-43,-23)), ((-74,5),(-70,-33)), ((18,-34),(28,-26)),
                  ((31,30),(37,-1)), ((-157,21),(-122,38)), ((174,-37),(172,-43))]
    sea_routes = [((-68,38),(-10,48)), ((-5,49),(3,56)), ((-15,32),(-10,45)),
                  ((-30,-20),(-15,5)), ((-77,28),(-60,38)), ((-130,34),(-150,30)),
                  ((140,28),(160,34)), ((128,28),(135,33)), ((120,20),(117,11)),
                  ((112,6),(118,17)), ((65,10),(88,5)), ((57,22),(67,15)),
                  ((43,13),(53,13)), ((5,-30),(15,-38)), ((-48,-30),(-40,-15)),
                  ((-82,8),(-90,0)), ((145,-5),(161,0)), ((7,37),(18,34))]
    fill_routes('air', air_routes, 260, 'australia')
    fill_routes('ship', sea_routes, 175, 'australia')
    return dict(schema=1, synthetic=True, seed=9102026,
                notes=['Design fixture, not live ADS-B/AIS or a navigation chart.',
                       'Nested subsets: global 300 air/200 sea, Australia 40/25, Perth 10/8.',
                       'Perth true-track axes approximately 029/209 and 062/242; illustrative arrivals/departures, not cleared procedures.',
                       'Altitude is feet AMSL; data blocks divide feet by 100, not pressure flight levels. Speed is ground speed in knots.'],
                tracks=tracks)


def band(alt):
    # One fixed scale across zooms: useful low-level separation around Perth,
    # then regional cruise and upper-air traffic. These are bins, not exact height.
    return sum(alt >= x for x in (2000, 10000, 30000))


@lru_cache(None)
def font(size, mono=False):
    paths = (['/System/Library/Fonts/Menlo.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf']
             if mono else ['/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'])
    for path in paths:
        if Path(path).exists():
            return ImageFont.truetype(path, round(size*S))
    raise RuntimeError('Install Helvetica/DejaVu Sans and Menlo/DejaVu Sans Mono.')


class Canvas:
    def __init__(self, width, height, background):
        self.im = Image.new('RGB', (width*S, height*S), background)
        self.d = ImageDraw.Draw(self.im)

    def line(self, pts, color, width=1):
        self.d.line([(round(x*S), round(y*S)) for x,y in pts], fill=color, width=max(1,round(width*S)), joint='curve')

    def poly(self, pts, fill, outline=None, width=.8):
        self.d.polygon([(round(x*S),round(y*S)) for x,y in pts], fill=fill)
        if outline:
            self.line(pts+[pts[0]], outline, width)

    def rect(self, box, fill, outline=None, width=1):
        self.d.rectangle(tuple(round(v*S) for v in box), fill=fill, outline=outline, width=round(width*S))

    def circle(self, x, y, r, fill, outline=None, width=.8):
        self.d.ellipse(tuple(round(v*S) for v in (x-r,y-r,x+r,y+r)), fill=fill, outline=outline, width=max(1,round(width*S)))

    def text(self, x, y, value, color, size=12, mono=False, anchor='la', halo=None):
        self.d.text((round(x*S),round(y*S)), value, font=font(size,mono), fill=color, anchor=anchor,
                    stroke_width=round(S*1.7) if halo else 0, stroke_fill=halo)

    def save(self, path):
        self.im.resize((self.im.width//S,self.im.height//S), Image.Resampling.LANCZOS).save(path)

    def copy(self):
        copy=Canvas.__new__(Canvas)
        copy.im=self.im.copy()
        copy.d=ImageDraw.Draw(copy.im)
        return copy


# Real planform families, nose up. Wings/tail only on aircraft; ships have a
# pointed bow, blunt stern and deck marks, never lateral aircraft-like appendages.
SHAPES = {
    'heavy': [(0,-1),(.13,-.77),(.14,-.3),(.88,.12),(.9,.35),(.14,.06),(.13,.69),(.4,.91),(.4,1),(0,.83),(-.4,1),(-.4,.91),(-.13,.69),(-.14,.06),(-.9,.35),(-.88,.12),(-.14,-.3),(-.13,-.77)],
    'narrowbody': [(0,-1),(.1,-.76),(.1,-.28),(.7,.15),(.7,.31),(.1,.05),(.09,.7),(.29,.91),(.28,1),(0,.85),(-.28,1),(-.29,.91),(-.09,.7),(-.1,.05),(-.7,.31),(-.7,.15),(-.1,-.28),(-.1,-.76)],
    'regional': [(0,-1),(.11,-.8),(.12,-.25),(.8,-.15),(.8,.06),(.11,.06),(.1,.7),(.34,.8),(.34,.94),(0,.86),(-.34,.94),(-.34,.8),(-.1,.7),(-.11,.06),(-.8,.06),(-.8,-.15),(-.12,-.25),(-.11,-.8)],
    'bizjet': [(0,-1),(.1,-.6),(.1,-.05),(.6,.3),(.6,.43),(.12,.22),(.16,.55),(.11,.76),(.4,.85),(.4,1),(0,.9),(-.4,1),(-.4,.85),(-.11,.76),(-.16,.55),(-.12,.22),(-.6,.43),(-.6,.3),(-.1,-.05),(-.1,-.6)],
    'ga': [(0,-1),(.1,-.8),(.1,-.35),(.9,-.35),(.9,-.12),(.1,-.12),(.07,.65),(.37,.65),(.37,.81),(0,.8),(-.37,.81),(-.37,.65),(-.07,.65),(-.1,-.12),(-.9,-.12),(-.9,-.35),(-.1,-.35),(-.1,-.8)],
    'helicopter': [(0,-.75),(.22,-.52),(.22,-.02),(.08,.18),(.06,.85),(.3,.9),(.3,1),(-.3,1),(-.3,.9),(-.06,.85),(-.08,.18),(-.22,-.02),(-.22,-.52)],
    'tanker': [(0,-1),(.31,-.64),(.31,.88),(-.31,.88),(-.31,-.64)],
    'cargo': [(0,-1),(.36,-.53),(.36,.88),(-.36,.88),(-.36,-.53)],
    'passenger': [(0,-1),(.27,-.66),(.27,.73),(.18,.91),(-.18,.91),(-.27,.73),(-.27,-.66)],
    'fishing': [(0,-.88),(.36,-.34),(.30,.7),(-.3,.7),(-.36,-.34)],
    'sail': [(0,-1),(.22,-.35),(.18,.65),(0,.92),(-.18,.65),(-.22,-.35)],
    'tug': [(0,-.65),(.43,-.29),(.43,.47),(.26,.66),(-.26,.66),(-.43,.47),(-.43,-.29)],
}


def glyph(c, x, y, typ, trk, size, color, p, variant, alt=0):
    angle = math.radians(trk)
    b = band(alt)
    if typ in AIR:
        if variant in ('A','D'):
            color = p['levels'][b]
        if variant == 'B':
            size *= (.78, 1.03, 1.28, 1.52)[b]

    def tx(pt):
        u,v = pt
        return (x+size*(u*math.cos(angle)-v*math.sin(angle)),
                y+size*(u*math.sin(angle)+v*math.cos(angle)))

    c.poly([tx(pt) for pt in SHAPES[typ]], color,
           p['air'] if typ in AIR and variant == 'D' else None, .5)
    if typ == 'helicopter':
        c.line([tx((-.75,-.28)),tx((.75,-.28))], color, 1.3)
        c.line([tx((-.55,-.8)),tx((.55,.24))], color, 1.1)
        c.circle(*tx((0,-.28)),size*.12,p['halo'])
    elif typ == 'regional':
        for u in (-.43,.43):
            c.line([tx((u-.16,-.37)),tx((u+.16,-.37))],color,.9)
            c.line([tx((u,-.46)),tx((u,-.05))],color,1.4)
    elif typ in SEA:
        # Negative-space decks preserve hull silhouettes at regional density.
        if typ == 'tanker':
            for v in (-.35,.02,.39):
                c.circle(*tx((0,v)),size*.14,p['sea'])
        elif typ == 'cargo':
            for v in (-.3,.1,.5):
                c.poly([tx(pt) for pt in [(-.19,v-.10),(.19,v-.10),(.19,v+.1),(-.19,v+.1)]],p['sea'])
        elif typ == 'passenger':
            c.line([tx((0,-.5)),tx((0,.57))],p['sea'],max(.7,size*.16))
        elif typ == 'sail':
            c.poly([tx(pt) for pt in [(0,-.65),(.55,.43),(0,.2)]],color,p['sea'],.55)
        elif typ == 'fishing':
            c.line([tx((-.23,.31)),tx((.23,.31))],p['sea'],1)
            c.circle(*tx((0,-.17)),size*.14,p['sea'])
        else:
            c.circle(*tx((0,0)),size*.23,p['sea'])
    if typ in AIR and variant == 'C':
        for i in range(b+1):
            c.line([(x+size+2,y+4-i*3),(x+size+6,y+4-i*3)],color,1)
    elif typ in AIR and variant == 'D':
        gx = x+size+3
        c.line([(gx,y-5),(gx,y+5)],p['muted'],.45)
        gy = y+4-b*8/3
        c.line([(gx-1.8,gy),(gx+1.8,gy)],p['air'],1.25)


def project(lon, lat, name):
    v = VIEWS[name]
    return ((lon-v['west'])/(v['east']-v['west'])*W, (v['north']-lat)/(v['north']-v['south'])*v['h'])


def basemap(name, p):
    v = VIEWS[name]
    c = Canvas(W,v['h'],p['sea'])
    for ring in coast(name == 'global'):
        # OCST world rings are already split at the dateline.
        if max(x for x,y in ring)<v['west'] or min(x for x,y in ring)>v['east'] or max(y for x,y in ring)<v['south'] or min(y for x,y in ring)>v['north']:
            continue
        if max(x for x,y in ring)-min(x for x,y in ring)>300:
            continue
        pts = [project(x,y,name) for x,y in ring]
        c.poly(pts,p['land'],p['coast'],.6 if name!='perth' else .9)
    if name != 'perth':
        step = 30 if name=='global' else 10
        for lon in range(-180,181,step):
            x,_ = project(lon,0,name)
            c.line([(x,0),(x,v['h'])],p['grid'],.4)
        for lat in range(-60,91,step):
            _,y = project(0,lat,name)
            c.line([(0,y),(W,y)],p['grid'],.4)
        # Smooth nested pressure ellipses with inline values; pure illustration.
        systems = [(80,-42,35,19,1028),(-30,48,32,18,996)] if name=='global' else [(134,-48,24,14,1032)]
        for lon,lat,rx,ry,val in systems:
            for k in range(3):
                pts = [project(lon+(rx+k*6)*math.cos(t),lat+(ry+k*4)*math.sin(t)+.7*math.sin(3*t),name)
                       for t in [i*2*math.pi/240 for i in range(241)]]
                c.line(pts,p['ink'],.7 if name=='global' else 1.0)
                q=pts[45 if name=='global' else 52]
                if 20<q[0]<W-35 and 15<q[1]<v['h']-20:
                    c.text(*q,str(val-k*4),p['ink'],10,anchor='mm',halo=p['sea'])
            x,y=project(lon,lat,name)
            if 10<x<W-20 and 20<y<v['h']-20:
                c.text(x,y-12,'H' if val>1015 else 'L',p['ink'],16,anchor='mm')
                c.line([(x-3,y),(x+3,y)],p['ink'],.8)
                c.line([(x,y-3),(x,y+3)],p['ink'],.8)
                c.text(x,y+4,str(val+3),p['ink'],9,anchor='ma')
    else:
        # Same broad synoptic curvature: just one isobar crosses this 60 km crop.
        c.line([(x,43+27*(x/W)**2) for x in range(-10,W+10,3)],p['ink'],.85)
        c.text(65,44,'1016',p['ink'],10,anchor='mm',halo=p['sea'])
        for lon,lat,angle,length,label in [(115.967,-31.941,29,3.44,'PER'),(115.964,-31.944,62,2.16,''),
                                           (115.881,-32.097,62,1.39,'JAD')]:
            ends = [project(*destination(lon,lat,angle+b,length/2),name) for b in (0,180)]
            c.line(ends,p['muted'],2)
            if label:
                x,y=project(lon,lat,name)
                c.text(x+9,y+5,label,p['muted'],10,halo=p['land'])
        for lon,lat,label in [(115.75,-32.056,'Fremantle'),(115.535,-32.0,'Rottnest')]:
            x,y=project(lon,lat,name)
            if 0<x<W-65 and 0<y<v['h']-20:
                c.text(x+4,y+5,label,p['muted'],10,halo=p['sea'])
    # A geographic scale anchored at the centre latitude, not a decorative line.
    km = {'global':4000,'australia':1000,'perth':10}[name]
    midlat=(v['north']+v['south'])/2
    end=destination((v['east']+v['west'])/2,midlat,90,km)
    dx=project(*end,name)[0]-W/2
    y=v['h']-17
    c.line([(16,y-3),(16,y),(16+dx,y),(16+dx,y-3)],p['ink'],1)
    c.text(16,y-15,f'{km:,} km',p['ink'],10,halo=p['sea'])
    c.text(W-25,v['h']-27,'N',p['muted'],11,anchor='ra',halo=p['sea'])
    c.line([(W-17,v['h']-16),(W-17,v['h']-27)],p['muted'],.8)
    c.poly([(W-17,v['h']-29),(W-19.5,v['h']-24),(W-14.5,v['h']-24)],p['muted'])
    return c


def panel(name, variant, p, tracks, base=None):
    c = base.copy() if base else basemap(name,p)
    visible = [t for t in tracks if in_view(t,name)]
    if name == 'global':
        # Bin counts independently; fixed centroid prevents between-type averaging.
        for kind in ('ship','air'):
            bins = {}
            for t in visible:
                if t['kind'] != kind:
                    continue
                x,y=project(t['lon'],t['lat'],name)
                bins.setdefault((int(x//6),int(y//6)),[]).append((x,y))
            for pts in bins.values():
                x=sum(a for a,b in pts)/len(pts)
                y=sum(b for a,b in pts)/len(pts)
                r=min(4.0,1.65+.65*math.log2(len(pts)))
                if kind=='air':
                    c.circle(x,y,r,p['dot_air'])
                else:
                    c.rect((x-r,y-r,x+r,y+r),p['dot_ship'])
        return c
    # Draw all vectors first. True endpoint may sit inside a regional glyph.
    for t in visible:
        x,y=project(t['lon'],t['lat'],name)
        minutes=2 if t['kind']=='air' else 30
        endpoint=destination(t['lon'],t['lat'],t['track_deg'],t['speed_kt']*minutes/60*1.852)
        ex,ey=project(*endpoint,name)
        color=p['air'] if t['kind']=='air' else p['ship']
        c.line([(x,y),(ex,ey)],color,.7)
        if name=='perth':
            angle=math.atan2(ey-y,ex-x)
            a,b=1.8*math.sin(angle),1.8*math.cos(angle)
            c.line([(ex-a,ey+b),(ex+a,ey-b)],color,.8)
    for t in visible:
        x,y=project(t['lon'],t['lat'],name)
        size=6 if name=='australia' else 9
        glyph(c,x,y,t['type'],t['track_deg'],size,p['air'] if t['kind']=='air' else p['ship'],p,variant,t['altitude_ft'] or 0)
    if name == 'perth':
        for t in visible:
            if not t.get('selected'):
                continue
            x,y=project(t['lon'],t['lat'],name)
            color=p['air'] if t['kind']=='air' else p['ship']
            c.circle(x,y,14,None,color,.7)
            if t['kind']=='air':
                label=f"{t['callsign']} {round(t['altitude_ft']/100):03} {t['speed_kt']:03}"
                tx,ty=x-font(12,True).getlength(label)/S-26,y+10
                c.line([(x-12,y+9),(x-23,ty+7)],color,.7)
            else:
                label=f"{t['callsign']} {t['speed_kt']:02}kt"
                tx,ty=x+21,y+10
                c.line([(x+11,y+9),(tx-3,ty+7)],color,.7)
            c.text(tx,ty,label,color,12,True,halo=p['halo'])
    return c


def render(theme, tracks):
    p=PALETTES[theme]
    margin,gap,top=24,16,141
    width=margin*2+W*4+gap*3
    rows=[('global','GLOBAL', '300 aircraft / 200 ships · density'),
          ('australia','AUSTRALIA', '40 aircraft / 25 ships · types'),
          ('perth','PERTH · 60 km', '10 aircraft / 8 ships · two selected')]
    height=top+sum(VIEWS[n]['h']+38 for n,_,_ in rows)+165
    sheet=Canvas(width,height,p['paper'])
    sheet.text(margin,17,'TRAFFIC / TYPE · ALTITUDE · SPEED',p['ink'],23)
    sheet.text(width-margin,23,f'{theme.upper()}   /   SYNTHETIC STUDY   /   09 OCT 2026',p['muted'],12,True,anchor='ra')
    sheet.line([(margin,54),(width-margin,54)],p['rule'])
    for i,(letter,title,note) in enumerate(VARIANTS):
        x=margin+i*(W+gap)
        sheet.text(x,66,f'{letter}   {title}',p['ink'],18)
        sheet.text(x,91,note,p['muted'],12)
        for j,alt in enumerate((1000,6000,20000,37000)):
            gx=x+22+j*131
            glyph(sheet,gx,122,'narrowbody',25,8,p['air'],p,letter,alt)
            sheet.text(gx+20,115,['<2k','2–10k','10–30k','≥30k ft'][j],p['muted'],11,True)
    y=top
    for name,title,note in rows:
        base=basemap(name,p)
        for i,(letter,_,_) in enumerate(VARIANTS):
            x=margin+i*(W+gap)
            sheet.text(x,y+8,title,p['ink'],12)
            sheet.text(x+W,y+8,note,p['muted'],11,anchor='ra')
            panel_im=panel(name,letter,p,tracks,base)
            panel_im.save(OUT/f'{theme}-{letter.lower()}-{name}.png')
            sheet.im.paste(panel_im.im,(x*S,(y+30)*S))
        y+=VIEWS[name]['h']+38
    y+=12
    sheet.line([(margin,y),(width-margin,y)],p['rule'])
    y+=15
    # Common family key at actual close-scale size, not oversized marketing icons.
    names={'heavy':'Heavy','narrowbody':'Narrowbody','regional':'Regional / prop','bizjet':'Bizjet','ga':'GA','helicopter':'Helicopter',
           'tanker':'Tanker','cargo':'Cargo','passenger':'Passenger','fishing':'Fishing','sail':'Sail / pleasure','tug':'Tug / other'}
    for i,typ in enumerate(AIR+SEA):
        x=margin+i*216
        glyph(sheet,x+13,y+12,typ,0,9,p['air'] if typ in AIR else p['ship'],p,'',18000)
        sheet.text(x+31,y+6,names[typ],p['muted'],12)
    y+=44
    sheet.line([(margin+4,y+8),(margin+75,y+8)],p['air'],.8)
    sheet.line([(margin+75,y+5),(margin+75,y+11)],p['air'],.8)
    glyph(sheet,margin+10,y+8,'narrowbody',90,7,p['air'],p,'',18000)
    sheet.text(margin+88,y,'AIR 2 min   /   SEA 30 min   ·   true distance at each zoom',p['muted'],12)
    sheet.circle(795,y+8,2.6,p['dot_air'])
    sheet.rect((818,y+5.4,823.2,y+10.6),p['dot_ship'])
    sheet.text(835,y,'Global density: aircraft / ships · larger = more tracks',p['muted'],12)
    sheet.text(1430,y,'SELECTED  callsign · altitude ×100 ft AMSL · ground speed kt',p['muted'],12,True)
    sheet.text(margin,y+33,'Natural Earth coast · Bureau plate · illustrative isobars and traffic · no live feed',p['muted'],11)
    sheet.text(width-margin,y+33,'Same tracks · identical global density in A–D · north up',p['muted'],11,anchor='ra')
    path=OUT/f'traffic-sheet-{theme}.png'
    sheet.save(path)
    print(path.relative_to(ROOT))


def check(data):
    """Fixture, geometry and physical invariants; never a product test suite."""
    assert data['synthetic'] is True
    tracks=data['tracks']
    assert len({t['id'] for t in tracks}) == 500
    for name,expected in [('global',{'air':300,'ship':200}),('australia',{'air':40,'ship':25}),('perth',{'air':10,'ship':8})]:
        got=Counter(t['kind'] for t in tracks if in_view(t,name))
        assert got==expected,(name,got)
        for kind,types in [('air',AIR),('ship',SEA)]:
            assert set(types)=={t['type'] for t in tracks if t['kind']==kind and in_view(t,name)}
    for t in tracks:
        assert 0 <= t['track_deg'] < 360 and 0<t['speed_kt']<=500
        if t['kind']=='air':
            assert 0<t['altitude_ft']<=45000
        else:
            assert t['altitude_ft'] is None
            assert not on_land(t['lon'],t['lat']),t
        minutes=2 if t['kind']=='air' else 30
        km=t['speed_kt']*minutes/60*1.852
        dest=destination(t['lon'],t['lat'],t['track_deg'],km)
        assert abs(distance((t['lon'],t['lat']),dest)-km)<1e-7
        if t.get('phase')=='arrival 21':
            assert abs(bearing((t['lon'],t['lat']),(115.967,-31.941))-t['track_deg'])<1
        if t.get('phase')=='departure 21':
            assert abs(bearing((115.967,-31.941),(t['lon'],t['lat']))-t['track_deg'])<3
        if t.get('phase')=='arrival 24 axis':
            assert abs(bearing((t['lon'],t['lat']),(115.964,-31.944))-t['track_deg'])<5
        if t.get('phase')=='Jandakot local':
            assert distance((t['lon'],t['lat']),(115.881,-32.097))<7
    assert abs(distance((0,0),destination(0,0,90,27.78))-27.78)<1e-8  # 450 kt × 2 min
    assert abs(distance((0,0),destination(0,0,0,18.52))-18.52)<1e-8  # 20 kt × 30 min
    assert [band(v) for v in (1999,2000,9999,10000,29999,30000)]==[0,1,1,2,2,3]
    assert tracks==make_fixture()['tracks'],'Fixture changed without updating deterministic generator'
    print('PASS: 500 unique tracks; nested counts; all 12 types at all zooms; ships offshore; vector distances; Perth arrival/departure axes; altitude boundaries; deterministic fixture.', flush=True)


def check_images():
    from PIL import ImageChops
    sheets=[]
    for theme in PALETTES:
        sheet=Image.open(OUT/f'traffic-sheet-{theme}.png')
        assert sheet.size == (2656,1549),sheet.size
        sheet.verify()
        sheets.append(Image.open(OUT/f'traffic-sheet-{theme}.png'))
        for name in VIEWS:
            panels=[]
            for variant,_,_ in VARIANTS:
                im=Image.open(OUT/f'{theme}-{variant.lower()}-{name}.png')
                assert im.size==(W,VIEWS[name]['h'])
                im.verify()
                panels.append(Image.open(OUT/f'{theme}-{variant.lower()}-{name}.png'))
            for i in range(1,4):
                different=ImageChops.difference(panels[0],panels[i]).getbbox() is not None
                assert different == (name!='global'),(theme,name,i)
    assert ImageChops.difference(*sheets).getbbox() is not None
    print('PASS: 24 panels + 2 sheets; valid PNG dimensions; light/dark differ; regional/close variants differ; global deliberately identical.')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check',action='store_true',help='validate only')
    parser.add_argument('--make-fixture',action='store_true',help='rebuild the committed synthetic fixture')
    parser.add_argument('--check-images',action='store_true',help='validate the existing 26 PNG outputs too')
    args=parser.parse_args()
    fixture=HERE/'fixture.json'
    if args.make_fixture:
        fixture.write_text(json.dumps(make_fixture(),indent=2)+'\n')
    data=json.loads(fixture.read_text())
    check(data)
    if args.check_images:
        check_images()
    if not args.check:
        OUT.mkdir(parents=True,exist_ok=True)
        for theme in PALETTES:
            render(theme,data['tracks'])


if __name__=='__main__':
    main()
