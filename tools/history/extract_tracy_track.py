#!/usr/bin/env python3
"""Extract the bounded 24–26 Dec 1974 BOM Tracy slice from an IBTrACS HTML record.

The parser deliberately uses named HTML columns; flattened browser text loses blank
agency cells and shifts wind values into the wrong agency.
"""
from __future__ import annotations
import argparse, json
from pathlib import Path
import pandas as pd

def _times(frame: pd.DataFrame) -> list[str]:
    out, day = [], None
    for value in frame["ISO_TIME_________"]:
        text = str(value)
        if text.startswith("1974-"):
            day, clock = text.split(" ")
        elif day is not None:
            clock = text
        else:
            out.append(text); continue
        out.append(f"{day} {clock}")
    return out

def _num(row: pd.Series, key: str):
    value = row[key]
    return None if pd.isna(value) else float(value)

def extract(path: Path) -> list[dict]:
    tables = pd.read_html(path)
    summary, full = tables[3], tables[5]
    summary["time"], full["time"] = _times(summary), _times(full)
    by_time = {row["time"]: row for _, row in summary.iterrows()}
    records = []
    for _, row in full.iterrows():
        time = row["time"]
        if not (time.startswith("1974-12-24") or time.startswith("1974-12-25") or time == "1974-12-26 00:00:00"):
            continue
        if _num(row, "BOM WIND") is None and _num(row, "BOM PRES") is None:
            continue
        source = by_time.get(time)
        record = {
            "time": time.replace(" ", "T") + "Z",
            "lat": _num(row, "BOM LAT"), "lon": _num(row, "BOM LON"), "position_source": "BOM",
            "composite_lat": _num(row, "LAT"), "composite_lon": _num(row, "LON"),
            "bom_wind_kt": _num(row, "BOM WIND"), "bom_pressure_hpa": _num(row, "BOM PRES"),
            "usa_wind_kt": _num(row, "USA WIND"),
            "wmo_wind_kt": None if source is None or pd.isna(source["WMO WIND"]) else float(source["WMO WIND"]),
            "wmo_pressure_hpa": None if source is None or pd.isna(source["WMO PRES"]) else float(source["WMO PRES"]),
            "bom_rmw_nm": _num(row, "BOM RMW"),
            "ibtracs_iflag": None if pd.isna(row["IFLAG"]) else str(row["IFLAG"]),
        }
        if time == "1974-12-24 17:30:00":
            record["landfall_relation"] = "nearest retained BOM fix to IBTrACS summary landfall at 17:00Z"
        records.append(record)
    return records

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("html", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    payload = {"observations": extract(args.html)}
    text = json.dumps(payload, indent=2) + "\n"
    if args.output: args.output.write_text(text)
    else: print(text, end="")
    return 0

if __name__ == "__main__": raise SystemExit(main())
