#!/usr/bin/env python3
"""Create small, synthetic vector chart fixtures for parser tests.

The checked-in PDFs deliberately contain no downloaded Bureau artwork. Their
panel geometry, validity text, colours, and vector operators exercise the same
parser/layout contract as the production charts.
"""
from __future__ import annotations

import argparse
import math
import zlib
from pathlib import Path

PAGE_W, PAGE_H = 532.207, 793.779
PANEL_X = (38.543, 273.570)
PANEL_Y = (559.863, 559.602, 374.227, 373.966, 188.576, 188.315, 2.754, 2.493)
PANEL_W, MAP_H, TITLE_H = 228.072, 172.0, 10.9
PROGNOSIS = (
    "10am Saturday September 26, 2026", "10pm Saturday September 26, 2026",
    "10am Sunday September 27, 2026", "10pm Sunday September 27, 2026",
    "10am Monday September 28, 2026", "10pm Monday September 28, 2026",
    "10am Tuesday September 29, 2026", "10pm Tuesday September 29, 2026",
)


def pdf_string(value: str) -> str:
    return "(" + value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"


def content(kind: str) -> bytes:
    if kind == "analysis":
        return analysis_content()
    lines = [
        "q", "/CS0 cs", "/CS0 CS", "1 1 1 scn", f"0 0 {PAGE_W:.3f} {PAGE_H:.3f} re", "f*",
        "0.137 0.123 0.126  scn", "0.5 w", "38.937 746.099 462.062 42.225 re", "S",
        "BT", "1 1 1  scn", "/T1_1 1 Tf", "45 774 Td", pdf_string("Synthetic test chart · no Bureau artwork") + " Tj", "ET",
    ]
    if kind == "analysis":
        lines += ["BT", "/F1 9 Tf", "0 0 0 scn", "45 760 Td", pdf_string("Valid: 1800 UTC 25 Sep 2026") + " Tj", "ET",
                  "BT", "/F1 8 Tf", "45 750 Td", pdf_string("04am AEST 26/Sep./2026") + " Tj", "ET"]
    for index, y in enumerate(PANEL_Y):
        x = PANEL_X[index % 2]
        lines += [
            "0.137 0.123 0.126  scn", "/GS1 gs", f"{x:.3f} {y + MAP_H + TITLE_H:.3f} {PANEL_W:.3f} {-TITLE_H:.3f} re", "f*",
            "BT", "1 1 1  scn", "/T1_1 1 Tf", f"{x + 5:.3f} {y + MAP_H + 2:.3f} Td", pdf_string(PROGNOSIS[index]) + " Tj", "ET",
            "1 1 1 scn", f"{x:.3f} {y:.3f} {PANEL_W:.3f} {MAP_H:.3f} re", "f*",
            "0.862 0.866 0.871  scn", f"{x + 7:.3f} {y + 7:.3f} {PANEL_W - 14:.3f} {MAP_H - 14:.3f} re", "f*",
            "0.137 0.123 0.126  scn", "0.6 w", f"{x + 7:.3f} {y + 7:.3f} {PANEL_W - 14:.3f} {MAP_H - 14:.3f} re", "S",
            "/CS0 CS", "0.428 0.433 0.443  SCN", "1 w", f"{x + 25:.3f} {y + 35:.3f} m {x + 95:.3f} {y + 75:.3f} l {x + 160:.3f} {y + 48:.3f} l S",
            "0.004 0.005 0.004  SCN", "0.7 w", f"{x + 30:.3f} {y + 115:.3f} m {x + 105:.3f} {y + 138:.3f} l {x + 190:.3f} {y + 105:.3f} l S",
            "/CS0 CS", "0.137 0.123 0.126  SCN", "0.5 w", f"{x + 50:.3f} {y + 25:.3f} m {x + 70:.3f} {y + 150:.3f} l S",
            "BT", "/F1 8 Tf", f"{x + 96:.3f} {y + 84:.3f} Td", pdf_string(str(1008 + index * 2)) + " Tj", "ET",
        ]
    lines += ["Q"]
    return ("\n".join(lines) + "\n").encode("latin1")


