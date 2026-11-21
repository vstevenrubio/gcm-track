// GCM Track — predicts the Grand Central Madison track for LIRR trains to Mineola.
const GCT = "349";
const VALID = ["201", "202", "203", "204", "301", "302", "303", "304"];
const TZ = "America/New_York";
const HALF_LIFE_DAYS = 45;          // older observations count less
const WINDOW_BEFORE = 15 * 60;      // keep departed trains visible for 15 min
const WINDOW_AFTER = 5 * 3600;      // look ahead 5 hours
const LOCAL_KEY = "gcm-local-history";

const TT_URL = "https://backend-unified.mylirr.org/arrivals/GCT"; // server behind the MTA TrainTime app

const state = { schedule: null, history: {}, planned: {}, live: new Map(), tt: new Map(), liveAt: null, filter: "direct", error: null };

// TrainTime "sched_track" codes: U1-U4 = upper level 201-204, L1-L4 = lower level 301-304.
const schedToTrack = (s) => /^[UL][1-4]$/.test(s || "") ? (s[0] === "U" ? "20" : "30") + s[1] : "";

// ---------- time helpers (always New York time, whatever the phone is set to) ----------
const nyParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
}).formatToParts(ms).map(p => [p.type, p.value]));
const ymd = (ms) => { const p = nyParts(ms); return p.year + p.month + p.day; };
function nyOffsetMs(ms) { const p = nyParts(ms); return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000; }
// GTFS time = seconds after (noon - 12h) on the service date, New York time.
function gtfsToEpoch(date, secs) {
  const noonGuess = Date.UTC(+date.slice(0, 4), date.slice(4, 6) - 1, +date.slice(6, 8), 12);
  const noon = noonGuess - nyOffsetMs(noonGuess);
  return noon - 12 * 3600e3 + secs * 1000;
}
const fmtTime = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(ms);
const daysBetween = (a, b) => Math.round((gtfsToEpoch(a, 43200) - gtfsToEpoch(b, 43200)) / 86400e3);
const isWeekend = (date) => { const d = new Date(gtfsToEpoch(date, 43200)).getUTCDay(); return d === 0 || d === 6; };

// ---------- history (shared file + what this phone has seen) ----------
function loadLocal() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}; } catch { return {}; } }
function saveLocal(h) { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(h)); } catch { /* private mode */ } }
function mergeHistory(shared) {
  const merged = {}, local = loadLocal();
  for (const src of [shared, local]) for (const [train, days] of Object.entries(src || {})) Object.assign(merged[train] ||= {}, days);
  state.history = merged;
}
function recordObservations(obs) {
  const local = loadLocal(); let changed = false;
  for (const { train, date, track } of obs) {
    if (date && VALID.includes(track) && local[train]?.[date] !== track) { (local[train] ||= {})[date] = track; changed = true; }
  }
  if (changed) { saveLocal(local); for (const [k, v] of Object.entries(local)) Object.assign(state.history[k] ||= {}, v); }
}
// How often the MTA's planned track turned out to be the real one (all trains, past days).
function planReliability(today) {
  let hit = 0, platHit = 0, n = 0;
  for (const [train, days] of Object.entries(state.planned)) for (const [date, plan] of Object.entries(days)) {
    const actual = state.history[train]?.[date];
    if (date < today && actual) { n++; if (actual === plan) hit++; if (platOf(actual) === platOf(plan)) platHit++; }
  }
  return n ? { track: hit / n, platform: platHit / n, n } : null;
}

// ---------- prediction ----------
function tally(obs, today, weight, out) {
  for (const [date, track] of Object.entries(obs || {})) {
    if (date >= today || !VALID.includes(track)) continue;
    const age = daysBetween(today, date);
    const sameKind = isWeekend(date) === isWeekend(today) ? 1 : 0.4;
    const w = weight * sameKind * Math.pow(0.5, age / HALF_LIFE_DAYS);
    out.scores[track] = (out.scores[track] || 0) + w; out.n++;
  }
}
function predict(trip, date) {
  let res = { scores: {}, n: 0, basis: "this train" };
  tally(state.history[trip.n], date, 1, res);
  if (res.n < 3) {
    // Not enough history for this exact train: borrow from same-branch trains leaving within an hour.
    const similar = { scores: {}, n: 0 };
    for (const o of state.schedule.trips) if (o.n !== trip.n && o.r === trip.r && Math.abs(o.d - trip.d) <= 3600) tally(state.history[o.n], date, 0.35, similar);
    if (res.n === 0 && similar.n) res = { ...similar, basis: "similar trains" };
    else for (const [k, v] of Object.entries(similar.scores)) res.scores[k] = (res.scores[k] || 0) + v;
  }
  const total = Object.values(res.scores).reduce((a, b) => a + b, 0);
  if (!total) return null;
  const ranked = Object.entries(res.scores).map(([track, s]) => ({ track, p: s / total })).sort((a, b) => b.p - a.p);
  const plat = {};
  for (const x of ranked) plat[platOf(x.track)] = (plat[platOf(x.track)] || 0) + x.p;
  const platforms = Object.entries(plat).map(([pk, p]) => ({ pk, p })).sort((a, b) => b.p - a.p);
  return { ranked, platforms, n: res.n, basis: res.basis };
}

