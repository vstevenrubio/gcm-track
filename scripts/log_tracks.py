"""Record the track each Grand Central Madison departure actually used -> data/history.json.

The live feed keeps tracks for departures from the last ~2.5 hours, so running this
every 30-60 minutes captures every train.
"""
import datetime, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import gtfsrt, traintime

GCT = "349"
VALID = {"201", "202", "203", "204", "301", "302", "303", "304"}
KEEP_DAYS = 180
PATH = os.path.join(os.path.dirname(__file__), "..", "data", "history.json")


def main():
    hist, planned = {}, {}
    if os.path.exists(PATH):
        with open(PATH) as f:
            old = json.load(f)
            hist, planned = old.get("trains", {}), old.get("planned", {})
    added = 0

    def put(store, train, date, track):
        nonlocal added
        day = store.setdefault(train, {})
        if day.get(date) != track:
            day[date] = track; added += 1

    try:  # TrainTime server: planned track for upcoming trains, posted track shortly before departure
        for d in traintime.departures():
            if d["train"] and d["date"]:
                if d["planned"] in VALID:
                    put(planned, d["train"], d["date"], d["planned"])
                if d["track"] in VALID:
                    put(hist, d["train"], d["date"], d["track"])
    except Exception as e:
        print("TrainTime server unavailable:", e)
    for t in gtfsrt.trips(gtfsrt.fetch()):
        if t["direction"] != 0 or not t["start_date"]:
            continue
        for st in t["stops"]:
            if st["stop"] == GCT and st["track"] in VALID:
                put(hist, t["train"], t["start_date"], st["track"])
    cutoff = (datetime.date.today() - datetime.timedelta(days=KEEP_DAYS)).strftime("%Y%m%d")
    trim = lambda h: {k: v for k, v in ((k, {d: t for d, t in sorted(days.items()) if d >= cutoff}) for k, days in sorted(h.items())) if v}
    hist, planned = trim(hist), trim(planned)
    if added:
        with open(PATH, "w") as f:
            json.dump({"updated": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "trains": hist, "planned": planned}, f, separators=(",", ":"))
    print(f"{added} new track observations; {len(hist)} trains in history")


if __name__ == "__main__":
    main()
