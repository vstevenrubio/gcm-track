// GCM Track — predicts the Grand Central Madison track for your LIRR train (Mineola by default; any station via the picker).
const GCT = "349";
const VALID = ["201", "202", "203", "204", "301", "302", "303", "304"];
const TZ = "America/New_York";
const HALF_LIFE_DAYS = 45;          // older observations count less
const WINDOW_BEFORE = 15 * 60;      // keep departed trains visible for 15 min
const WINDOW_AFTER = 5 * 3600;      // look ahead 5 hours
const LOCAL_KEY = "gcm-local-history";
const DEST_KEY = "gcm-dest";
const MINEOLA = "132";

const TT_URL = "https://backend-unified.mylirr.org/arrivals/GCT"; // server behind the MTA TrainTime app (unofficial)
// true = use only the MTA's official public feed (safe for a paid/App Store build; tracks post a few minutes later,
// and no "planned" track). Keep in step with DATA_SOURCE in worker/wrangler.toml and OFFICIAL_ONLY in the workflow.
const OFFICIAL_ONLY = false;
const MINE_AHEAD = 24 * 3600;       // "My trains" looks a day ahead
const SAVED_KEY = "gcm-saved";

const state = { schedule: null, history: {}, planned: {}, live: new Map(), tt: new Map(), liveAt: null, filter: "direct", dest: MINEOLA, destIdx: null, error: null };

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

// ---------- destination ----------
const destName = () => state.schedule?.stations?.find(s => s.id === state.dest)?.name || "Mineola";
// Minutes from leaving GCM to arriving at the chosen station, or null if the train doesn't stop there.
function minsTo(trip) {
  const i = state.destIdx;
  if (i == null || !trip.x) return null;
  for (let k = 0; k < trip.x.length; k += 2) if (trip.x[k] === i) return trip.x[k + 1];
  return null;
}
function setDest(id) {
  state.dest = id;
  const i = state.schedule?.stations ? state.schedule.stations.findIndex(s => s.id === id) : -1;
  state.destIdx = i < 0 ? null : i;
  try { localStorage.setItem(DEST_KEY, id); } catch {}
  const name = destName();
  document.getElementById("dest-name").textContent = name;
  document.getElementById("f-direct").textContent = name + " trains";
  document.title = "GCM Track · " + name;
}