def analysis_content() -> bytes:
    """Sparse labelled projection geometry matching the analysis parser contract."""
    pole_x, pole_y = 103.72, 365.93542811
    cone, scale, lon0 = 0.508691014, 399.25983365, 130.0
    lines = [
        "q", "2.834646 0 0 -2.834646 0.000000 432.154358 cm",
        "BT", "/F1 9 Tf", "1 0 0 1 45 760 Tm", pdf_string("Valid: 1800 UTC 25 Sep 2026") + " Tj", "ET",
        "BT", "/F1 8 Tf", "1 0 0 1 45 750 Tm", pdf_string("04am AEST 26/Sep./2026") + " Tj", "ET",
        "0.922 0.941 1.000 rg", "0 0 225.778 152.454 re", "f*",
        "0.945 0.945 0.863 rg", "30 20 165 120 re", "f*",
        "0.518 0.529 1.000 RG", "0.8 w", "25 50 m 80 80 l 130 60 l S",
        "0.000 0.000 1.000 RG", "0.8 w", "20 40 m 75 90 l S",
        "1.000 0.000 0.000 rg", "0.8 w", "130 50 m 180 100 l S",
        "0.647 0.647 0.647 RG", "0.5 w",
    ]
    for lon in (110, 120, 130, 140, 150):
        lines.append("0.647 0.647 0.647 RG")
        angle = cone * math.radians(lon - lon0)
        vx, vy = math.sin(angle), -math.cos(angle)
        lines.append(f"{pole_x - 150 * vx:.6f} {pole_y - 150 * vy:.6f} m {pole_x + 300 * vx:.6f} {pole_y + 300 * vy:.6f} l S")
        lx, ly = pole_x + 190 * vx, pole_y + 190 * vy
        lines += ["BT", "/F1 6 Tf", f"1 0 0 1 {lx:.6f} {ly:.6f} Tm", pdf_string(f"{lon}E") + " Tj", "ET"]
    for parallel_index, latitude in enumerate((-20, -30, -40, -50)):
        lines.append("0.647 0.647 0.647 RG")
        radius = scale * math.tan(math.pi / 4 + math.radians(latitude) / 2) ** cone
        points = []
        for step in range(5):
            angle = math.radians(-40 + step * 20)
            points.append((pole_x + radius * math.sin(angle), pole_y - radius * math.cos(angle)))
        lines.append(f"{points[0][0]:.6f} {points[0][1]:.6f} m")
        lines.extend(f"{x:.6f} {y:.6f} l" for x, y in points[1:])
        lines.append("S")
        lx, ly = points[4]
        lines += ["BT", "/F1 6 Tf", f"1 0 0 1 {lx:.6f} {ly:.6f} Tm", pdf_string(f"{abs(latitude)}S") + " Tj", "ET"]
    for x, y, label in ((70, 330, "1016"), (135, 410, "1020"), (115, 290, "H"), (155, 350, "L")):
        lines += ["BT", "/F1 8 Tf", f"1 0 0 1 {x} {y} Tm", pdf_string(label) + " Tj", "ET"]
    lines += ["0.490 0.490 0.333 RG", "0.3 w", "25 25 m 200 125 l S", "0.314 0.314 0.314 RG", "0.3 w", "30 120 m 205 30 l S", "Q"]
    return ("\n".join(lines) + "\n").encode("latin1")


def make_pdf(path: Path, kind: str) -> None:
    stream = zlib.compress(content(kind), 9)
    page_w, page_h = (640.0, 432.0) if kind == "analysis" else (PAGE_W, PAGE_H)
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page_w:.3f} {page_h:.3f}] /Resources << /Font << /F1 5 0 R /T1_1 5 0 R >> /ColorSpace << /CS0 /DeviceRGB >> /ExtGState << /GS1 6 0 R >> >> /Contents 4 0 R >>".encode(),
        b"<< /Length " + str(len(stream)).encode() + b" /Filter /FlateDecode >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Type /ExtGState /ca 1 /CA 1 >>",
    ]
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(output)); output.extend(f"{number} 0 obj\n".encode()); output.extend(obj); output.extend(b"\nendobj\n")
    xref = len(output); output.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    output.extend(b"\n".join(f"{offset:010d} 00000 n ".encode() for offset in offsets[1:])); output.extend(b"\n")
    output.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(output)


def main() -> None:
    parser = argparse.ArgumentParser(); parser.add_argument("output", type=Path); args = parser.parse_args()
    make_pdf(args.output / "IDG00073.pdf", "prognosis")
    make_pdf(args.output / "IDY00050.pdf", "analysis")


if __name__ == "__main__":
    main()
