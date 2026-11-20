"""Tiny dependency-free decoder for the LIRR GTFS-realtime feed (incl. MTA track extension 1005)."""
import urllib.request

FEED_URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr"


def _varint(b, p):
    r = s = 0
    while True:
        x = b[p]; p += 1
        r |= (x & 0x7F) << s; s += 7
        if not x & 0x80:
            return r, p


def msg(b, start=0, end=None):
    end = len(b) if end is None else end
    out, p = {}, start
    while p < end:
        k, p = _varint(b, p)
        f, w = k >> 3, k & 7
        if w == 0:
            v, p = _varint(b, p)
            if v >= 1 << 63:
                v -= 1 << 64
        elif w == 2:
            n, p = _varint(b, p)
            v = (p, p + n); p += n
        elif w == 1:
            p += 8; continue
        elif w == 5:
            p += 4; continue
        else:
            raise ValueError("bad wire type")
        out.setdefault(f, []).append(v)
    return out


def fetch():
    req = urllib.request.Request(FEED_URL, headers={"User-Agent": "gcm-track-logger"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def trips(b):
    """Yield dicts: trip_id, train, start_date, direction, canceled, stops[{stop, time, track}]."""
    s = lambda r: b[r[0]:r[1]].decode()
    feed = msg(b)
    for er in feed.get(2, []):
        e = msg(b, *er)
        if 3 not in e:
            continue
        tu = msg(b, *e[3][0])
        td = msg(b, *tu[1][0])
        trip_id = s(td[1][0]) if 1 in td else ""
        stops = []
        for r in tu.get(2, []):
            u = msg(b, *r)
            t = None
            for f in (3, 2):  # departure, then arrival
                if f in u:
                    ev = msg(b, *u[f][0])
                    if 2 in ev:
                        t = ev[2][0]; break
            track = ""
            if 1005 in u:
                ext = msg(b, *u[1005][0])
                if 1 in ext:
                    track = s(ext[1][0])
            stops.append({"stop": s(u[4][0]) if 4 in u else "", "time": t, "track": track})
        yield {
            "trip_id": trip_id,
            "train": trip_id.split("_")[2] if trip_id.count("_") >= 2 else trip_id,
            "start_date": s(td[3][0]) if 3 in td else "",
            "direction": td.get(6, [None])[0],
            "canceled": td.get(4, [0])[0] == 3,
            "stops": stops,
        }
