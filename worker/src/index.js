// GCM Track alerts: every minute, check the MTA TrainTime server for Grand Central Madison
// departures and push "Track posted" / "Track change" notifications to subscribed iPhones.
import { sendPush } from "./webpush.js";

const TT_URL = "https://backend-unified.mylirr.org/arrivals/GCT";
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const MAX_WATCHES = 20;

const nyDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms).replace(/-/g, "");
const nyTime = (sec) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(sec * 1000);
const level = (tr) => tr[0] === "3" ? "Lower level" : "Upper level";
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

async function check(env) {
  const now = Date.now(), today = nyDate(now), yesterday = nyDate(now - 86400e3);
  await env.DB.prepare("DELETE FROM watches WHERE date != '' AND date < ?").bind(yesterday).run();
  const { results: watches } = await env.DB.prepare("SELECT id, endpoint, sub, train, date FROM watches WHERE date IN ('', ?, ?)").bind(today, yesterday).all();
  if (!watches.length) return;   // nobody to alert: skip calling the MTA

  const r = await fetch(TT_URL, { headers: { "Accept-Version": "3.0", "User-Agent": "gcm-track-alerts" } });
  if (!r.ok) { console.log("TrainTime", r.status); return; }
  const posted = new Map();
  for (const a of (await r.json()).arrivals || []) {
    if (a.direction !== "E" || a.railroad !== "LIRR" || !/^[23]0[1-4]$/.test(a.track || "")) continue;
    posted.set(a.train_num, { date: (a.run_date || "").replace(/-/g, ""), track: a.track, time: a.time, dest: (a.stops || []).slice(-1)[0] || "" });
  }
  const gone = new Set();
  for (const w of watches) {
    const p = posted.get(w.train);
    if (!p || (w.date && w.date !== p.date) || gone.has(w.endpoint)) continue;
    const prev = await env.DB.prepare("SELECT track FROM sent WHERE watch_id = ? AND date = ?").bind(w.id, p.date).first();
    if (prev?.track === p.track) continue;
    const title = prev ? `Track change: now ${p.track} · ${level(p.track)}` : `Track ${p.track} · ${level(p.track)}`;
    const body = `${nyTime(p.time)} train ${w.train} from Grand Central${prev ? ` (was ${prev.track})` : ""}. Head down now.`;
    const status = await sendPush(JSON.parse(w.sub), JSON.stringify({ title, body, tag: `train-${w.train}-${p.date}` }), vapid(env));
    if (status === 404 || status === 410) { gone.add(w.endpoint); await env.DB.prepare("DELETE FROM watches WHERE endpoint = ?").bind(w.endpoint).run(); continue; }
    if (status >= 300) { console.log("push failed", status); continue; }
    await env.DB.prepare("INSERT OR REPLACE INTO sent (watch_id, date, track) VALUES (?, ?, ?)").bind(w.id, p.date, p.track).run();
  }
  await env.DB.prepare("DELETE FROM sent WHERE date < ?").bind(yesterday).run();
}

export default {
  fetch: (req, env) => handle(req, env).catch(e => new Response("error: " + e.message, { status: 500 })),
  scheduled: (event, env, ctx) => ctx.waitUntil(check(env)),
};