// ---------- my trains (saved train numbers) ----------
let saved = new Set();
try { saved = new Set(JSON.parse(localStorage.getItem(SAVED_KEY)) || []); } catch {}
function toggleSaved(train) {
  if (saved.has(train)) saved.delete(train);
  else if (saved.size >= Pro.limit("saved")) return Pro.show(`Free accounts can save ${Pro.FREE.saved} train.`);
  else saved.add(train);
  try { localStorage.setItem(SAVED_KEY, JSON.stringify([...saved])); } catch {}
  render();
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
    const similar = { scores: {}, n: 0 }, servesDest = minsTo(trip) != null;
    for (const o of state.schedule.trips) if (o.n !== trip.n && o.r === trip.r && Math.abs(o.d - trip.d) <= 3600 && (!servesDest || minsTo(o) != null)) tally(state.history[o.n], date, 0.35, similar);
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
  const [tt, rt] = await Promise.allSettled([OFFICIAL_ONLY ? Promise.reject(new Error("off")) : loadTrainTime(), loadGtfsRt()]);
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
    if (state.filter === "direct" && minsTo(t) == null) continue;
    if (state.filter === "mine" && !saved.has(t.n)) continue;
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
    const ahead = state.filter === "mine" ? MINE_AHEAD : WINDOW_AFTER;
    if (actual < now - WINDOW_BEFORE * 1000 || sched > now + ahead * 1000) continue;
    out.push({ t, date, sched, actual, live });
  }
  out.sort((a, b) => a.actual - b.actual);
  if (state.filter !== "mine") return out;
  const seen = new Set();   // My trains: just the next run of each saved train
  return out.filter(d => !seen.has(d.t.n) && seen.add(d.t.n));
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (p) => Math.round(p * 100) + "%";
function card({ t, date, sched, actual, live }) {
  const now = Date.now(), mins = Math.round((actual - now) / 60000);
  const late = Math.round((actual - sched) / 60000);
  const route = state.schedule.routes[t.r] || { name: "", color: "#888" };
  const when = live?.canceled ? "Canceled" : mins < 0 ? "departed" : mins === 0 ? "now" : `in ${mins} min`;
  const m = minsTo(t);
  const arrive = m != null ? ` · ${esc(destName())} ${fmtTime(actual + m * 60000)}` : "";
  let badge, where = "";
  // Badge: big track number, level (Upper/Lower) in small letters underneath.
  const level = (tr) => tr[0] === "3" ? "Lower" : "Upper";
  const trk = (kind, lbl, tr, foot) => `<div class="trk ${kind}"><div class="lbl">${lbl}</div>`
    + `<div class="num">${tr}</div><div class="pct">${foot}</div></div>`;
  const warn = live?.unusual ? `<br><span class="late">⚠ MTA flags an unusual track for this train today</span>` : "";
  const planned = live?.planned || state.planned[t.n]?.[date] || "";
  if (live?.track) {
    badge = trk("posted", "Posted", live.track, level(live.track));
    where = `<div class="where"><b>Track ${live.track}</b> · ${level(live.track)} level — head down now.${warn}</div>`;
  } else if (planned) {
    const rel = planReliability(date), hist = predict(t, date);
    badge = trk("guess", "Planned", planned, level(planned));
    const histNote = hist && hist.ranked[0].track !== planned ? ` · history says ${hist.ranked[0].track} ${pct(hist.ranked[0].p)}` : "";
    where = `<div class="where"><b>Track ${planned}</b> · ${level(planned)} level`
      + `<br><span class="alts">MTA's planned track${rel ? ` · right platform ${pct(rel.platform)} of the time, exact track ${pct(rel.track)} (${rel.n} departures)` : " · accuracy shown once a few days of data are in"}${histNote}</span>${warn}</div>`;
  } else {
    const p = predict(t, date);
    if (p) {
      const top = p.ranked[0], alts = p.ranked.slice(1, 3).map(x => `${x.track} ${pct(x.p)}`).join(", ");
      badge = trk("guess", "Likely", top.track, `${level(top.track)} · ${pct(top.p)}`);
      where = `<div class="where"><b>Track ${top.track}</b> · ${level(top.track)} level`
        + `<br><span class="alts">From ${p.n} past ${p.n === 1 ? "trip" : "trips"} of ${p.basis}${alts ? " · also " + alts : ""}</span></div>`;
    } else {
      badge = `<div class="trk none"><div class="lbl">Track</div><div class="num">?</div><div class="pct">no history yet</div></div>`;
    }
  }
  const star = saved.has(t.n);
  const day = state.filter === "mine" && date !== ymd(now) && date > ymd(now) ? `<small>tomorrow</small>` : "";
  return `<article class="card${mins < 0 ? " past" : ""}${live?.canceled ? " canceled" : ""}" style="--rc:${esc(route.color)}" data-train="${esc(t.n)}" data-date="${date}">
    <div class="time">${fmtTime(actual)}${day}<small>${when}</small><button class="star${star ? " on" : ""}" data-star="${esc(t.n)}" aria-label="${star ? "Remove from" : "Add to"} My trains">${star ? "★" : "☆"}</button></div>
    ${badge}
    <div class="sub">${esc(t.h)} · Train ${esc(t.n)}${late > 0 ? ` · <span class="late">${late} min late</span>` : ""}</div>
    <div class="sub">${esc(route.name)}${arrive} · <span class="hist-link">Track history ›</span></div>
    ${where}
    ${mins >= 0 && !live?.canceled ? `<div class="alert-row">${Alerts.button(t.n, date)}</div>` : ""}
  </article>`;
}
function render() {
  if (!state.schedule) return;
  const list = departures();
  const emptyMine = `<div class="empty">No saved trains yet.<br>Tap ☆ next to a train's time to add it here.</div>`;
  document.getElementById("list").innerHTML = list.length ? list.map(card).join("")
    : state.filter === "mine" ? (saved.size ? `<div class="empty">None of your saved trains run in the next 24 hours.</div>` : emptyMine) : `<div class="empty">No ${state.filter === "direct" ? "direct " + esc(destName()) + " " : ""}trains in the next ${WINDOW_AFTER / 3600} hours.${state.filter === "direct" && destName() !== "Jamaica" ? "<br>Try “All trains” and change at Jamaica." : ""}</div>`;
  document.getElementById("status").textContent = state.error
    || (state.liveAt ? `Live · updated ${fmtTime(state.liveAt)}` : "Schedule only");
}