// ---------- platforms: each level of each cavern is one island platform serving two tracks ----------
const platOf = (tr) => tr[0] + ("12".includes(tr[2]) ? "W" : "E");               // "304" -> "3E"
const platLevel = (pk) => pk[0] === "3" ? "Lower" : "Upper";
const platSide = (pk) => pk[1] === "W" ? "West" : "East";
const platName = (pk) => `${platLevel(pk)} level · ${platSide(pk)} platform`;
const platTracks = (pk) => pk[1] === "W" ? `${pk[0]}01/${pk[0]}02` : `${pk[0]}03/${pk[0]}04`;

// ---------- data loading ----------
async function loadStatic() {
  const [sched, hist] = await Promise.all([
    fetch("data/schedule.json", { cache: "no-cache" }).then(r => r.json()),
    fetch("data/history.json", { cache: "no-cache" }).then(r => r.ok ? r.json() : { trains: {} }).catch(() => ({ trains: {} })),
  ]);
  state.schedule = sched; mergeHistory(hist.trains); state.planned = hist.planned || {};
}
async function loadGtfsRt() {
  const feed = await GtfsRt.fetchFeed(), live = new Map(), obs = [];
  for (const t of feed.trips) {
    if (t.dir !== 0) continue;
    const s = t.stops.find(x => x.stop === GCT);
    if (s || t.canceled) live.set(t.train + "|" + t.date, { time: s?.time ?? null, track: VALID.includes(s?.track) ? s.track : "", canceled: t.canceled });
    if (s) obs.push({ train: t.train, date: t.date, track: s.track });
  }
  state.live = live; recordObservations(obs);
}
async function loadTrainTime() {
  const r = await fetch(TT_URL, { cache: "no-store", headers: { "Accept-Version": "3.0" } });
  if (!r.ok) throw new Error("TrainTime " + r.status);
  const tt = new Map(), obs = [];
  for (const a of (await r.json()).arrivals || []) {
    if (a.direction !== "E" || a.railroad !== "LIRR") continue;
    const date = (a.run_date || "").replace(/-/g, "");
    const rec = { time: a.time, track: VALID.includes(a.track) ? a.track : "", planned: schedToTrack(a.sched_track), canceled: !!a.status?.canceled, unusual: !!a.nonstandard_track };
    tt.set(a.train_num + "|" + date, rec);
    obs.push({ train: a.train_num, date, track: rec.track });
  }
  state.tt = tt; recordObservations(obs);
}
async function loadLive() {
  const [tt, rt] = await Promise.allSettled([loadTrainTime(), loadGtfsRt()]);
  if (tt.status === "rejected" && rt.status === "rejected") { state.error = "Live data unavailable (" + rt.reason.message + ")"; return; }
  state.liveAt = Date.now(); state.error = null;
}

