#!/usr/bin/env python3
"""Experimental, illustrative Bureau PDF vector motion; not a forecast product.

Prototype dependencies: PyMuPDF, numpy, scipy and Pillow. It deliberately leaves
ambiguous contour topology unmatched instead of pairing different isobars.
"""
from __future__ import annotations
import argparse
from dataclasses import dataclass, field
import json
from pathlib import Path
import math
import fitz
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.optimize import linear_sum_assignment

ORIGINS = [(39.332,560.651),(273.395675,560.570556),(38.455596,374.839644),(273.371993,374.754531),(39.332,189.364333),(273.237106,189.104079),(38.510101,3.870864),(273.511581,2.772048)]
MAP_SIZE = (223.994,168.094)
SEA = (233,241,247)
LAND = (249,240,175)
INK = (37,38,36)

@dataclass
class Curve:
    points: np.ndarray
    ids: list[int]
    pressure: int | None = None
    reason: str = 'no pressure label'
    kind: str = 'isobar'
    closed: bool = False
    labels: list[np.ndarray] = field(default_factory=list)

    @property
    def length(self):
        return float(np.linalg.norm(np.diff(self.points,axis=0),axis=1).sum())


def flatten(items, subdivisions=14):
    paths=[]
    for item in items:
        op=item[0]
        if op=='re':
            r=item[1];q=np.array([[r.x0,r.y0],[r.x1,r.y0],[r.x1,r.y1],[r.x0,r.y1],[r.x0,r.y0]])
        elif op in ('l','c'):
            p=np.array([[v.x,v.y] for v in item[1:]])
            if op=='l':q=p
            else:
                t=np.linspace(0,1,subdivisions)[:,None]
                q=(1-t)**3*p[0]+3*(1-t)**2*t*p[1]+3*(1-t)*t*t*p[2]+t**3*p[3]
        else:continue
        if not paths or np.linalg.norm(paths[-1][-1]-q[0])>.02:paths.append(q)
        else:paths[-1]=np.vstack((paths[-1],q[1:]))
    return paths


def sampled(p, count=160):
    distance=np.r_[0,np.cumsum(np.linalg.norm(np.diff(p,axis=0),axis=1))]
    keep=np.r_[True,np.diff(distance)>1e-8];distance=distance[keep];p=p[keep]
    if len(p)<2:return np.repeat(p[:1],count,axis=0)
    t=np.linspace(0,distance[-1],count)
    return np.c_[np.interp(t,distance,p[:,0]),np.interp(t,distance,p[:,1])]


def crop_origin(page, panel):
    sy=page.rect.height/793.779
    return np.array([(39.332*page.rect.width/532.207+(ORIGINS[panel][0]-39.332)*sy)+1.25,
                     page.rect.height-(ORIGINS[panel][1]+170.594-1.25)*sy])


def rectangle_distance(p, box):
    return float(np.linalg.norm(np.maximum(np.maximum(np.array(box[:2])-p,p-np.array(box[2:])),0)))