// ---------- track history for one train ----------
function showHistory(train) {
  const trip = state.schedule.trips.find(t => t.n === train);
  const today = ymd(Date.now()), maxDays = Pro.limit("historyDays");
  const days = Object.entries(state.history[train] || {})
    .sort((a, b) => b[0].localeCompare(a[0]));
  const shown = days.filter(([d]) => maxDays === Infinity || daysBetween(today, d) < maxDays);
  const counts = {};
  for (const [, tr] of days) counts[tr] = (counts[tr] || 0) + 1;
  const bars = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tr, n]) =>
    `<div class="bar"><span class="bar-lbl">${tr}<small>${tr[0] === "3" ? "Lower" : "Upper"}</small></span>`
    + `<span class="bar-track"><span style="width:${Math.round(n / days.length * 100)}%"></span></span><span class="bar-n">${pct(n / days.length)}</span></div>`).join("");
  let match = 0, compared = 0;
  for (const [d, tr] of days) { const p = state.planned[train]?.[d]; if (p) { compared++; if (p === tr) match++; } }
  const fmtDay = (d) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" }).format(gtfsToEpoch(d, 43200));
  const rows = shown.map(([d, tr]) => { const p = state.planned[train]?.[d];
    return `<li><span>${fmtDay(d)}</span><b>${tr}</b><span class="muted">${p && p !== tr ? `planned ${p}` : p ? "as planned" : ""}</span></li>`; }).join("");
  const hidden = days.length - shown.length;
  document.getElementById("hist-title").textContent = `Train ${train}` + (trip ? ` · ${fmtTime(gtfsToEpoch(today, trip.d))} to ${trip.h}` : "");
  document.getElementById("hist-body").innerHTML = days.length ? `
    <p class="muted">Tracks used on ${days.length} recorded ${days.length === 1 ? "day" : "days"}${compared ? ` · MTA plan held ${match} of ${compared}` : ""}</p>
    <div class="bars">${bars}</div>
    <ul class="hist-days">${rows}</ul>
    ${hidden ? `<button class="link pro-more">See ${hidden} older ${hidden === 1 ? "day" : "days"} with Pro</button>` : ""}`
    : `<p class="muted">No track history for this train yet. It builds up automatically every day the train runs.</p>`;
  document.getElementById("hist").showModal();
}

// ---------- station picker ----------
function openPicker() {
  if (!state.schedule?.stations) return;
  const dlg = document.getElementById("picker"), q = document.getElementById("picker-q");
  q.value = ""; fillPicker(""); dlg.showModal();
  if (!matchMedia("(pointer: coarse)").matches) q.focus();
}
function fillPicker(query) {
  const qq = query.trim().toLowerCase();
  const list = state.schedule.stations.filter(s => s.name.toLowerCase().includes(qq)).sort((a, b) => a.name.localeCompare(b.name));
  document.getElementById("picker-list").innerHTML = list.map(s =>
    `<li><button data-id="${esc(s.id)}" class="${s.id === state.dest ? "on" : ""}">${esc(s.name)}${s.id === state.dest ? " ✓" : ""}</button></li>`).join("")
    || `<li class="muted">No station matches “${esc(query)}”</li>`;
}

async function refresh() {
  const btn = document.getElementById("refresh"); btn.classList.add("spin");
  await loadLive(); render(); btn.classList.remove("spin");
}
function setFilter(f) {
  state.filter = f;
  document.getElementById("f-direct").classList.toggle("on", f === "direct");
  document.getElementById("f-all").classList.toggle("on", f === "all");
  document.getElementById("f-mine").classList.toggle("on", f === "mine");
  try { localStorage.setItem("gcm-filter", f); } catch {}
  render();
}

(async function init() {
  try { const f = localStorage.getItem("gcm-filter"); if (f) state.filter = f; } catch {}
  try { state.dest = localStorage.getItem(DEST_KEY) || MINEOLA; } catch {}
  setDest(state.dest);
  const dlg = document.getElementById("picker");
  document.getElementById("dest").onclick = openPicker;
  document.getElementById("picker-q").oninput = (e) => fillPicker(e.target.value);
  document.getElementById("picker-close").onclick = () => dlg.close();
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) return dlg.close();                       // tap outside the sheet
    const b = e.target.closest("button[data-id]"); if (!b) return;
    setDest(b.dataset.id); dlg.close();
    if (state.filter !== "direct") setFilter("direct"); else render();
    window.scrollTo(0, 0);
  });
  setFilter(state.filter);
  document.getElementById("refresh").onclick = refresh;
  document.getElementById("f-direct").onclick = () => setFilter("direct");
  document.getElementById("f-all").onclick = () => setFilter("all");
  document.getElementById("f-mine").onclick = () => setFilter("mine");
  document.getElementById("pro-link").onclick = () => Pro.show();
  for (const d of document.querySelectorAll("dialog.sheet")) {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest(".close")) d.close(); });
  }
  document.getElementById("hist").addEventListener("click", (e) => {
    if (e.target.closest(".pro-more")) Pro.show(`Free accounts see the last ${Pro.FREE.historyDays} days.`);
  });
  document.getElementById("list").addEventListener("click", async (e) => {
    const st = e.target.closest(".star"); if (st) return toggleSaved(st.dataset.star);
    const c = e.target.closest(".card"); const b = e.target.closest(".bell");
    if (c && !b) return showHistory(c.dataset.train);
    if (!b || b.disabled) return;
    b.disabled = true; b.textContent = "Saving…";
    try { await Alerts.toggle(b.dataset.train, b.dataset.date); } catch (err) { alert("Couldn't set the alert: " + err.message); }
    render();
  });
  try { await loadStatic(); } catch (e) { document.getElementById("status").textContent = "Couldn't load schedule: " + e.message; return; }
  setDest(state.dest);
  render(); await refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  Alerts.sync().then(render);
})();