// ---------- rendering ----------
function departures() {
  const now = Date.now(), { trips, services } = state.schedule;
  const dates = [ymd(now - 86400e3), ymd(now), ymd(now + 86400e3)];
  const out = [];
  for (const date of dates) for (const t of trips) {
    if (!services[t.s].includes(date)) continue;
    if (state.filter === "direct" && t.m == null) continue;
    const sched = gtfsToEpoch(date, t.d);
    const rt = state.live.get(t.n + "|" + date), tt = state.tt.get(t.n + "|" + date);
    const live = (rt || tt) && {
      time: tt?.time ?? rt?.time ?? null,
      track: tt?.track || rt?.track || "",
      planned: tt?.planned || state.planned[t.n]?.[date] || "",
      canceled: !!(tt?.canceled || rt?.canceled),
      unusual: !!tt?.unusual,
    };
    const actual = live?.time ? live.time * 1000 : sched;
    if (actual < now - WINDOW_BEFORE * 1000 || sched > now + WINDOW_AFTER * 1000) continue;
    out.push({ t, date, sched, actual, live });
  }
  return out.sort((a, b) => a.actual - b.actual);
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (p) => Math.round(p * 100) + "%";
function card({ t, date, sched, actual, live }) {
  const now = Date.now(), mins = Math.round((actual - now) / 60000);
  const late = Math.round((actual - sched) / 60000);
  const route = state.schedule.routes[t.r] || { name: "", color: "#888" };
  const when = live?.canceled ? "Canceled" : mins < 0 ? "departed" : mins === 0 ? "now" : `in ${mins} min`;
  const mineola = t.m != null ? ` · Mineola ${fmtTime(gtfsToEpoch(date, t.m) + (actual - sched))}` : "";
  let badge, where = "";
  // Badge headline = platform (level + side); exact track is secondary.
  const plat = (kind, lbl, pk, foot) => `<div class="trk ${kind}"><div class="lbl">${lbl}</div>`
    + `<div class="plat">${platLevel(pk)}<br>${platSide(pk)}</div><div class="pct">${foot}</div></div>`;
  const warn = live?.unusual ? `<br><span class="late">⚠ MTA flags an unusual track for this train today</span>` : "";
  const planned = live?.planned || state.planned[t.n]?.[date] || "";
  if (live?.track) {
    const pk = platOf(live.track);
    badge = plat("posted", "Posted", pk, `Track ${live.track}`);
    where = `<div class="where"><b>${platName(pk)}</b> · track ${live.track} — head down now.${warn}</div>`;
  } else if (planned) {
    const pk = platOf(planned), rel = planReliability(date), hist = predict(t, date);
    badge = plat("guess", "Planned", pk, `Track ${planned}`);
    const histNote = hist && hist.platforms[0].pk !== pk ? ` · history says ${platLevel(hist.platforms[0].pk)} ${platSide(hist.platforms[0].pk)} ${pct(hist.platforms[0].p)}` : "";
    where = `<div class="where"><b>${platName(pk)}</b> (tracks ${platTracks(pk)})`
      + `<br><span class="alts">MTA's planned track${rel ? ` · plan got the right platform ${pct(rel.platform)} of the time (exact track ${pct(rel.track)}, ${rel.n} departures)` : " · accuracy shown once a few days of data are in"}${histNote}</span>${warn}</div>`;
  } else {
    const p = predict(t, date);
    if (p) {
      const top = p.platforms[0], alt = p.platforms[1];
      badge = plat("guess", "Likely", top.pk, pct(top.p));
      where = `<div class="where"><b>${platName(top.pk)}</b> (tracks ${platTracks(top.pk)}) · most likely track ${p.ranked[0].track}`
        + `<br><span class="alts">From ${p.n} past ${p.n === 1 ? "trip" : "trips"} of ${p.basis}${alt ? ` · also ${platLevel(alt.pk)} ${platSide(alt.pk)} ${pct(alt.p)}` : ""}</span></div>`;
    } else {
      badge = `<div class="trk none"><div class="lbl">Platform</div><div class="num">?</div><div class="pct">no history yet</div></div>`;
    }
  }
  return `<article class="card${mins < 0 ? " past" : ""}${live?.canceled ? " canceled" : ""}" style="--rc:${esc(route.color)}">
    <div class="time">${fmtTime(actual)}<small>${when}</small></div>
    ${badge}
    <div class="sub">${esc(t.h)} · Train ${esc(t.n)}${late > 0 ? ` · <span class="late">${late} min late</span>` : ""}</div>
    <div class="sub">${esc(route.name)}${mineola}</div>
    ${where}
  </article>`;
}
function render() {
  if (!state.schedule) return;
  const list = departures();
  document.getElementById("list").innerHTML = list.length ? list.map(card).join("")
    : `<div class="empty">No ${state.filter === "direct" ? "direct Mineola " : ""}trains in the next ${WINDOW_AFTER / 3600} hours.${state.filter === "direct" ? "<br>Try “All trains” and change at Jamaica." : ""}</div>`;
  document.getElementById("status").textContent = state.error
    || (state.liveAt ? `Live · updated ${fmtTime(state.liveAt)}` : "Schedule only");
}

async function refresh() {
  const btn = document.getElementById("refresh"); btn.classList.add("spin");
  await loadLive(); render(); btn.classList.remove("spin");
}
function setFilter(f) {
  state.filter = f;
  document.getElementById("f-direct").classList.toggle("on", f === "direct");
  document.getElementById("f-all").classList.toggle("on", f === "all");
  try { localStorage.setItem("gcm-filter", f); } catch {}
  render();
}

(async function init() {
  try { const f = localStorage.getItem("gcm-filter"); if (f) state.filter = f; } catch {}
  setFilter(state.filter);
  document.getElementById("refresh").onclick = refresh;
  document.getElementById("f-direct").onclick = () => setFilter("direct");
  document.getElementById("f-all").onclick = () => setFilter("all");
  try { await loadStatic(); } catch (e) { document.getElementById("status").textContent = "Couldn't load schedule: " + e.message; return; }
  render(); await refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
