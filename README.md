# Virtual Pipeline

**Early warnings for desert wells. Challenge W-001, Water & Climate AI.**
Team: Stephen and Ameiya.

Herders find out a well is failing when the bucket comes up empty. Virtual Pipeline forecasts every
well in an area, says how sure it is, and weeks ahead tells each herder which nearby well still has
water to spare, and tells the aid agency where trucks are needed first. No pipes: the herds and the
trucks are the pipeline.

## Run it

```bash
python3 server.py          # needs only Python 3, nothing to install
```

Open <http://localhost:8000> in Chrome. Works with no internet.

- **Replay 2019 to 2023**: drag the timeline or press Play to walk through the real drought.
- **Live demo**: well W12 starts on 20 May 2022, seven weeks before it ran dry. One second is one
  day. Drain it, unplug its sensor, text a rope colour from the phone, and watch the chain respond.

## The chain: data, prediction, warning

| Step | What happens | Where |
|---|---|---|
| 1. Data | Real satellite and climate records for three areas of northern Kenya (Mandera, Wajir, North Horr), plus each well's level sensor, herders' rope texts and herd counts | `pipeline/01_prepare_data.py`, `02_simulate_wells.py` |
| 2. Prediction | Water level 7, 14, 21, 28 and 42 days ahead, as a low / likely / high range. From that: days left, and the chance of running dry within 4 weeks | `pipeline/03_train_model.py`, `web/model.js` |
| 3. Warning | Two levels by SMS. **Watch**: ration. **Act**: move the herd to a named well by a date, or trucks are requested. The aid agency gets a ranked list | `web/app.js` |

### What is real and what is simulated

| Real, public data | Simulated, and labelled as such |
|---|---|
| CHIRPS daily rainfall | Well water levels (daily water balance driven by the real rain, heat and GRACE) |
| NASA POWER temperature, humidity, wind | Level-sensor readings, including outages |
| MODIS NDVI (16-day vegetation) | Herders' rope texts and herd counts |
| Sentinel-2 NDVI with cloud fraction per image | The nine wells themselves: named after real settlements, but illustrative |
| GRACE-FO groundwater storage anomaly | |

Public water-level records for pastoral wells in this region do not exist, so the wells are simulated
on top of the real 2019 to 2023 climate. The 2021 to 2022 drought in the data is real: Mandera had
405 mm of rain in 2019 and 126 mm in 2022.

## Our angle

1. **The virtual pipeline.** A warning that only says "your well is failing" leaves the herder with
   the same bad options. Ours names the nearest well that can take the herd, checks that the extra
   animals will not push that well into a warning too, and gives a leave-by date that allows for
   the walk. Whatever no neighbour can absorb becomes a truck request.
2. **The painted rope.** Paint the well rope in four bands. The herder texts the colour at the
   waterline: `W12 Y`. It costs almost nothing, works on any phone, and turns every herder into a
   sensor that cannot run out of battery.

## The desert rules

**Sparse, messy data.** Every forecast is made in one of three modes, chosen by what is alive that day:

| Data available | Range width 4 weeks out | Failures warned (of 204) |
|---|---|---|
| Level sensor | 0.9 m | 199 |
| Rope texts only (sensor dead) | 1.9 m | 167 |
| Satellite and rain only | 2.4 m | 84 |

The range widens by itself because each mode was trained on that poorer input, and in every mode
about 8 in 10 real outcomes land inside the stated range. The SMS says "less certain", and in
satellite-only mode the system asks herders for a rope reading, because that mode alone is not
good enough to rely on. Cloudy Sentinel-2 images (618 of the 1,439 real scenes) are dropped; the
last clear one is carried forward with its age, and the cloud-robust MODIS composite fills in.
GRACE and MODIS are only used after their real publication delay.

**Basic phones, patchy coverage.** Everything a herder needs is one SMS under 160 characters, in
English, Kiswahili or Somali. Reports come back as SMS codes. Nothing needs a smartphone or data.

**False alarms against misses.** One slider sets how sure the system must be before saying "move".
The dashboard shows what each setting costs, measured on wells the model never saw:

| | Virtual Pipeline (25% setting) | Straight-line rule of thumb |
|---|---|---|
| Failures warned before they happened | 199 of 204 | 200 of 204 |
| Flagged 3 or more weeks ahead (Watch or Act) | 175 | 124 |
| False alarms in 225 well-years | **25** | **130** |

Watch (ration, low cost if wrong) fires earlier than Act (move, high cost if wrong), an alert needs
two days in a row to switch on, and herders reply 1 or 2 to tell us whether a warning was right.

## Method

- **Model:** gradient-boosted trees with quantile loss, 45 small models (3 data modes x 5 horizons
  x 3 quantiles), trained on 45 simulated wells.
- **Test:** 45 other wells never seen in training, replayed day by day through 2019 to 2023 with
  the same alert logic the dashboard runs. `web/data/eval.json` holds every number above.
- **Harder test:** train on two regions, test on the third. Ranges still hold 73 to 77% of
  outcomes (target 80%), so a new region needs some local recalibration.
- **Same engine everywhere:** the browser runs the exported trees itself.
  `node pipeline/04_check_js.mjs` confirms it matches Python to 7 decimal places.

Limits worth knowing: the wells are simulated, so real-world accuracy is unproven until tested on
field data; with a working sensor the model leans mostly on the level trend, and satellite data
matters most when the ground goes quiet; the Kiswahili and Somali SMS texts are drafts that need a
native speaker's check; the planning figures (2,500 litres per herd per day, 15 km walked per day,
3 cm of drawdown per extra herd over 4 weeks) are assumptions to tune locally.

## Live sensor on a pi-top (optional)

The ultrasonic sensor points down at the water in a wide clear container. It never touches water.

1. Laptop and pi-top on the same WiFi or phone hotspot. Start `python3 server.py`.
2. In the dashboard choose **Live demo**, then **Connect a pi-top**. It shows the exact command for
   your laptop's address and a download link for `well_sensor.py`.
3. On the pi-top: sensor in port D3, then `python3 well_sensor.py <laptop-address>`.
4. Calibrate once: container full, press **Bottle is full now**; pour it out, press **Bottle is
   empty now**; refill.
5. Pour water out. The 3D bottle and the well drop together, the forecast shrinks, a banner and a
   tone announce the warning, the SMS lands on the phone, and the pi-top's own screen shows
   WATCH or ACT. Pour down to under a tenth full to reach Act: a low but steady well is not failing.
6. Pull the sensor cable: the dashboard shows the sensor offline and falls back to rope texts.

No pi-top? `python3 pitop/fake_sensor.py` pretends to be one, or use the Drain and Unplug buttons.

## Real SMS (optional)

With a Twilio account, set four variables before starting the server and the Act warning for W12
is sent to a real phone in the live demo:

```bash
export TWILIO_SID=ACxxxxxxxx TWILIO_TOKEN=xxxxxxxx TWILIO_FROM=+1xxxxxxxxxx ALERT_TO=+9715xxxxxxxx
python3 server.py
```

Without them the SMS is shown on the phone on screen.

## Rebuild from the raw data

```bash
pip install -r pipeline/requirements.txt
python3 pipeline/01_prepare_data.py     # clean the real data
python3 pipeline/02_simulate_wells.py   # simulate wells on top of it
python3 pipeline/03_train_model.py      # train, test, export to web/data (about 2 minutes)
node pipeline/04_check_js.mjs           # browser engine matches Python
```

`gee/gee_export.js` is the Google Earth Engine script that produced the satellite CSVs in `data/raw`.
The NASA POWER files come from its public API for the same three points.
