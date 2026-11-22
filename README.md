# GCM Track

iPhone web app that shows which Grand Central Madison track your LIRR train leaves from (pick your station; Mineola by default),
and predicts it before the MTA posts it.

* **Posted track**: read live from the MTA LIRR GTFS-realtime feed (no API key; it allows browser access).
* **Prediction**: how often each train used each track on past days (recent days and the same weekday/weekend
  type count more). Trains with little history borrow from same-branch trains leaving within an hour.
* History comes from `data/history.json` (kept up to date by the GitHub Action every 30 minutes) plus whatever
  your phone sees each time you open the app.

## Files
| Path | What |
|---|---|
| `index.html`, `app.js`, `style.css`, `gtfsrt.js` | the app |
| `data/schedule.json` | Grand Central departures, built by `scripts/build_schedule.py` from the MTA static GTFS |
| `data/history.json` | observed tracks per train per day, built by `scripts/log_tracks.py` |
| `.github/workflows/update-data.yml` | runs the logger every 30 min, refreshes the schedule daily |

## Run locally
```
python -m http.server 8000
```
then open http://localhost:8000.

## Put it on your iPhone
1. Push this folder to a GitHub repository and turn on **Settings → Pages → Deploy from branch → main / root**.
2. On the iPhone, open the Pages URL in **Safari** → Share → **Add to Home Screen**.
