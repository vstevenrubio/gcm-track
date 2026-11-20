"""Record the track each Grand Central Madison departure actually used -> data/history.json.

The live feed keeps tracks for departures from the last ~2.5 hours, so running this
every 30-60 minutes captures every train.
"""
import datetime, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import gtfsrt

GCT = "349"
VALID = {"201", "202", "203", "204", "301", "302", "303", "304"}
KEEP_DAYS = 180
PATH = os.path.join(os.path.dirname(__file__), "..", "data", "history.json")


def main():
    hist = {}
    if os.path.exists(PATH):
        with open(PATH) as f:
            hist = json.load(f).get("trains", {})
    added = 0
    for t in gtfsrt.trips(gtfsrt.fetch()):
        if t["direction"] != 0 or not t["start_date"]:
            continue
        for st in t["stops"]:
            if st["stop"] == GCT and st["track"] in VALID:
                day = hist.setdefault(t["train"], {})
                if day.get(t["start_date"]) != st["track"]:
                    day[t["start_date"]] = st["track"]; added += 1
    cutoff = (datetime.date.today() - datetime.timedelta(days=KEEP_DAYS)).strftime("%Y%m%d")
    hist = {k: {d: v for d, v in sorted(days.items()) if d >= cutoff} for k, days in sorted(hist.items())}
    hist = {k: v for k, v in hist.items() if v}
    if added:
        with open(PATH, "w") as f:
            json.dump({"updated": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "trains": hist}, f, separators=(",", ":"))
    print(f"{added} new track observations; {len(hist)} trains in history")


if __name__ == "__main__":
    main()
