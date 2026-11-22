// GCM Track alerts: every minute, check Grand Central Madison departures and push
// "Track posted", "Track change", "Running late" and "Canceled" notifications to subscribed iPhones.
// DATA_SOURCE = "traintime" (server behind the TrainTime app, fastest) or "mta" (official public feed only).
import { sendPush } from "./webpush.js";
import "../../gtfsrt.js";   // defines globalThis.GtfsRt

const RT_URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr";
const GCT = "349";
const DELAY_STEP = 5;      // minutes: alert at 5+ min late, then again each time it slips another 5

const TT_URL = "https://backend-unified.mylirr.org/arrivals/GCT";
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const MAX_WATCHES = 20;

const nyDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms).replace(/-/g, "");
const nyTime = (sec) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(sec * 1000);
const level = (tr) => tr[0] === "3" ? "Lower level" : "Upper level";
const validTrack = (t) => /^[23]0[1-4]$/.test(t || "");
// GTFS time = seconds after (noon - 12h) on the service date, New York time.
function nyOffsetMs(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(ms).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
function gtfsToSec(date, secs) {
  const guess = Date.UTC(+date.slice(0, 4), date.slice(4, 6) - 1, +date.slice(6, 8), 12);
  return Math.round((guess - nyOffsetMs(guess)) / 1000) - 12 * 3600 + secs;
}
const vapid = (env) => ({ publicKey: env.VAPID_PUBLIC, privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), subject: env.VAPID_SUBJECT });

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const ok = env.ALLOWED_ORIGINS.split(",").includes(origin);
  return { "Access-Control-Allow-Origin": ok ? origin : "null", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" };
}
const json = (data, headers, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json" } });

function validSubscription(s) {
  try {
    const u = new URL(s.endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some(r => r.test(u.hostname)) && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";
  } catch { return false; }
}
const validTrain = (t) => /^\d{1,5}$/.test(t || "");
const validDate = (d) => d === "" || /^\d{8}$/.test(d || "");

async function handle(req, env) {
  const h = cors(req, env), url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  if (req.method === "GET" && url.pathname === "/vapid") return json({ publicKey: env.VAPID_PUBLIC }, h);
  if (req.method !== "POST") return json({ error: "not found" }, h, 404);
  let body; try { body = await req.json(); } catch { return json({ error: "bad json" }, h, 400); }

  if (url.pathname === "/watch") {
    const { subscription: s, train, date } = body;
    if (!validSubscription(s) || !validTrain(train) || !validDate(date)) return json({ error: "invalid" }, h, 400);
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM watches WHERE endpoint = ?").bind(s.endpoint).first();
    if (n >= MAX_WATCHES) return json({ error: "too many alerts" }, h, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO watches (endpoint, sub, train, date, created) VALUES (?, ?, ?, ?, ?)")
      .bind(s.endpoint, JSON.stringify(s), train, date, Date.now()).run();
    return json({ ok: true }, h);
  }
  if (url.pathname === "/unwatch") {
    const { endpoint, train, date } = body;
    if (typeof endpoint !== "string" || !validTrain(train) || !validDate(date)) return json({ error: "invalid" }, h, 400);
    await env.DB.prepare("DELETE FROM watches WHERE endpoint = ? AND train = ? AND date = ?").bind(endpoint, train, date).run();
    return json({ ok: true }, h);
  }
  if (url.pathname === "/watches") {
    if (typeof body.endpoint !== "string") return json({ error: "invalid" }, h, 400);
    const { results } = await env.DB.prepare("SELECT train, date FROM watches WHERE endpoint = ?").bind(body.endpoint).all();
    return json({ watches: results }, h);
  }
  if (url.pathname === "/test") {
    if (!validSubscription(body.subscription)) return json({ error: "invalid" }, h, 400);
    const status = await sendPush(body.subscription, JSON.stringify({ title: "GCM Track alerts are on", body: "You'll get a notification here when your train's track is posted.", tag: "test" }), vapid(env));
    return json({ status }, h, status < 300 ? 200 : 502);
  }
  return json({ error: "not found" }, h, 404);
}

// Live GCM departures: train -> { date, track, time (epoch s), canceled }
async function liveDepartures(env) {
  const out = new Map();
  if (env.DATA_SOURCE === "mta") {
    const r = await fetch(RT_URL, { headers: { "User-Agent": "gcm-track-alerts" } });
    if (!r.ok) throw new Error("MTA feed " + r.status);
    for (const t of globalThis.GtfsRt.decode(await r.arrayBuffer()).trips) {
      if (t.dir !== 0) continue;
      const s = t.stops.find(x => x.stop === GCT);
      if (s || t.canceled) out.set(t.train, { date: t.date, track: validTrack(s?.track) ? s.track : "", time: s?.time ?? null, canceled: t.canceled });
    }
  } else {
    const r = await fetch(TT_URL, { headers: { "Accept-Version": "3.0", "User-Agent": "gcm-track-alerts" } });
    if (!r.ok) throw new Error("TrainTime " + r.status);
    for (const a of (await r.json()).arrivals || []) {
      if (a.direction !== "E" || a.railroad !== "LIRR") continue;
      out.set(a.train_num, { date: (a.run_date || "").replace(/-/g, ""), track: validTrack(a.track) ? a.track : "", time: a.time ?? null, canceled: !!a.status?.canceled });
    }
  }
  return out;
}

// Scheduled departure (epoch s) of a train on a date, from the app's own schedule file (cached for an hour).
async function scheduledDeparture(env, train, date) {
  globalThis.__sched ||= fetch(env.SCHEDULE_URL, { cf: { cacheTtl: 3600, cacheEverything: true } })
    .then(r => r.ok ? r.json() : null).catch(() => null);
  const sched = await globalThis.__sched;
  if (!sched) return null;
  const t = sched.trips.find(x => x.n === train && sched.services[x.s].includes(date));
  return t ? gtfsToSec(date, t.d) : null;
}

async function check(env) {
  const now = Date.now(), today = nyDate(now), yesterday = nyDate(now - 86400e3);
  await env.DB.prepare("DELETE FROM watches WHERE date != '' AND date < ?").bind(yesterday).run();
  const { results: watches } = await env.DB.prepare("SELECT id, endpoint, sub, train, date FROM watches WHERE date IN ('', ?, ?)").bind(today, yesterday).all();
  if (!watches.length) return;   // nobody to alert: skip calling the MTA

  let live;
  try { live = await liveDepartures(env); } catch (e) { console.log(e.message); return; }
  globalThis.__sched = null;      // re-read the (edge-cached) schedule once per run
  const gone = new Set(), schedCache = new Map();
  const push = async (w, title, body, tag) => {
    const status = await sendPush(JSON.parse(w.sub), JSON.stringify({ title, body, tag }), vapid(env));
    if (status === 404 || status === 410) { gone.add(w.endpoint); await env.DB.prepare("DELETE FROM watches WHERE endpoint = ?").bind(w.endpoint).run(); return false; }
    if (status >= 300) { console.log("push failed", status); return false; }
    return true;
  };
  const getEvent = (w, date, kind) => env.DB.prepare("SELECT value FROM events WHERE watch_id = ? AND date = ? AND kind = ?").bind(w.id, date, kind).first();
  const setEvent = (w, date, kind, value) => env.DB.prepare("INSERT OR REPLACE INTO events (watch_id, date, kind, value) VALUES (?, ?, ?, ?)").bind(w.id, date, kind, String(value)).run();

  for (const w of watches) {
    const p = live.get(w.train);
    if (!p || (w.date && w.date !== p.date) || gone.has(w.endpoint)) continue;
    const tag = `train-${w.train}-${p.date}`;

    if (p.canceled) {
      if (!(await getEvent(w, p.date, "cancel")) && await push(w, `Train ${w.train} is canceled`, `Your ${p.time ? nyTime(p.time) + " " : ""}train from Grand Central won't run today. Check the boards for the next one.`, tag))
        await setEvent(w, p.date, "cancel", 1);
      continue;
    }

    if (p.track) {
      const prev = await env.DB.prepare("SELECT track FROM sent WHERE watch_id = ? AND date = ?").bind(w.id, p.date).first();
      if (prev?.track !== p.track) {
        const title = prev ? `Track change: now ${p.track} · ${level(p.track)}` : `Track ${p.track} · ${level(p.track)}`;
        const body = `${p.time ? nyTime(p.time) + " " : ""}train ${w.train} from Grand Central${prev ? ` (was ${prev.track})` : ""}. Head down now.`;
        if (await push(w, title, body, tag))
          await env.DB.prepare("INSERT OR REPLACE INTO sent (watch_id, date, track) VALUES (?, ?, ?)").bind(w.id, p.date, p.track).run();
        if (gone.has(w.endpoint)) continue;
      }
    }

    if (p.time && p.time * 1000 > now) {
      const key = w.train + "|" + p.date;
      if (!schedCache.has(key)) schedCache.set(key, await scheduledDeparture(env, w.train, p.date).catch(() => null));
      const sched = schedCache.get(key);
      const late = sched ? Math.round((p.time - sched) / 60) : 0;
      const told = +((await getEvent(w, p.date, "delay"))?.value || 0);
      if (late >= DELAY_STEP && late >= told + DELAY_STEP) {
        if (await push(w, `Train ${w.train} running ${late} min late`, `Now leaves Grand Central at ${nyTime(p.time)} (scheduled ${nyTime(sched)}).`, `delay-${tag}`))
          await setEvent(w, p.date, "delay", late);
      }
    }
  }
  await env.DB.prepare("DELETE FROM sent WHERE date < ?").bind(yesterday).run();
  await env.DB.prepare("DELETE FROM events WHERE date < ?").bind(yesterday).run();
}

export default {
  fetch: (req, env) => handle(req, env).catch(e => new Response("error: " + e.message, { status: 500 })),
  scheduled: (event, env, ctx) => ctx.waitUntil(check(env)),
};
