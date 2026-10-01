"""Frozen collector entry point; ordinary arguments pass through unchanged."""
from __future__ import annotations
import json
import sys


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if args == ["--check-runtime"]:
        import eccodes
        from isobar_data.config import load_config
        message = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
        try:
            values = eccodes.codes_get_values(message)
            encoded = eccodes.codes_get_message(message)
            decoded = eccodes.codes_new_from_message(encoded)
            try:
                assert len(values) == len(eccodes.codes_get_values(decoded)) > 0
            finally:
                eccodes.codes_release(decoded)
        finally:
            eccodes.codes_release(message)
        config = load_config()
        assert config.surface and config.bom_charts
        print(json.dumps({"grib": "ok", "config": "ok", "surfacePoints": len(config.surface)}))
        return 0
    from isobar_data.cli import main as collector_main
    return int(collector_main(args))


if __name__ == "__main__":
    raise SystemExit(main())
