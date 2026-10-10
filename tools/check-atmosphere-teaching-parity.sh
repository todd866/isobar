#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h:h}"
CC="${CC:-$(xcrun --find clang)}"
SDKROOT="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}"
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$ROOT/Info.plist")
WORK="$(mktemp -d "${TMPDIR:-/tmp}/atmosphere-parity.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
(
  cd "$ROOT"
  "$CC" -std=c11 -O2 -Wall -Wextra -Werror -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources tools/check-atmosphere-teaching.c -lm -o "$WORK/c"
)
"$WORK/c" --matrix > "$WORK/c.txt"
(cd "$ROOT/web" && npx tsx -e 'import { sampleTeachingAtmosphere as s } from "./src/lib/atmosphere-teaching.ts"; const kinds=["circulation","sea-breeze","thunderstorm","mountain-wave"] as const, offsets=[[0,0],[.01,.01],[-.02,.015]], heights=[0,500,1800,4200,9000,10000,12000]; for(let k=0;k<4;k++)for(let o=0;o<3;o++)for(let h=0;h<7;h++){const c={kind:kinds[k],lat:-31.95,lon:115.86,groundM:20,timeMs:1737000000000};const a=s(c,c.lat+offsets[o][0],c.lon+offsets[o][1],heights[h]); console.log(`${k},${o},${h} ${a.u} ${a.v} ${a.w} ${a.temperatureC} ${a.rhPct} ${a.pressureHPa} ${a.cloudPct} ${a.density} ${a.cloudBaseM} ${a.stabilityN2}`)}') > "$WORK/ts.txt"
python3 -c 'import sys; c=[x.split() for x in open(sys.argv[1]) if x[:1].isdigit()]; t=[x.split() for x in open(sys.argv[2]) if x[:1].isdigit()]; expected=[f"{k},{o},{h}" for k in range(4) for o in range(3) for h in range(7)]; assert len(c)==len(t)==len(expected)==84, (len(c),len(t)); assert [x[0] for x in c]==expected and [x[0] for x in t]==expected, "unstable or missing matrix rows"; assert all(len(x)==11 for x in c+t), "unexpected matrix column count"; [(None if x[0]==y[0] and all(abs(float(p)-float(q))<=2e-6*max(1,abs(float(p)),abs(float(q))) for p,q in zip(x[1:],y[1:])) else (_ for _ in ()).throw(SystemExit(f"parity differs row {i}: {x} vs {y}"))) for i,(x,y) in enumerate(zip(c,t))]; print(f"TS/C parity passed ({len(c)} samples, 11 columns)")' "$WORK/c.txt" "$WORK/ts.txt"
