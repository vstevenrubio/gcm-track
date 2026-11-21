"""Read the MTA TrainTime server (the one the TrainTime app uses) for Grand Central Madison departures.
It posts tracks earlier than the GTFS-realtime feed and also gives the planned track (sched_track)."""
import json, urllib.request

URL = "https://backend-unified.mylirr.org/arrivals/GCT"


def sched_to_track(s):
    """'U2' -> '202' (upper level), 'L4' -> '304' (lower level)."""
    if s and len(s) == 2 and s[0] in "UL" and s[1] in "1234":
        return ("2" if s[0] == "U" else "3") + "0" + s[1]
    return ""


def departures():
    req = urllib.request.Request(URL, headers={"Accept-Version": "3.0", "User-Agent": "gcm-track-logger"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    for a in data.get("arrivals", []):
        if a.get("direction") != "E" or a.get("railroad") != "LIRR":
            continue
        yield {"train": a.get("train_num", ""), "date": a.get("run_date", "").replace("-", ""),
               "track": a.get("track", ""), "planned": sched_to_track(a.get("sched_track"))}
