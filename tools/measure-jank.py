#!/usr/bin/env python3
"""Score the on-screen smoothness of a map recording (a screen capture of the
popover or fullscreen map, or an exported movie).

    tools/measure-jank.py RECORDING.mov [--out DIR] [--skip SEC]
        [--forecast-hours H] [--seam START,DURATION]

It reports what a viewer sees rather than what the renderer intends:
  cadence  real visual updates per second and how evenly they are spaced
  spikes   updates much larger than their neighbours (a visible jump)
  numbers  pressure labels and H/L values, tracked as text-sized dark blobs:
           how often one appears, vanishes or moves, per minute
  lines    typical per-update motion of everything else
A JSON summary is printed; --out also writes summary.json and worst.png, a
strip of the worst moments with the blobs that changed outlined.
"""
import argparse
import json
import pathlib
import subprocess

import numpy as np
from scipy import ndimage

WIDTH = 580


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height,r_frame_rate", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True).stdout.strip().split(",")
    w, h = int(out[0]), int(out[1])
    num, den = out[2].split("/")
    return w, h, float(num) / float(den)


def frames(path, width, height):
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"scale={width}:{height}",
        "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], stdout=subprocess.PIPE)
    size = width * height
    try:
        while True:
            data = proc.stdout.read(size)
            if len(data) < size:
                break
            yield np.frombuffer(data, np.uint8).reshape(height, width)
    finally:
        proc.stdout.close()
        proc.wait()


def text_blobs(gray):
    """Dark, compact, text-sized components: digits of a label or an H/L value.
    Isobars are long and thin, so they fail the size and fill tests."""
    dark = gray < 90
    joined = ndimage.binary_dilation(dark, iterations=2)
    labels, n = ndimage.label(joined)
    blobs = []
    for index, box in enumerate(ndimage.find_objects(labels), start=1):
        if box is None:
            continue
        h = box[0].stop - box[0].start
        w = box[1].stop - box[1].start
        if not (6 <= h <= 24 and 10 <= w <= 64):
            continue
        ink = dark[box][labels[box] == index].mean() if (labels[box] == index).any() else 0
        fill = (labels[box] == index).mean()
        if fill < 0.35 or ink < 0.25:
            continue
        cy = (box[0].start + box[0].stop) / 2
        cx = (box[1].start + box[1].stop) / 2
        blobs.append((cx, cy, w, h))
    return blobs


class Tracker:
    """Debounced number tracking. A blob is matched to a track by position
    (sizes wobble where a line touches the text). A track only counts as an
    appearance once it has lasted SETTLE updates, and as a disappearance once
    it has been missing for SETTLE updates, so threshold flicker is ignored."""
    SETTLE = 3

    def __init__(self):
        self.tracks = []  # dicts: x, y, seen, missing, counted

    def update(self, blobs, first):
        appeared = vanished = moved = still = 0
        free = list(blobs)
        for track in self.tracks:
            best, best_d = None, 1e9
            for b in free:
                d = np.hypot(b[0] - track["x"], b[1] - track["y"])
                if d < best_d:
                    best, best_d = b, d
            if best is not None and best_d <= 12:
                free.remove(best)
                if best_d > 4 and track["counted"]:
                    moved += 1
                elif track["counted"]:
                    still += 1
                track.update(x=best[0], y=best[1], missing=0, seen=track["seen"] + 1)
                if not track["counted"] and (first or track["seen"] >= self.SETTLE):
                    track["counted"] = True
                    if not first:
                        appeared += 1
            else:
                track["missing"] += 1
        for b in free:
            self.tracks.append({"x": b[0], "y": b[1], "seen": 1, "missing": 0, "counted": first})
        alive = []
        for track in self.tracks:
            if track["missing"] >= self.SETTLE:
                if track["counted"]:
                    vanished += 1
            else:
                alive.append(track)
        self.tracks = alive
        return still, moved, appeared, vanished, []


def seam_windows(specs):
    """START,DURATION pairs. A dissolve is an intended transition."""
    windows = []
    for spec in specs:
        parts = spec.split(",")
        if len(parts) != 2:
            raise SystemExit(f"seam must be START,DURATION, got {spec}")
        try:
            start, dur = float(parts[0]), float(parts[1])
        except ValueError:
            raise SystemExit(f"seam must be START,DURATION, got {spec}")
        if dur < 0 or start < 0:
            raise SystemExit(f"seam start and duration must be >= 0, got {spec}")
        windows.append((start, dur))
    return windows


