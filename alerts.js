// Track-posted push alerts. Each train's bell cycles: off -> today -> every day -> off.
// The alert service (Cloudflare Worker in /worker) watches the MTA every minute and sends the push.
const Alerts = (() => {
  const API = "https://gcm-track-alerts.trainplatform.workers.dev";
  const KEY = "gcm-alerts";
  let watches = new Set();   // "train|date" (date "" = every day it runs)
  try { watches = new Set(JSON.parse(localStorage.getItem(KEY)) || []); } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify([...watches])); } catch {} };

  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const installed = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  function mode(train, date) { return watches.has(train + "|") ? "daily" : watches.has(train + "|" + date) ? "today" : "off"; }
  function button(train, date) {
    const m = mode(train, date);
    const text = { off: "🔕 Alert me when the track posts", today: "🔔 Alert on · today", daily: "🔁 Alert on · every day" }[m];
    return `<button class="bell ${m}" data-train="${train}" data-date="${date}">${text}</button>`;
  }

  async function post(path, body) {
    const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "alert service " + r.status);
    return r.json();
  }
  const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4)), c => c.charCodeAt(0));

  async function subscription() {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) return { sub, isNew: false };
    if (await Notification.requestPermission() !== "granted") throw new Error("Notifications are turned off for GCM Track. Turn them on in iPhone Settings → Notifications → GCM Track.");
    const { publicKey } = await (await fetch(API + "/vapid")).json();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    return { sub, isNew: true };
  }

  async function toggle(train, date) {
    if (!supported() || (isIos && !installed())) {
      alert("To get track alerts, add GCM Track to your Home Screen first:\n\nIn Safari tap Share → Add to Home Screen, then open GCM Track from the icon and tap the bell again.");
      return;
    }
    const { sub, isNew } = await subscription();
    const s = sub.toJSON(), cur = mode(train, date);
    if (cur === "off") { await post("/watch", { subscription: s, train, date }); watches.add(train + "|" + date); }
    else if (cur === "today" && [...watches].filter(w => w.endsWith("|")).length >= Pro.limit("daily")) {
      await post("/unwatch", { endpoint: s.endpoint, train, date }); watches.delete(train + "|" + date); save();
      Pro.show(`Free accounts get ${Pro.FREE.daily} every-day alert.`); return;
    } else if (cur === "today") {
      await post("/unwatch", { endpoint: s.endpoint, train, date });
      await post("/watch", { subscription: s, train, date: "" });
      watches.delete(train + "|" + date); watches.add(train + "|");
    } else { await post("/unwatch", { endpoint: s.endpoint, train, date: "" }); watches.delete(train + "|"); }
    save();
    if (isNew) post("/test", { subscription: s }).catch(() => {});
  }

  // Bring local state in line with the server (e.g. after the app was reinstalled).
  async function sync() {
    if (!supported()) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration(); const sub = await reg?.pushManager.getSubscription();
      if (!sub) { if (watches.size) { watches.clear(); save(); } return; }
      const { watches: list } = await post("/watches", { endpoint: sub.endpoint });
      watches = new Set(list.map(w => w.train + "|" + w.date)); save();
    } catch { /* offline: keep local copy */ }
  }

  return { button, toggle, sync };
})();
