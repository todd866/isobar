#!/usr/bin/env python3
"""Rendered-pixel translation oracle. A shape that flickers but moves upwind fails."""
import json
from pathlib import Path
import numpy as np
from PIL import Image
root=Path(__file__).resolve().parents[1]
contract=json.loads((root/'Tests/fixtures/wind-visual-contract.json').read_text())
base=root/'build/qa/wind'
results=[]
for surface,folder in [('native',base),('web',base/'browser')]:
    for scene in contract['scenes']:
        if scene['id'] not in ['city-light','mountain-light','north','west','south']:continue
        def image(phase):
            paths=list(folder.glob(f'**/{scene["id"]}-{phase}.png')) if surface=='web' else [folder/f'{scene["id"]}-{phase}.png']
            if len(paths)!=1:raise ValueError(f'{surface} {scene["id"]} evidence missing/ambiguous')
            return np.asarray(Image.open(paths[0]).convert('RGBA'),dtype=np.float64)[:,:,3]/255
        a,b=image('before'),image('after');h,w=a.shape;vertical=scene['u']==0
        # Constant wind has known direction. Find the translation of the actual
        # alpha image, excluding edges where birth/death is deliberately faded.
        crop=a[40:h-40,40:w-40];scores=[]
        for shift in range(-35,36):
            part=b[40+shift:h-40+shift,40:w-40] if vertical else b[40:h-40,40+shift:w-40+shift]
            scores.append(float(np.sum(crop*part)))
        actual=int(np.argmax(scores))-35
        direction=-np.sign(scene['v']) if vertical else np.sign(scene['u'])
        expected=min(60,12*3600/111320*scene['zoom']*min(w/360,h/180))*contract['motionSeconds']
        if actual*direction<=0 or abs(abs(actual)-expected)>3:
            raise AssertionError(f'{surface}/{scene["id"]}: pixel translation {actual}, expected {direction*expected:.1f}px')
        results.append({'surface':surface,'scene':scene['id'],'pixelShift':actual,'expected':round(float(direction*expected),2)})
(base/'pixel-motion.json').write_text(json.dumps(results,indent=2)+'\n')
print(f'PASS {len(results)} native/browser downstream pixel-motion checks')
