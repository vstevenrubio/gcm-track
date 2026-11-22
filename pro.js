// GCM Track Pro: what's free and what's Pro, in one place.
// Today everything is unlocked ("early access"). To start charging, set REQUIRED = true and have the
// App Store build call Pro.setUnlocked(true) after a successful in-app purchase.
const Pro = (() => {
  const REQUIRED = false;
  const KEY = "gcm-pro";
  const FREE = { saved: 1, daily: 1, historyDays: 7 };   // limits for free users once REQUIRED is on
  const FEATURES = [
    ["★", "My trains", "Save your regular trains and see them first, whichever station you pick."],
    ["🔁", "Every-day alerts", "Track-posted alerts for your commute every day it runs, without re-arming."],
    ["⏱", "Delay & cancellation alerts", "A push when your train runs 5+ minutes late or is canceled."],
    ["📊", "Full track history", "Every day's track for each train, and how often the MTA's plan held."],
  ];

  let unlockedFlag = false;
  try { unlockedFlag = localStorage.getItem(KEY) === "1"; } catch {}
  const unlocked = () => !REQUIRED || unlockedFlag;
  const limit = (k) => unlocked() ? Infinity : FREE[k];
  function setUnlocked(v) { unlockedFlag = !!v; try { localStorage.setItem(KEY, v ? "1" : "0"); } catch {} }

  // Show what Pro includes. `reason` explains which free limit was hit, if any.
  function show(reason = "") {
    const dlg = document.getElementById("pro");
    dlg.querySelector(".pro-reason").textContent = reason;
    dlg.querySelector(".pro-reason").hidden = !reason;
    dlg.querySelector(".pro-status").textContent = REQUIRED
      ? (unlockedFlag ? "You have Pro. Thanks for supporting GCM Track!" : "Pro is coming to the App Store.")
      : "Free during early access: everything below is already on.";
    dlg.querySelector(".pro-list").innerHTML = FEATURES.map(([icon, title, text]) =>
      `<li><span class="pro-icon">${icon}</span><div><b>${title}</b><br><span class="muted">${text}</span></div></li>`).join("");
    dlg.showModal();
  }

  return { REQUIRED, FREE, unlocked, limit, setUnlocked, show };
})();
