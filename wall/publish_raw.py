#!/usr/bin/env python3
"""Compose a raw-grid movie for the TV and atomically publish its programme."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFont


def iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def font(size: int, bold: bool = False):
    names = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    for name in names:
        if Path(name).is_file():
            return ImageFont.truetype(name, size)
    raise RuntimeError("A readable display font is required")


def probe(path: Path) -> dict:
    return json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]))


def compose(movie: Path, root: Path) -> Path:
    metadata = json.loads(movie.with_suffix(".json").read_text())
    duration = float(metadata["durationSeconds"])
    start, end = iso(metadata["validFrom"]), iso(metadata["validTo"])
    if not 4 <= duration <= 120 or end <= start or metadata.get("source") != "ECMWF Open Data":
        raise ValueError("Expected a current raw ECMWF movie")
    if end <= datetime.now(timezone.utc):
        raise ValueError("Forecast has expired")
    video = next(s for s in probe(movie)["streams"] if s["codec_type"] == "video")
    frames = int(video["nb_frames"])
    fps = int(metadata["fps"])
    if fps not in (30, 60) or video["r_frame_rate"] != f"{fps}/1" or frames != round(duration * fps):
        raise ValueError("Expected a complete 30 or 60 fps movie")
    generation = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8]
    target = root / "generations" / generation
    target.mkdir(parents=True)
    output = target / "weather.mp4"
    temporary = target / "weather.partial.mp4"
    zone = ZoneInfo("Australia/Perth")
    ink, secondary = "#233137", "#607179"
    label = {"pressure": "Pressure", "temperature": "Temperature", "rain": "24h rain", "wind": "Wind"}[metadata["layer"]]
    base = Image.new("RGB", (1280, 720), "#f6f7f5")
    draw = ImageDraw.Draw(base)
    draw.text((24, 44), "isobar", font=font(34, True), fill=ink)
    draw.text((24, 97), label, font=font(20), fill=ink)
    draw.text((24, 126), "Australia", font=font(16), fill=secondary)
    if label == "Pressure":
        draw.text((24, 163), "hPa", font=font(16), fill=secondary)
    draw.text((24, 616), "ECMWF", font=font(17, True), fill=ink)
    draw.text((24, 643), "Model run", font=font(13), fill=secondary)
    draw.text((24, 662), iso(metadata["forecastRun"]).astimezone(zone).strftime("%d %b · %H:%M AWST"), font=font(13), fill=secondary)
    draw.text((222, 699), "ECMWF Open Data · CC BY 4.0    /    Natural Earth", font=font(12), fill=secondary)
    draw.line((1080, 214, 1256, 214), fill="#cfd7d8", width=2)
    first_label = start.astimezone(zone).strftime("%a %d")
    last_label = end.astimezone(zone).strftime("%a %d")
    draw.text((1080, 231), first_label, font=font(14), fill=secondary)
    draw.text((1256, 231), last_label, font=font(14), fill=secondary, anchor="ra")
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(movie),
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "1280x720", "-r", str(fps), "-i", "pipe:0",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-filter_complex", "[0:v]scale=836:640,setsar=1[map];[1:v][map]overlay=222:40:shortest=1,format=yuv420p[v]",
        "-map", "[v]", "-map", "2:a", "-t", str(duration), "-c:v", "libx264", "-preset", "fast",
        "-crf", "19", "-profile:v", "main", "-level:v", "4.2" if fps > 30 else "3.1", "-pix_fmt", "yuv420p", "-g", str(fps),
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(temporary)]
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors)
        try:
            for frame in range(frames):
                fraction = frame / (frames - 1)
                stamp = (start + (end - start) * fraction).astimezone(zone)
                image = base.copy()
                draw = ImageDraw.Draw(image)
                draw.text((1080, 64), stamp.strftime("%a %d %b"), font=font(21, True), fill=ink)
                clock = stamp.strftime("%I:%M").lstrip("0")
                draw.text((1080, 105), clock, font=font(42), fill=ink)
                draw.text((1080, 159), stamp.strftime("%p") + " AWST", font=font(15), fill=secondary)
                x = 1080 + round(176 * fraction)
                draw.ellipse((x-5, 209, x+5, 219), fill="#087f98")
                process.stdin.write(image.tobytes())
            process.stdin.close()
            if process.wait(timeout=120):
                errors.seek(0)
                raise RuntimeError(errors.read().decode()[-2000:])
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
    info = probe(temporary)
    encoded = next(s for s in info["streams"] if s["codec_type"] == "video")
    if encoded.get("nb_frames") != str(frames) or encoded["width"] != 1280 or encoded["height"] != 720:
        raise RuntimeError("TV movie did not encode completely")
    if temporary.stat().st_size > 100 * 1024 * 1024:
        raise RuntimeError("TV movie exceeds programme size limit")
    os.replace(temporary, output)
    metadata["generatedAt"] = datetime.now(timezone.utc).isoformat()
    metadata["keyframes"] = [{"seconds": i * duration / 4, "validTime": (start + (end-start)*i/4).isoformat(),
                              "label": (start + (end-start)*i/4).astimezone(zone).strftime("%a %I:%M %p"), "region": "Australia"} for i in range(5)]
    (target / "weather.json").write_text(json.dumps(metadata, indent=2) + "\n")
    pointer = {"generation": generation, "video": str(output.relative_to(root)), "metadata": str((target / "weather.json").relative_to(root))}
    pointer_path = root / (".current-" + uuid4().hex + ".json")
    pointer_path.write_text(json.dumps(pointer, indent=2) + "\n")
    os.replace(pointer_path, root / "current.json")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("movie", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(compose(args.movie.resolve(), args.output.resolve()))
