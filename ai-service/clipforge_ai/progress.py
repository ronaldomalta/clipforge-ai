"""Progress reporting to the Node backend via stdout lines: `@@CF {json}`."""
import json
import sys
import time


class Progress:
    """Weighted stages → overall fraction. Only stages that will actually run are registered."""

    def __init__(self, stages):
        total = sum(w for _, w in stages) or 1.0
        self.offsets = {}
        acc = 0.0
        for name, weight in stages:
            self.offsets[name] = (acc / total, weight / total)
            acc += weight
        self._last = 0.0

    def update(self, stage, fraction, label, done=None, total=None, force=False):
        start, span = self.offsets.get(stage, (0.0, 0.0))
        overall = min(1.0, start + span * max(0.0, min(1.0, fraction)))
        now = time.monotonic()
        if not force and now - self._last < 0.5 and fraction < 1.0:
            return
        self._last = now
        payload = {"type": "progress", "stage": stage, "progress": round(overall, 4), "label": label}
        if done is not None and total:
            payload["done"] = round(float(done), 1)
            payload["total"] = round(float(total), 1)
        emit(payload)


def emit(payload):
    sys.stdout.write("@@CF " + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message):
    emit({"type": "log", "message": message})
