#!/usr/bin/env python3
"""Compare frame-to-frame luminance changes; supplement visual video review."""
import json
import subprocess
import sys
import numpy as np


def measure(path):
    process = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-vf", "fps=30,scale=580:444",
        "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], stdout=subprocess.PIPE)
    previous = previous_delta = None
    changes, accelerations, large = [], [], []
    frames = 0
    try:
        while True:
            data = process.stdout.read(580*444)
            if not data:
                break
            if len(data) != 580*444:
                raise RuntimeError("Incomplete decoded frame")
            current = np.frombuffer(data, np.uint8).astype(np.float32)
            if previous is not None:
                delta = current - previous
                changes.append(float(np.abs(delta).mean()))
                large.append(float((np.abs(delta) > 60).mean()))
                if previous_delta is not None:
                    accelerations.append(float(np.abs(delta-previous_delta).mean()))
                previous_delta = delta
            previous = current
            frames += 1
        if process.wait() != 0:
            raise RuntimeError("Movie did not decode")
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait()
    return {"file": path, "sampledFrames": frames, "sampleFPS": 30, "meanChange": float(np.mean(changes)),
        "p95Change": float(np.percentile(changes,95)), "meanAcceleration": float(np.mean(accelerations)),
        "p95Acceleration": float(np.percentile(accelerations,95)), "largePixelChangeFraction": float(np.mean(large))}


if __name__ == "__main__":
    print(json.dumps([measure(path) for path in sys.argv[1:]], indent=2))