def connect_label_gaps(curves, labels):
    # A printed pressure label interrupts its contour. Pair endpoints on
    # opposite sides of that label; a nearby closed contour is not a gap.
    for pressure,box in labels:
        centre=(np.array(box[:2])+np.array(box[2:]))/2
        candidates=[]
        for i,c in enumerate(curves):
            if c.closed:continue
            for side in (0,-1):
                p=c.points[side]
                if rectangle_distance(p,box)<=3.8 and np.linalg.norm(p-centre)<12:
                    candidates.append((i,side,p))
        scored=[]
        for ai,a in enumerate(candidates):
            for b in candidates[ai+1:]:
                if a[:2]==b[:2]:continue
                va=a[2]-centre;vb=b[2]-centre
                cos=float(va@vb/(np.linalg.norm(va)*np.linalg.norm(vb)+1e-8))
                if len(candidates)>2 and cos>-.15:continue
                score=np.linalg.norm(va)+np.linalg.norm(vb)+3*(cos+1)
                scored.append((score,a,b))
        if not scored:continue
        scored.sort(key=lambda z:z[0]);_,a,b=scored[0]
        # Ambiguous alternatives are retained for fading, never crossed.
        if len(scored)>1 and scored[1][0]-scored[0][0]<.25:continue
        ca,cb=curves[a[0]],curves[b[0]]
        if ca.pressure not in (None,pressure) or cb.pressure not in (None,pressure):continue
        pa=ca.points if a[1]==-1 else ca.points[::-1]
        pb=cb.points if b[1]==0 else cb.points[::-1]
        if a[0]==b[0]:
            ca.points=np.vstack((pa,pa[:1]));ca.closed=True;ca.pressure=pressure;ca.reason='label gap closes curve';ca.labels.append(centre)
        else:
            merged=Curve(np.vstack((pa,pb)),sorted(ca.ids+cb.ids),pressure,'opposed endpoints at printed pressure label',closed=False,labels=ca.labels+cb.labels+[centre])
            curves[a[0]]=merged;curves.pop(b[0])
    return curves


def infer_order(curves):
    # In this Bureau producer, paths are painted in ascending pressure order.
    # Infer only the single intervening 4hPa level between labelled bands.
    anchors=[]
    for c in curves:
        if c.pressure is not None:
            for i in c.ids:anchors.append((i,c.pressure))
    anchors.sort()
    if any(a[1]>b[1] for a,b in zip(anchors,anchors[1:])):return
    for c in curves:
        if c.pressure is not None:continue
        lo=[p for i,p in anchors if i<min(c.ids)];hi=[p for i,p in anchors if i>max(c.ids)]
        if not lo or not hi:continue
        if lo[-1]==hi[0]:
            c.pressure=lo[-1];c.reason='same labelled pressure band in PDF paint order'
        elif hi[0]-lo[-1]==8:
            c.pressure=lo[-1]+4;c.reason='single 4hPa level between labelled paint-order bands'


def join_exact(curves, tolerance=.035):
    changed=True
    while changed:
        changed=False
        for i in range(len(curves)):
            if curves[i].closed:continue
            for j in range(i+1,len(curves)):
                if curves[j].closed or curves[i].kind!=curves[j].kind:continue
                opts=[]
                for ai in (False,True):
                    for bj in (False,True):
                        a=curves[i].points[::-1] if ai else curves[i].points
                        b=curves[j].points[::-1] if bj else curves[j].points
                        opts.append((np.linalg.norm(a[-1]-b[0]),a,b))
                dist,a,b=min(opts,key=lambda z:z[0])
                if dist<tolerance:
                    curves[i].points=np.vstack((a,b[1:]));curves[i].ids+=curves[j].ids;curves.pop(j);changed=True;break
            if changed:break
    return curves


