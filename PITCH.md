# Pitch and demo script

About 4 minutes. Stephen drives the laptop (and the bottle, if the pi-top is there). Ameiya speaks
to the judges. Swap if you prefer, but keep one person on the laptop the whole time.

## Before you start

- `python3 server.py`, open <http://localhost:8000> in Chrome, full screen (Cmd+Ctrl+F).
- Replay mode, Mandera, W12 selected, timeline dragged to early **April 2022**. Paused.
- pi-top: script running, container full, calibrated (full, then empty, then refilled).
- Phone tab open on the right.

## 1. The problem (Ameiya, 30 seconds)

> "In northern Kenya a herder learns his well is failing when the bucket comes up empty. By then
> the animals are too weak to walk to the next one. The same failure, known four weeks earlier, is
> a change of plan. Known on the day, it is a dead herd. So we built the four weeks."

## 2. The chain on real data (Stephen drives, Ameiya talks, 60 seconds)

1. Point at the timeline. "These bars are real rainfall at Mandera from satellite. 405 millimetres
   in 2019. 126 in 2022. That is the drought."
2. Press **Play** from April 2022. Let it run to about **20 June**, then **Pause**.
   "W12 goes to Watch on the first of June: start rationing. On the 19th it goes to Act."
3. Point at the chart. "We never give one number. Likely dry in about three weeks, and the shaded
   band is where 8 in 10 outcomes land."
4. Point at the phone. "This is what the herder gets. One SMS, any phone: move to W07 Fino, 26
   kilometres, two days' walk, leave by this date."
5. Point at the arc in the 3D view. "That is the virtual pipeline. No pipes. We checked W07 can
   take those herds without being drained itself. What no neighbour can take goes to the aid
   agency as a truck request." Click **Aid agency** for two seconds.
6. Tick **Show what actually happened next**. "Dotted line is what happened. It ran dry on 12 July.
   The warning to move came 23 days before."

## 3. Live: break it (Stephen, 60 seconds)

1. Click **Live demo**. "One second is one day. This bottle is well W12."
2. Pour water out (or press **Drain well** four times). Level drops in the cutaway, days left
   shrinks, status flips, the SMS arrives.
3. **Pull the sensor cable** (or press **Unplug sensor**). "Sensors die in the desert. Watch."
   The dashboard shows the sensor offline and switches to rope texts. "The range gets wider and the
   message says less certain. It does not go silent and it does not pretend."
4. On the phone press **W12 R**. "The herder reads the colour on a painted rope and texts it. That
   is our backup sensor. It costs a tin of paint."

## 4. Trust (Ameiya, 40 seconds)

Click **False alarms vs misses**. Drag the slider left and right once.

> "A false alarm costs trust. A miss costs lives. This slider is that trade, measured on 45 wells
> the model never saw. At our setting we warned 199 of 204 failures, 175 of them three or more
> weeks ahead, with 25 false alarms in 225 well-years. A simple straight-line rule catches as many
> but cries wolf 130 times."

## 5. Close (Ameiya, 20 seconds)

> "Real satellite data, an honest range, a message a basic phone can show, and a place to go. The
> wells are simulated because nobody publishes well levels for this region, which is the gap this
> fills. Give us ten real wells and a tin of paint each and we can start."

## If something breaks

- 3D view blank: everything else still works; talk from the chart and the phone.
- pi-top will not connect: stay in Live demo and use **Drain well** and **Unplug sensor**. Same story.
- Page will not load: you opened the file directly. It must be <http://localhost:8000>.

## Questions judges are likely to ask

**Is the data real?** The climate and satellite data are real (CHIRPS, MODIS, Sentinel-2, GRACE-FO,
NASA POWER). Well levels are simulated on top of them because no public record exists. The screen
says so.

**How do you know it works?** Replay test on unseen wells, same alert code as the dashboard. And
the stated ranges are honest: about 80% of outcomes land inside the 80% range in every mode.

**What is the AI?** 45 gradient-boosted quantile models. Quantile loss is what gives the range.
Small enough to run in the browser, or on a phone-sized computer at a district office.

**What does the satellite add if you have a sensor?** With a live sensor, not much: the level trend
dominates. It matters when the ground goes quiet. Satellite-only still catches 84 of 204, which is
why the system then asks herders for a rope reading instead of trusting it alone.

**Why would herders believe it?** Watch before Act, two days of agreement before any alert, a stated
range, and a reply code so wrong warnings come back to us.

**What if every well in the area is failing?** Then there is no neighbour with spare water, the
plan says so, and the whole cluster becomes a truck request ranked by days left.

**Cost?** A level sensor is optional. The minimum kit per well is a painted rope and one phone.

**What would you do next?** Test on real boreholes with a county water office, get the Somali and
Kiswahili messages checked by native speakers, add USSD so reports are free to send.
