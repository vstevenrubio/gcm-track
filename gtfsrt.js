// Minimal GTFS-realtime decoder for the LIRR feed, including the MTA railroad extension (field 1005 = track).
const GtfsRt = (() => {
  const URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr";
  const td = new TextDecoder();
  function varint(b, p) { let r = 0, s = 1, x; do { x = b[p++]; r += (x & 127) * s; s *= 128; } while (x & 128); return [r, p]; }
  function msg(b, start, end) {
    const o = {}; let p = start;
    while (p < end) {
      let k; [k, p] = varint(b, p); const f = Math.floor(k / 8), w = k % 8; let v;
      if (w === 0) { [v, p] = varint(b, p); if (v >= 2 ** 63) v -= 2 ** 64; }
      else if (w === 2) { let n; [n, p] = varint(b, p); v = [p, p + n]; p += n; }
      else if (w === 1) { p += 8; continue; } else if (w === 5) { p += 4; continue; }
      else throw new Error("bad protobuf");
      (o[f] ||= []).push(v);
    }
    return o;
  }
  function decode(buf) {
    const b = new Uint8Array(buf), s = r => td.decode(b.subarray(r[0], r[1]));
    const feed = msg(b, 0, b.length), header = msg(b, ...feed[1][0]);
    const trips = [];
    for (const er of feed[2] || []) {
      const e = msg(b, ...er); if (!e[3]) continue;
      const tu = msg(b, ...e[3][0]), t = msg(b, ...tu[1][0]);
      const id = t[1] ? s(t[1][0]) : "";
      const stops = (tu[2] || []).map(r => {
        const u = msg(b, ...r); let time = null;
        for (const f of [3, 2]) if (u[f]) { const ev = msg(b, ...u[f][0]); if (ev[2]) { time = ev[2][0]; break; } }
        let track = ""; if (u[1005]) { const x = msg(b, ...u[1005][0]); if (x[1]) track = s(x[1][0]); }
        return { stop: u[4] ? s(u[4][0]) : "", time, track };
      });
      trips.push({ id, train: id.split("_")[2] || id, date: t[3] ? s(t[3][0]) : "", dir: t[6] ? t[6][0] : null, canceled: (t[4] || [0])[0] === 3, stops });
    }
    return { timestamp: header[3] ? header[3][0] : null, trips };
  }
  async function fetchFeed() {
    const r = await fetch(URL, { cache: "no-store" });
    if (!r.ok) throw new Error("MTA feed " + r.status);
    return decode(await r.arrayBuffer());
  }
  return { decode, fetchFeed };
})();