def in_seam(t, windows):
    return any(start <= t < start + dur for start, dur in windows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("recording")
    parser.add_argument("--out")
    parser.add_argument("--skip", type=float, default=0.0,
        help="ignore the first SKIP seconds (an intended jump, such as entering a hover)")
    parser.add_argument("--forecast-hours", type=float,
        help="forecast time the recording covers; judge numbers per forecast hour (scrubbing)")
    parser.add_argument("--seam", action="append", default=[],
        help="START,DURATION seconds of an intended dissolve; its updates are not spikes or number events. Repeat for each seam")
    args = parser.parse_args()
    seams = seam_windows(args.seam)
    w0, h0, fps = probe(args.recording)
    height = int(round(h0 * WIDTH / w0 / 2) * 2)
    previous = None
    tracker = Tracker()
    times, diffs, events = [], [], []
    kept = []
    for n, frame in enumerate(frames(args.recording, WIDTH, height)):
        t = n / fps
        if previous is None:
            previous = frame
            tracker.update(text_blobs(frame), True)
            continue
        diff = float(np.abs(frame.astype(np.int16) - previous.astype(np.int16)).mean())
        if diff < 0.02:
            continue  # nothing visible changed: not an update
        still, moved, appeared, vanished, moves = tracker.update(text_blobs(frame), False)
        times.append(t)
        diffs.append(diff)
        events.append({"t": round(t, 3), "diff": round(diff, 3), "still": still, "moved": moved,
            "appeared": appeared, "vanished": vanished})
        kept.append((t, diff, previous, frame, moves, appeared + vanished + moved))
        kept.sort(key=lambda item: -(item[5] * 10 + item[1]))
        del kept[6:]
        previous = frame
    duration = max(1e-6, (n + 1) / fps) if previous is not None else 1e-6
    d = np.array(diffs) if diffs else np.zeros(1)
    # A dissolve can be a large, even change. Leave it out of the median so
    # it cannot raise the bar, and out of the gaps so the hold is not a stutter.
    # The spike rule itself stays diff > 3× that median.
    pace = [e for e in events if not in_seam(e["t"], seams)]
    pace_d = np.array([e["diff"] for e in pace]) if pace else d
    if seams:
        play = [e["t"] for e in pace if e["t"] >= args.skip]
        gaps_list = []
        for a, b in zip(play, play[1:]):
            if any(start > a and start < b for start, _dur in seams):
                continue
            gaps_list.append(b - a)
        gaps = np.array(gaps_list) if gaps_list else np.zeros(1)
    else:
        gaps = np.diff(times) if len(times) > 1 else np.zeros(1)
    median = float(np.median(pace_d)) if len(pace_d) else 0.0
    judged = [e for e in events if e["t"] >= args.skip and not in_seam(e["t"], seams)]
    spikes = [e for e in judged if median > 0 and e["diff"] > 3 * median]
    number_events = sum(e["moved"] + e["appeared"] + e["vanished"] for e in judged)
    minutes = duration / 60
    summary = {
        "recording": str(args.recording),
        "seconds": round(duration, 2),
        "source_fps": round(fps, 2),
        "updates_per_second": round(len(times) / duration, 2),
        "update_gap_ms": {"median": round(float(np.median(gaps)) * 1000, 1),
                          "p95": round(float(np.percentile(gaps, 95)) * 1000, 1),
                          "irregularity": round(float(np.std(gaps) / max(1e-9, np.mean(gaps))), 3)},
        "change_per_update": {"median": round(median, 3), "p95": round(float(np.percentile(d, 95)), 3),
                              "max": round(float(d.max()), 3)},
        "spikes": len(spikes),
        "number_events_per_minute": round(number_events / minutes, 1),
        "numbers_moved": sum(e["moved"] for e in events),
        "numbers_appeared": sum(e["appeared"] for e in events),
        "numbers_vanished": sum(e["vanished"] for e in events),
        "worst_moments_s": [round(item[0], 2) for item in kept],
    }
    # A smooth ambient map: regular updates (irregularity < 0.3), no spikes,
    # and numbers that almost never change (well under 6 events a minute).
    # A scrub is judged per forecast hour covered: at most 3 number changes.
    if args.forecast_hours:
        summary["number_events_per_forecast_hour"] = round(number_events / args.forecast_hours, 2)
        calm = summary["number_events_per_forecast_hour"] <= 3
    else:
        calm = summary["number_events_per_minute"] < 6
    summary["verdict"] = ("smooth" if summary["spikes"] == 0 and calm
                          and summary["update_gap_ms"]["irregularity"] < 0.3 else "jumpy")
    print(json.dumps(summary, indent=2))
    if args.out:
        out = pathlib.Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "summary.json").write_text(json.dumps({**summary, "events": events}, indent=2))
        tiles = []
        for t, diff, before, after, moves, _ in sorted(kept):
            tile = np.concatenate([before, after], axis=1).copy()
            for (cx, cy, bw, bh), _ in moves:
                x0, x1 = int(cx - bw / 2) + WIDTH, int(cx + bw / 2) + WIDTH
                y0, y1 = int(cy - bh / 2), int(cy + bh / 2)
                tile[max(0, y0):y1, max(0, x0):x0 + 1] = 255
                tile[max(0, y0):y1, min(x1, 2 * WIDTH - 1)] = 255
            tiles.append(tile)
        if tiles:
            strip = np.concatenate(tiles, axis=0)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s",
                f"{strip.shape[1]}x{strip.shape[0]}", "-i", "pipe:0", str(out / "worst.png")],
                input=strip.tobytes(), check=True)


if __name__ == "__main__":
    main()
