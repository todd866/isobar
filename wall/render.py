#!/usr/bin/env python3
"""Render a portable Isobar wall frame from a local archive."""

from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import threading
import time
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from PIL import Image, ImageDraw, ImageFont


PAGE_W, PAGE_H = 532.031, 793.779
# Crops share identical mainland coordinates, independent of panel-border drift.
MAP_FRAMES = (
    (39.332000, 560.651000, 226.494, 170.594),
    (273.395675, 560.570556, 226.494, 170.594),
    (38.455596, 374.839644, 226.494, 170.594),
    (273.371993, 374.754531, 226.494, 170.594),
    (39.332000, 189.364333, 226.494, 170.594),
    (273.237106, 189.104079, 226.494, 170.594),
    (38.510101, 3.870864, 226.494, 170.594),
    (273.511581, 2.772048, 226.494, 170.594),
)
MAP_INSET = 1.25
CANVAS = (1600, 1200)
INK = (28, 30, 29)
SECONDARY = (92, 95, 91)
PAPER = (247, 246, 240)
RULE = (190, 190, 183)
# Bump when a cached movie would no longer match this renderer.
RENDERER_VERSION = 7
CHART_TOOL_TIMEOUT = 60
PROBE_TIMEOUT = 20


class RenderError(RuntimeError):
    pass


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise RenderError(f"cannot read {path.name}") from exc


