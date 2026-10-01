# Isobar wall

## Raw model movie

The native app and website share a raw-field renderer. It interpolates the
weather fields, keeps annotations stable across frames, and encodes a silent
60 fps movie. Render and review it locally:

~~~sh
./tools/raw-movie.sh "$HOME/Data/isobar" /tmp/isobar-pressure.mp4 \
  Resources/ownchart-coast.bin pressure 30
python3 wall/publish_raw.py /tmp/isobar-pressure.mp4 /tmp/isobar-wall-review
~~~

The first command writes an MP4 and matching forecast metadata. The second
adds the forecast clock and packages a local wall preview. Neither command
starts a TV or casts anything. Use a new output filename for each raw render;
existing movies are never overwritten. Other layers are `temperature`, `rain`
and `wind`.

The publisher writes immutable generations, validates the completed video,
then replaces `current.json`. Keep review output separate from any directory
watched by a display or TV consumer.

## Earlier Bureau chart prototype

This is a device-agnostic wall surface for a 1600×1200 landscape display. It
reads an existing Isobar archive, renders the current Bureau IDG00073 prognosis
map, and adds a small rain / wind / surf band from the archived point products.
The chart crop uses the same measured panel geometry as the native app; it does
not redraw or reproject the Bureau map.

### Render

~~~sh
python3 wall/render.py "$HOME/Data/isobar" /tmp/isobar-wall/current.png
~~~

Use --now 2026-09-27T04:00:00Z for deterministic fixtures. The command
atomically replaces current.png, writes eight fixed-geometry chart frames
under frames/, and writes frame-manifest.json with the chart's printed
valid-time labels. It also builds fronts.mp4 with FFmpeg's
motion-compensated minterpolate filter at 24 fps. The movie is regenerated
only when the Bureau PDF or its labels change, and is replaced atomically with
fronts.json. Install FFmpeg separately and keep ffmpeg on PATH. Missing or
future-empty point products leave their cards unavailable while the chart
remains readable.

### Local review server

~~~sh
python3 wall/render.py "$HOME/Data/isobar" /tmp/isobar-wall/current.png \
  --serve --host 127.0.0.1 --port 8080
~~~

The server renders on startup and refreshes every 15 minutes. It exposes only
/, /current.png, /frame-manifest.json, /fronts.json, /fronts.mp4,
/frames/0.png through /frames/7.png, and /health; it does not serve arbitrary
archive paths. The web page uses the cached movie, maps the scrubber to the
printed keyframe times, and stops playback when hidden or when reduced motion
is enabled. The source line identifies the movie as frames interpolated
between Bureau forecasts; it does not invent forecast timestamps.

The PNG and page are deliberately local-first. A later display adapter can
poll /current.png or use the fixed frame routes without changing the archive
contract. Sources are the Bureau chart and the archived ECMWF/marine products;
their run identifiers are printed at the bottom of the frame.