def extract(page, panel):
    draws=page.get_drawings()
    groups=[(i,d) for i,d in enumerate(draws) if d['type']=='s' and abs((d['width'] or 0)-.467)<.006 and sum(v[0]=='c' for v in d['items'])>50]
    start,group=groups[panel]
    end=next(i for i in range(start+1,len(draws)) if draws[i]['type']=='s' and abs((draws[i]['width'] or 0)-1.578)<.01)
    previous=0 if panel==0 else next(i+1 for i in range(groups[panel-1][0]+1,len(draws)) if draws[i]['type']=='s' and abs((draws[i]['width'] or 0)-1.578)<.01)
    offset=crop_origin(page,panel)
    labels=[];centre_values=[]
    frame=draws[end]['rect']
    for word in page.get_text('words'):
        if not word[4].isdigit() or not 950<=int(word[4])<=1060:continue
        box=np.array(word[:4]);centre=(box[:2]+box[2:])/2
        if not frame.contains(fitz.Point(*centre)):continue
        local=box-np.r_[offset,offset]
        if int(word[4])%4==0:labels.append((int(word[4]),local))
        else:centre_values.append((int(word[4]),(local[:2]+local[2:])/2))
    contours=[]
    for i,points in enumerate(flatten(group['items'])):
        contours.append(Curve(points-offset,[i],closed=np.linalg.norm(points[0]-points[-1])<.05))
    contours=connect_label_gaps(contours,labels)
    coast=[]
    for d in draws[previous:start]:
        if d['fill'] and .8<d['fill'][0]<.9:
            coast.extend(q-offset for q in flatten(d['items']))
    fronts=[];symbols=[];centres=[];markers=[]
    for di,d in enumerate(draws[start+1:end]):
        if d['type']=='s' and abs((d['width'] or 0)-1.31)<.01:
            parts=flatten(d['items']);kind='trough' if len(parts)>5 else 'front'
            for ci,q in enumerate(parts):fronts.append(Curve(q-offset,[di*100+ci],kind=kind,reason='front stroke'))
        elif d['type']=='s' and abs((d['width'] or 0)-.467)<.006 and all(q[0]=='l' for q in d['items']):
            for j in range(0,len(d['items'])-1,2):
                q=d['items'][j:j+2];markers.append(np.array([[v.x,v.y] for item in q for v in item[1:]]).mean(axis=0)-offset)
        elif d['type']=='f':
            paths=flatten(d['items']);r=d['rect'];centre=np.array([(r.x0+r.x1)/2,(r.y0+r.y1)/2])-offset
            ops=[v[0] for v in d['items']]
            if len(ops) in (6,12) and all(v=='l' for v in ops):
                kind='L' if len(ops)==6 else 'H'; value=min(centre_values,key=lambda v:np.linalg.norm(v[1]-centre),default=(None,None))[0]
                centres.append((kind,centre,value))
            else:
                for q in paths:symbols.append(Curve(q-offset,[di],kind='symbol',closed=True))
    # Closed unlabelled rings around an explicit H/L carry the nearest
    # multiple of four to that centre, ordered from the innermost ring.
    for kind,centre,value in centres:
        if value is None:continue
        ring_centre=min(markers,key=lambda q:np.linalg.norm(q-centre)) if markers else centre
        rings=[]
        for curve in contours:
            if not curve.closed:continue
            q=curve.points; x,y=ring_centre
            inside=False
            for i in range(len(q)-1):
                x1,y1=q[i];x2,y2=q[i+1]
                if ((y1>y)!=(y2>y)) and x<(x2-x1)*(y-y1)/(y2-y1)+x1:inside=not inside
            if inside:rings.append(curve)
        rings.sort(key=lambda c:c.length)
        first=(math.floor(value/4)*4 if kind=='H' else math.ceil(value/4)*4)
        for order,curve in enumerate(rings):
            expected=first+(-4 if kind=='H' else 4)*order
            if curve.pressure is None:
                curve.pressure=expected;curve.reason='nested closed contour around labelled '+kind
    infer_order(contours)
    fronts=join_exact(fronts)
    return {'curves':contours,'fronts':fronts,'symbols':symbols,'coast':coast,'centres':centres,'labels':labels,'offset':offset,'raw_subpaths':len(flatten(group['items']))}


def aligned(a,b):
    aa=sampled(a.points);bb=sampled(b.points)
    if a.closed and b.closed:
        options=[]
        for p in (bb,bb[::-1]):
            for shift in range(0,len(p),4):
                q=np.roll(p,shift,axis=0);options.append((float(np.linalg.norm(aa-q,axis=1).mean()),q))
        cost,bb=min(options,key=lambda z:z[0])
    else:
        if np.linalg.norm(aa[0]-bb[-1])+np.linalg.norm(aa[-1]-bb[0])<np.linalg.norm(aa[0]-bb[0])+np.linalg.norm(aa[-1]-bb[-1]):bb=bb[::-1]
        cost=float(np.linalg.norm(aa-bb,axis=1).mean())
    return cost,aa,bb