def parse_time(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError("invalid timestamp")
    value = value.strip()
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    if len(value) == 16 and "T" in value:
        value += ":00"
    parsed = datetime.fromisoformat(value)
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def current_pointer(store: Path, product: str) -> Path:
    pointer = read_json(store / "products" / "points" / product / "current.json")
    latest = pointer.get("latest")
    if not isinstance(latest, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", latest) or latest in (".", ".."):
        raise RenderError(f"{product} has no latest run")
    runs = pointer.get("runs")
    if not isinstance(runs, list) or latest not in runs:
        raise RenderError(f"{product} latest run is not listed")
    run = store / "products" / "points" / product / "runs" / latest / "cottesloe.json"
    if not run.is_file():
        raise RenderError(f"{product} latest run is missing")
    return run


def hourly_product(path: Path, now: datetime, limit: int = 12) -> list[dict[str, Any]]:
    product = read_json(path)
    times = product.get("time")
    hourly = product.get("hourly")
    if not isinstance(times, list) or not isinstance(hourly, dict):
        raise RenderError(f"{path.name} has no hourly data")
    rows = []
    for index, raw_time in enumerate(times):
        try:
            when = parse_time(raw_time)
        except (TypeError, ValueError):
            continue
        if when < now:
            continue
        row = {"time": when}
        for key, values in hourly.items():
            if isinstance(values, list) and index < len(values):
                row[key] = values[index]
        rows.append(row)
        if len(rows) == limit:
            break
    return rows


def finite(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def run_tool(args: list[str], timeout: float, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, check=check, timeout=timeout)


def direction(degrees: Any) -> str:
    value = finite(degrees)
    if value is None:
        return "—"
    names = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")
    return names[int((value % 360 + 22.5) // 45) % 8]


def render_chart(pdf: Path, out_size: tuple[int, int]) -> Image.Image:
    if not pdf.is_file():
        raise RenderError("IDG00073.pdf is missing")
    with tempfile.TemporaryDirectory(prefix="isobar-wall-pdf-") as temp:
        prefix = str(Path(temp) / "page")
        result = run_tool(["pdftoppm", "-f", "1", "-l", "1", "-r", "180", "-png", "-singlefile", str(pdf), prefix], CHART_TOOL_TIMEOUT)
        if result.returncode or not Path(prefix + ".png").is_file():
            raise RenderError("could not render Bureau chart")
        page = Image.open(prefix + ".png").convert("RGB")
    scale = page.width / PAGE_W
    maps = []
    for x, y, width, height in MAP_FRAMES[:2]:
        inset = MAP_INSET
        left = round((x + inset) * scale)
        top = round((PAGE_H - y - height + inset) * scale)
        right = round((x + width - inset) * scale)
        bottom = round((PAGE_H - y - inset) * scale)
        maps.append(recolour_chart(page.crop((left, top, right, bottom))))
    total_w, panel_h = out_size
    gap = 18
    panel_w = (total_w - gap) // 2
    canvas = Image.new("RGB", out_size, PAPER)
    for index, chart in enumerate(maps):
        fitted = chart.copy()
        fitted.thumbnail((panel_w, panel_h), Image.Resampling.LANCZOS)
        x = index * (panel_w + gap) + (panel_w - fitted.width) // 2
        y = (panel_h - fitted.height) // 2
        canvas.paste(fitted, (x, y))
    return canvas


def render_panel(pdf: Path, panel: int, out_size: tuple[int, int]) -> Image.Image:
    """Render one exact prognosis panel at a wall-friendly size."""
    if panel < 0 or panel >= len(MAP_FRAMES):
        raise RenderError("invalid chart panel")
    with tempfile.TemporaryDirectory(prefix="isobar-wall-pdf-") as temp:
        prefix = str(Path(temp) / "page")
        result = run_tool(["pdftoppm", "-f", "1", "-l", "1", "-r", "180", "-png", "-singlefile", str(pdf), prefix], CHART_TOOL_TIMEOUT)
        if result.returncode or not Path(prefix + ".png").is_file():
            raise RenderError("could not render Bureau chart")
        page = Image.open(prefix + ".png").convert("RGB")
    scale = page.height / PAGE_H
    x, y, width, height = MAP_FRAMES[panel]
    left = (x + MAP_INSET) * scale
    top = (PAGE_H - y - height + MAP_INSET) * scale
    right = (x + width - MAP_INSET) * scale
    bottom = (PAGE_H - y - MAP_INSET) * scale
    chart = recolour_chart(page.transform(out_size, Image.Transform.EXTENT, (left, top, right, bottom), Image.Resampling.BICUBIC))
    chart.thumbnail(out_size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", out_size, PAPER)
    canvas.paste(chart, ((out_size[0] - chart.width) // 2, (out_size[1] - chart.height) // 2))
    return canvas


def chart_labels(pdf: Path, chart_time: str | None) -> list[str]:
    try:
        text = run_tool(["pdftotext", str(pdf), "-"], CHART_TOOL_TIMEOUT).stdout
    except (OSError, subprocess.TimeoutExpired):
        text = ""
    matches = re.findall(r"\b(\d{1,2}(?:am|pm)\s+[A-Z][a-z]+\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4})\b", text)
    labels = matches[:8]
    if len(labels) != 8 or any(label_to_utc(label) is None for label in labels):
        raise RenderError("Bureau chart does not contain eight dated panel labels")
    return labels


def label_to_utc(label: str) -> str | None:
    """Convert the chart's printed EST panel time to an explicit UTC value."""
    try:
        local = datetime.strptime(label, "%I%p %A %B %d, %Y").replace(tzinfo=timezone(timedelta(hours=10)))
    except ValueError:
        return None
    return local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def build_fronts_video(output_dir: Path, chart_pdf: Path, labels: list[str],
                       chart_time: str | None = None, forecast_run: str | None = None) -> None:
    """Create an immutable 24 fps film with a complete final endpoint."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RenderError("ffmpeg is required for animation")
    duration = (len(labels) - 1) * 2 + 1
    valid_times = [label_to_utc(label) for label in labels]
    # Duplicate the final key to satisfy minterpolate's lookahead, then retain
    # one full second of the final forecast instead of truncating it at t=14.
    shutil.copyfile(output_dir / "frames/7.png", output_dir / "frames/8.png")
    shutil.copyfile(output_dir / "frames/7.png", output_dir / "frames/9.png")
    overlays = output_dir / "captions"
    overlays.mkdir()
    for index, label in enumerate(labels):
        from zoneinfo import ZoneInfo
        def local_text(value: str | None, fallback: str) -> str:
            return parse_time(value).astimezone(ZoneInfo("Australia/Perth")).strftime("%a %d %b · %-I%p").replace("AM", "am").replace("PM", "pm") if value else fallback
        title = local_text(valid_times[index], label)
        if index < len(labels) - 1:
            title += " → " + local_text(valid_times[index + 1], labels[index + 1])
        overlay = Image.new("RGBA", (1280, 720), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        draw.text((28, 12), title, font=font(25, True), fill=INK)
        draw.text((28, 692), "Bureau of Meteorology · interpolated forecasts", font=font(17), fill=SECONDARY)
        overlay.save(overlays / f"{index}.png")
    filters = "[0:v]minterpolate=fps=24:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,scale=1280:630:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:48:color=0xF7F6F0[map];[map][1:v]overlay=eof_action=repeat:format=auto,fps=24,format=yuv420p[out]"
    movie = output_dir / "fronts.mp4"
    result = subprocess.run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-framerate", "0.5", "-i", str(output_dir / "frames/%d.png"),
        "-framerate", "0.5", "-i", str(overlays / "%d.png"),
        "-filter_complex", filters, "-map", "[out]", "-frames:v", str(duration * 24),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(movie)], capture_output=True, text=True, timeout=300)
    if result.returncode or not movie.is_file():
        raise RenderError("could not encode forecast animation: " + result.stderr.strip()[-400:])
    probe = run_tool(["ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", str(movie)], PROBE_TIMEOUT, check=True)
    if abs(float(probe.stdout) - duration) > 1 / 24:
        raise RenderError(f"encoded movie duration {probe.stdout.strip()} differs from {duration}")
    metadata = {
        "generatedAt": datetime.now(timezone.utc).isoformat(), "forecastRun": forecast_run,
        "validFrom": valid_times[0], "validTo": valid_times[-1], "durationSeconds": duration,
        "width": 1280, "height": 720, "fps": 24, "region": "Australia",
        "attribution": "Bureau of Meteorology", "note": "Frames interpolated between Bureau forecasts",
        "keyframes": [{"seconds": i * 2, "validTime": valid_times[i], "label": label, "region": "Australia"}
            for i, label in enumerate(labels)], "labels": labels,
        "chart_sha256": hashlib.sha256(chart_pdf.read_bytes()).hexdigest(), "chartRetrievedAt": chart_time,
    }
    (output_dir / "fronts.json").write_text(json.dumps(metadata))
    shutil.rmtree(overlays)
    (output_dir / "frames/8.png").unlink()
    (output_dir / "frames/9.png").unlink()


def recolour_chart(image: Image.Image) -> Image.Image:
    """Apply the native renderer's measured Bureau fills without changing ink."""
    sea = (235, 241, 247)
    land = (244, 238, 175)
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b = pixels[x, y]
            if max(r, g, b) >= 246 and max(r, g, b) - min(r, g, b) <= 4:
                pixels[x, y] = sea
            elif 180 <= r <= 240 and max(r, g, b) - min(r, g, b) <= 6:
                pixels[x, y] = land
    return image


def draw_arrow(draw: ImageDraw.ImageDraw, x: float, y: float, degrees: float | None, length: float = 34) -> None:
    if degrees is None:
        draw.ellipse((x - 4, y - 4, x + 4, y + 4), outline=SECONDARY, width=3)
        return
    radians = math.radians(degrees)
    dx, dy = math.sin(radians), -math.cos(radians)
    tail = (x - dx * length * 0.45, y - dy * length * 0.45)
    head = (x + dx * length * 0.55, y + dy * length * 0.55)
    draw.line((tail, head), fill=INK, width=5)
    angle = math.atan2(head[1] - tail[1], head[0] - tail[0])
    points = [head,
              (head[0] - 12 * math.cos(angle - 0.55), head[1] - 12 * math.sin(angle - 0.55)),
              (head[0] - 12 * math.cos(angle + 0.55), head[1] - 12 * math.sin(angle + 0.55))]
    draw.polygon(points, fill=INK)


def draw_card(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], title: str, value: str, detail: str) -> None:
    x, y, right, bottom = box
    draw.rounded_rectangle(box, radius=18, fill=(238, 238, 231), outline=RULE, width=2)
    draw.text((x + 22, y + 16), title.upper(), font=font(19, True), fill=SECONDARY)
    draw.text((x + 22, y + 52), value, font=font(37, True), fill=INK)
    draw.text((x + 22, bottom - 38), detail, font=font(17), fill=SECONDARY)


def point_conditions(store: Path, now: datetime) -> dict[str, Any]:
    def product(name: str) -> tuple[dict, list]:
        try:
            path = current_pointer(store, name)
            return read_json(path), hourly_product(path, now, 24)
        except RenderError:
            return {}, []
    surface, hours = product("ecmwf_ifs")
    marine, waves = product("marine")
    units = surface.get("units", {})
    marine_units = marine.get("units", {})
    def value(row: dict, key: str, required_unit: str, actual_units: dict) -> float | None:
        result = finite(row.get(key)) if actual_units.get(key) == required_unit else None
        return result if result is not None and result >= 0 else None
    # Each rainfall value is the interval ending at that row's timestamp.
    wanted = [now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=i + 1) for i in range(12)]
    by_time = {row["time"]: row for row in hours}
    amounts = [value(by_time.get(when, {}), "precipitation", "mm", units) for when in wanted]
    known = [amount for amount in amounts if amount is not None]
    first = hours[0] if hours and (hours[0]["time"] - now).total_seconds() <= 3600 else {}
    swell = waves[0] if waves and (waves[0]["time"] - now).total_seconds() <= 3600 else {}
    wind_from = value(first, "wind_direction_10m", "°", units)
    wave_from = value(swell, "wave_direction", "°", marine_units)
    wind_degrees = wind_from if wind_from is not None and wind_from <= 360 else None
    wave_degrees = wave_from if wave_from is not None and wave_from <= 360 else None
    return {"place": "Perth coast", "generatedAt": now.isoformat(),
        "rain": {"mm": round(sum(known), 2) if len(known) == 12 else None,
            "knownMm": round(sum(known), 2) if known else None, "coveredHours": len(known), "hours": 12},
        "wind": {"kt": value(first, "wind_speed_10m", "kn", units), "from": wind_degrees, "compass": direction(wind_degrees)},
        "surf": {"metres": value(swell, "wave_height", "m", marine_units),
            "period": value(swell, "wave_period", "s", marine_units),
            "from": wave_degrees, "compass": direction(wave_degrees)},
        "surfaceRun": surface.get("run"), "marineRun": marine.get("run")}


def render(store: Path, output: Path, now: datetime | None = None) -> Path:
    now = now or datetime.now(timezone.utc)
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = read_json(store / "manifest.json")
    chart_entry = next((entry for entry in manifest.get("products", [])
        if isinstance(entry, dict) and entry.get("id") == "chart-IDG00073.pdf"), {})
    chart_pdf = store / "products/charts/IDG00073.pdf"
    if not chart_pdf.is_file():
        raise RenderError("Bureau chart is unavailable")
    # Snapshot once: the collector can replace its PDF during a render.
    pdf_bytes = chart_pdf.read_bytes()
    digest = hashlib.sha256(pdf_bytes).hexdigest()
    generation_root = output.parent / "generations"
    generation_root.mkdir(exist_ok=True)
    generation = generation_root / f"{digest[:16]}-v{RENDERER_VERSION}"
    if not ((generation / "fronts.json").is_file() and (generation / "fronts.mp4").is_file()):
        with tempfile.TemporaryDirectory(prefix=".prepare-", dir=generation_root) as scratch:
            staging = Path(scratch) / "bundle"
            (staging / "frames").mkdir(parents=True)
            snapshot = Path(scratch) / "chart.pdf"
            snapshot.write_bytes(pdf_bytes)
            labels = chart_labels(snapshot, None)
            for index in range(8):
                render_panel(snapshot, index, (580, 436)).save(staging / "frames" / f"{index}.png")
            build_fronts_video(staging, snapshot, labels, chart_entry.get("valid_time"), chart_entry.get("run"))
            if generation.exists():
                shutil.rmtree(generation)
            os.replace(staging, generation)
    metadata = read_json(generation / "fronts.json")
    conditions = point_conditions(store, now)
    relative = generation.relative_to(output.parent).as_posix()
    current = {"schemaVersion": 1, "generation": generation.name, "video": f"{relative}/fronts.mp4",
        "metadata": f"{relative}/fronts.json", "poster": f"{relative}/frames/0.png",
        "updatedAt": now.isoformat(), "conditions": conditions}
    # Optional still frame for e-ink, plus the independent HTML card data.
    canvas = Image.new("RGB", CANVAS, PAPER)
    draw = ImageDraw.Draw(canvas)
    draw.text((54, 30), "ISOBAR", font=font(30, True), fill=INK)
    draw.text((54, 80), metadata["labels"][0] + " · Bureau EST", font=font(21), fill=SECONDARY)
    chart = Image.open(generation / "frames/0.png").convert("RGB")
    chart.thumbnail((1460, 830), Image.Resampling.LANCZOS)
    chart = chart.resize((int(830 * chart.width / chart.height), 830), Image.Resampling.LANCZOS)
    canvas.paste(chart, ((1600-chart.width)//2, 130))
    rain, wind, surf = conditions["rain"], conditions["wind"], conditions["surf"]
    wind_detail = wind["compass"] if isinstance(wind.get("compass"), str) else direction(wind.get("from"))
    period = f'{surf["period"]:.0f} s' if surf.get("period") is not None else None
    surf_compass = surf.get("compass") if isinstance(surf.get("compass"), str) and surf.get("compass") != "—" else None
    if period and surf_compass:
        surf_detail = f"{period} · {surf_compass}"
    else:
        surf_detail = period or surf_compass or "Unavailable"
    values = [("Rain", f'{rain["mm"]:.1f} mm' if rain["mm"] is not None else "—", "Next 12h" if rain["mm"] is not None else "Unavailable"),
        ("Wind", f'{wind["kt"]:.0f} kt' if wind["kt"] is not None else "—", wind_detail),
        ("Waves", f'{surf["metres"]:.1f} m' if surf["metres"] is not None else "—", surf_detail)]
    for i, (title, value, detail) in enumerate(values):
        draw_card(draw, (54+i*504, 990, 536+i*504, 1160), title, value, detail)
    temporary = output.with_suffix(".png.tmp")
    canvas.save(temporary, "PNG"); os.replace(temporary, output)
    temporary = output.parent / ".current.json.tmp"
    temporary.write_text(json.dumps(current)); os.replace(temporary, output.parent / "current.json")
    # Retain the active and previous programmes. Readers copy a film before
    # serving it, so a running TV segment never relies on this cleanup window.
    old = sorted((p for p in generation_root.iterdir() if p.is_dir() and not p.name.startswith(".")), key=lambda p: p.stat().st_mtime, reverse=True)
    keep = {generation, *old[:2]}
    for path in old:
        if path not in keep:
            shutil.rmtree(path)
    return output


class WallServer:
    def __init__(self, store: Path, output: Path) -> None:
        self.store, self.output = store, output
        self.lock = threading.Lock()
        self.last_success: str | None = None
        self.last_error: str | None = None

    def refresh(self) -> None:
        with self.lock:
            try:
                render(self.store, self.output)
                self.last_success = datetime.now(timezone.utc).isoformat()
                self.last_error = None
            except (RenderError, OSError, ValueError, subprocess.SubprocessError) as exc:
                self.last_error = str(exc)
                raise RenderError(str(exc)) from exc


def last_good_generation(output: Path) -> bool:
    try:
        pointer = json.loads((output.parent / "current.json").read_text())
    except (OSError, ValueError):
        return False
    name = pointer.get("generation") if isinstance(pointer, dict) else None
    if not isinstance(name, str) or not re.fullmatch(r"[a-f0-9]{16}-v[0-9]+", name):
        return False
    generation = output.parent / "generations" / name
    return (generation / "fronts.mp4").is_file() and (generation / "fronts.json").is_file()


def serve(store: Path, output: Path, host: str, port: int) -> None:
    server_state = WallServer(store, output)
    try:
        server_state.refresh()
    except RenderError:
        if not last_good_generation(output):
            raise
    timer = threading.Thread(target=lambda: refresh_loop(server_state), daemon=True)
    timer.start()
    try:
        from .server import handler_for
    except ImportError:
        from server import handler_for
    def health() -> dict:
        return {"ok": server_state.last_error is None, "last_success": server_state.last_success, "error": server_state.last_error}
    httpd = http.server.ThreadingHTTPServer((host, port), handler_for(output.parent, Path(__file__).with_name("index.html"), health))
    print(f"wall listening on http://{host}:{port}", flush=True)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()



def refresh_loop(server: WallServer) -> None:
    while True:
        time.sleep(900)
        try:
            server.refresh()
        except RenderError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Render or serve a portable Isobar wall frame.")
    parser.add_argument("store", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--now", help="UTC ISO time, useful for fixtures")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    try:
        now = parse_time(args.now) if args.now else None
        if args.serve:
            serve(args.store, args.output, args.host, args.port)
        else:
            print(render(args.store, args.output, now))
        return 0
    except (RenderError, OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"render error: {exc}", file=os.sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
