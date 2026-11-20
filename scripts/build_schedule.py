"""Build data/schedule.json: every outbound LIRR departure from Grand Central Madison,
flagging the ones that stop at Mineola."""
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
    stops = {}
    for r in rd("stop_times.txt"):
        if r["stop_id"] in (GCT, MINEOLA):
            stops.setdefault(r["trip_id"], {})[r["stop_id"]] = (int(r["stop_sequence"]), secs(r["departure_time"]))
    services, sidx, out = [], {}, []
    for tid, st in stops.items():
        tr = trips[tid]
        if GCT not in st or tr["direction_id"] != "0" or tr["service_id"] not in dates:
            continue
        if tr["service_id"] not in sidx:
            sidx[tr["service_id"]] = len(services); services.append(sorted(dates[tr["service_id"]]))
        m = st.get(MINEOLA)
        out.append({"id": tid, "n": tr["trip_short_name"], "s": sidx[tr["service_id"]], "d": st[GCT][1],
                    "m": m[1] if m and m[0] > st[GCT][0] else None, "h": tr["trip_headsign"], "r": tr["route_id"]})
    out.sort(key=lambda t: t["d"])
    with open(OUT, "w") as f:
        json.dump({"built": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "routes": routes, "services": services, "trips": out}, f, separators=(",", ":"))
    print(f"{len(out)} departures ({sum(1 for t in out if t['m'])} stop at Mineola), {len(services)} service patterns")


if __name__ == "__main__":
    main()