def match_curves(aa,bb, semantic=True):
    costs=np.full((len(aa),len(bb)),1e6);samples={}
    for i,a in enumerate(aa):
        for j,b in enumerate(bb):
            if a.kind!=b.kind or a.closed!=b.closed:continue
            if semantic and (a.pressure is None or a.pressure!=b.pressure):continue
            if min(a.length,b.length)/max(a.length,b.length,1)<(.25 if a.closed else .3):continue
            cost,pa,pb=aligned(a,b)
            maximum_travel = 45 if semantic else 22
            if cost>maximum_travel:continue
            costs[i,j]=cost;samples[i,j]=(pa,pb)
    matches=[]
    if not len(aa) or not len(bb):return matches,set(range(len(aa))),set(range(len(bb)))
    for i,j in zip(*linear_sum_assignment(costs)):
        score=costs[i,j]
        if score>=1e6:continue
        row=sorted(v for k,v in enumerate(costs[i]) if k!=j and v<1e6)
        col=sorted(v for k,v in enumerate(costs[:,j]) if k!=i and v<1e6)
        margin=3 if semantic else 2
        if (row and row[0]-score<margin) or (col and col[0]-score<margin):continue
        pa,pb=samples[i,j];matches.append((int(i),int(j),pa,pb,float(score)))
    return matches,set(range(len(aa)))-{m[0] for m in matches},set(range(len(bb)))-{m[1] for m in matches}


def curves_cross(first, second):
    p=first[:-1,None,:];r=first[1:,None,:]-p
    q=second[None,:-1,:];ss=second[None,1:,:]-q
    cross=lambda a,b:a[...,0]*b[...,1]-a[...,1]*b[...,0]
    denominator=cross(r,ss);delta=q-p
    with np.errstate(divide='ignore',invalid='ignore'):
        u=cross(delta,ss)/denominator;v=cross(delta,r)/denominator
    hit=(np.abs(denominator)>1e-7)&(u>1e-4)&(u<.9999)&(v>1e-4)&(v<.9999)
    if not hit.any():return False
    positions=p+u[...,None]*r
    inside=(positions[...,0]>0)&(positions[...,0]<MAP_SIZE[0])&(positions[...,1]>0)&(positions[...,1]<MAP_SIZE[1])
    return bool(np.any(hit&inside))


def reject_intermediate_crossings(a,b,matched):
    pairs,ua,ub=matched;rejected=[]
    changed=True
    while changed:
        changed=False
        for i,left in enumerate(pairs):
            for j in range(i+1,len(pairs)):
                right=pairs[j]
                if a[left[0]].pressure==a[right[0]].pressure:continue
                collision=False
                for t in (.25,.5,.75):
                    p=left[2]*(1-t)+left[3]*t;q=right[2]*(1-t)+right[3]*t
                    if a[left[0]].closed:p=np.vstack((p,p[:1]))
                    if a[right[0]].closed:q=np.vstack((q,q[:1]))
                    if curves_cross(p,q):collision=True;break
                if not collision:continue
                # The larger deformation is the less conservative match.
                remove=i if left[4]>right[4] else j
                item=pairs.pop(remove);ua.add(item[0]);ub.add(item[1])
                rejected.append({'source_ids':a[item[0]].ids,'destination_ids':b[item[1]].ids,'pressure':a[item[0]].pressure,'reason':'would cross a different-pressure contour during interpolation'})
                changed=True;break
            if changed:break
    return (pairs,ua,ub),rejected


