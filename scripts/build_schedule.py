"""Build data/schedule.json: every outbound LIRR departure from Grand Central Madison,
with every later stop, so the app can filter by whichever station you're going to.

Each trip's "x" is a flat list [station index, minutes after leaving GCM, ...] into "stations"."""
import csv, datetime, io, json, os, urllib.request, zipfile

GTFS_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip"
GCT, MINEOLA = "349", "132"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "schedule.json")


def secs(t):
    h, m, s = map(int, t.split(":")); return h * 3600 + m * 60 + s


def main():
    req = urllib.request.Request(GTFS_URL, headers={"User-Agent": "gcm-track-builder"})
    z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(req, timeout=60).read()))
    rd = lambda n: csv.DictReader(io.TextIOWrapper(z.open(n), encoding="utf-8-sig"))
    routes = {r["route_id"]: {"name": r["route_long_name"], "color": "#" + (r["route_color"] or "0039A6")} for r in rd("routes.txt")}
    trips = {r["trip_id"]: r for r in rd("trips.txt")}
    today = (datetime.date.today() - datetime.timedelta(days=1)).strftime("%Y%m%d")
    dates = {}
    for r in rd("calendar_dates.txt"):
        if r["exception_type"] == "1" and r["date"] >= today:
            dates.setdefault(r["service_id"], []).append(r["date"])
    names = {r["stop_id"]: r["stop_name"] for r in rd("stops.txt")}
    stops = {}
    for r in rd("stop_times.txt"):
        if r.get("drop_off_type") == "1" and r["stop_id"] != GCT:
            continue  # train doesn't let passengers off here (e.g. a yard)
        stops.setdefault(r["trip_id"], []).append((int(r["stop_sequence"]), r["stop_id"], secs(r["arrival_time"] or r["departure_time"]), secs(r["departure_time"])))
    services, sidx, out, stations, stidx = [], {}, [], [], {}
    for tid, st in stops.items():
        tr = trips[tid]
        if tr["direction_id"] != "0" or tr["service_id"] not in dates:
            continue
        st.sort()
        g = next((i for i, x in enumerate(st) if x[1] == GCT), None)
        if g is None:
            continue
        if tr["service_id"] not in sidx:
            sidx[tr["service_id"]] = len(services); services.append(sorted(dates[tr["service_id"]]))
        dep, x, m = st[g][3], [], None
        for _, sid, arr, _ in st[g + 1:]:
            if sid not in stidx:
                stidx[sid] = len(stations); stations.append({"id": sid, "name": names.get(sid, sid)})
            x += [stidx[sid], round((arr - dep) / 60)]
            if sid == MINEOLA: m = arr
        out.append({"id": tid, "n": tr["trip_short_name"], "s": sidx[tr["service_id"]], "d": dep,
                    "m": m, "h": tr["trip_headsign"], "r": tr["route_id"], "x": x})
    out.sort(key=lambda t: t["d"])
    with open(OUT, "w") as f:
        json.dump({"built": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "routes": routes, "services": services, "stations": stations, "trips": out}, f, separators=(",", ":"))
    print(f"{len(out)} departures ({sum(1 for t in out if t['m'])} stop at Mineola), {len(services)} service patterns, {len(stations)} stations")


if __name__ == "__main__":
    main()