def official(page,panel,size):
    # Render the complete official endpoint, with no vector omissions.
    offset=crop_origin(page,panel);rect=fitz.Rect(*offset,*(offset+MAP_SIZE));factor=5
    pix=page.get_pixmap(matrix=fitz.Matrix(factor,factor),clip=rect,alpha=False)
    image=Image.frombytes('RGB',(pix.width,pix.height),pix.samples).resize(size,Image.Resampling.LANCZOS)
    pixels=np.asarray(image).copy();r=pixels[:,:,0].astype(float);g=pixels[:,:,1].astype(float);b=pixels[:,:,2].astype(float)
    grey=(r>180)&(r<239)&(np.max(pixels,axis=2)-np.min(pixels,axis=2)<15)
    white=np.min(pixels,axis=2)>239
    pixels[grey]=LAND;pixels[white]=SEA
    return Image.fromarray(pixels)


def draw_line(draw,p,scale,width,alpha=1):
    if alpha<=0:return
    draw.line([tuple(v*scale) for v in p],fill=(*INK,int(255*alpha)),width=max(1,round(width*scale)),joint='curve')


def render(a,b,matches,t,size):
    supersample=3;scale=size[0]/MAP_SIZE[0]*supersample
    canvas=Image.new('RGB',(size[0]*supersample,size[1]*supersample),SEA);draw=ImageDraw.Draw(canvas)
    for p in a['coast']:
        if len(p)>2:draw.polygon([tuple(v*scale) for v in p],fill=LAND,outline=INK,width=max(1,round(.238*scale)))
    geography=canvas.copy()
    layer=Image.new('RGBA',canvas.size);ink=ImageDraw.Draw(layer)
    for name,width in [('curves',.467),('fronts',1.31),('symbols',.5)]:
        pairs,unA,unB=matches[name]
        for i,j,pa,pb,cost in pairs:
            points=pa*(1-t)+pb*t
            if name=='symbols':ink.polygon([tuple(v*scale) for v in points],fill=(*INK,255))
            else:
                if a[name][i].closed:points=np.vstack((points,points[:1]))
                draw_line(ink,points,scale,width)
        # Only unmatched geometry uses a brief departure/arrival fade.
        for source,ids,alpha in [(a,unA,max(0,1-t/.25)),(b,unB,max(0,(t-.75)/.25))]:
            if alpha<=0:continue
            for i in ids:
                points=source[name][i].points
                if name=='symbols':ink.polygon([tuple(v*scale) for v in points],fill=(*INK,round(255*alpha)))
                else:draw_line(ink,points,scale,width,alpha)
    canvas=Image.alpha_composite(canvas.convert('RGBA'),layer);draw=ImageDraw.Draw(canvas)
    font_path='/System/Library/Fonts/Supplemental/Arial Narrow.ttf'
    try:label_font=ImageFont.truetype(font_path,round(5.3*scale));centre_font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf',round(10*scale))
    except OSError:label_font=centre_font=ImageFont.load_default()
    # Keep type crisp; the pressure value comes from a verified label, never OCR.
    for i,j,pa,pb,cost in matches['curves'][0]:
        curve=a['curves'][i]
        if not curve.labels or curve.pressure is None:continue
        points=pa*(1-t)+pb*t
        for source_label in curve.labels[:2]:
            index=int(np.argmin(np.linalg.norm(pa-source_label,axis=1)));pos=points[index]*scale;text=str(curve.pressure)
            box=draw.textbbox(tuple(pos),text,font=label_font,anchor='mm')
            sample=(min(canvas.width-1,max(0,int(pos[0]))),min(canvas.height-1,max(0,int(pos[1]))))
            background=geography.getpixel(sample)
            draw.rectangle((box[0]-2,box[1]-1,box[2]+2,box[3]+1),fill=background)
            draw.text(tuple(pos),text,font=label_font,anchor='mm',fill=INK)
    for kind,point,value in a['centres']:
        targets=[c for c in b['centres'] if c[0]==kind]
        if len(targets)!=1:continue
        _,target,target_value=targets[0];pos=(point*(1-t)+target*t)*scale
        draw.text(tuple(pos),kind,font=centre_font,anchor='mm',fill=INK)
        if value is not None:draw.text((pos[0],pos[1]+9*scale),str(value if t<.5 else target_value),font=label_font,anchor='mm',fill=INK)
    result=canvas.convert('RGB').resize(size,Image.Resampling.LANCZOS)
    caption=ImageDraw.Draw(result)
    try:caption_font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',10)
    except OSError:caption_font=ImageFont.load_default()
    caption.rounded_rectangle((5,size[1]-20,114,size[1]-4),radius=3,fill=(250,250,245),outline=(190,193,189))
    caption.text((10,size[1]-18),'Illustrative transition',font=caption_font,fill=INK)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pdf',type=Path,required=True);parser.add_argument('--out',type=Path,required=True);parser.add_argument('--start',type=int,default=0);parser.add_argument('--end',type=int,default=1);parser.add_argument('--frames',type=int,default=25);args=parser.parse_args()
    page=fitz.open(args.pdf)[0];a=extract(page,args.start);b=extract(page,args.end)
    matches={name:match_curves(a[name],b[name],name=='curves') for name in ('curves','fronts','symbols')}
    matches['curves'],crossing_rejections=reject_intermediate_crossings(a['curves'],b['curves'],matches['curves'])
    args.out.mkdir(parents=True,exist_ok=True);size=(580,436)
    for i in range(args.frames):
        image=official(page,args.start if i==0 else args.end,size) if i in (0,args.frames-1) else render(a,b,matches,i/(args.frames-1),size)
        image.save(args.out/f'{i:02d}.png')
    report={'experimental':True,'production_ready':False,'interpretation':'Illustrative transition, not intermediate forecast data','panels':[args.start,args.end], 'crossing_rejections':crossing_rejections,'dependencies':['PyMuPDF','numpy','scipy','Pillow'],'omissions':['Pressure labels are anchored on resampled matched curves; H/L central values switch at halfway, without inventing intermediate pressure forecasts.','Unmatched 1020hPa geometry includes a one-to-two visible contour topology change; closed 1012/1016 low-pressure contours become open. These are not guessed into correspondences.','Rain hatching uses clipped PDF pattern fills and is not reconstructed in intermediate frames.','Ambiguous or topology-changing paths only depart/arrive in the outer quarter of the transition.'],'coverage':{}}
    for name,(pairs,ua,ub) in matches.items():
        lengthA=sum(c.length for c in a[name]);lengthB=sum(c.length for c in b[name]);coveredA=sum(a[name][m[0]].length for m in pairs);coveredB=sum(b[name][m[1]].length for m in pairs)
        report['coverage'][name]={'source_count':len(a[name]),'destination_count':len(b[name]),'matched':len(pairs),'source_length_fraction':coveredA/max(1,lengthA),'destination_length_fraction':coveredB/max(1,lengthB),'pairs':[{'source_ids':a[name][i].ids,'destination_ids':b[name][j].ids,'pressure':a[name][i].pressure,'mean_travel_pt':cost,'source_reason':a[name][i].reason,'destination_reason':b[name][j].reason} for i,j,pa,pb,cost in pairs],'unmatched_source':[{'ids':a[name][i].ids,'pressure':a[name][i].pressure,'reason':a[name][i].reason if a[name][i].pressure is None else 'topology, length, displacement or ambiguity gate'} for i in sorted(ua)],'unmatched_destination':[{'ids':b[name][i].ids,'pressure':b[name][i].pressure,'reason':b[name][i].reason if b[name][i].pressure is None else 'topology, length, displacement or ambiguity gate'} for i in sorted(ub)]}
    (args.out/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps({key:{k:v for k,v in value.items() if k not in ('pairs','unmatched_source','unmatched_destination')} for key,value in report['coverage'].items()},indent=2))

if __name__=='__main__':main()
