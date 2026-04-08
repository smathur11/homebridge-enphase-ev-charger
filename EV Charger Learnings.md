# EV Charger Learnings

## Purpose

This document captures the practical learnings from building and debugging the Homebridge Enphase IQ EV charger plugin so future work can resume without starting from scratch.

It covers:

- what currently works in the plugin
- what was learned from reverse-engineering the Enlighten web app
- what was learned from HAR captures
- what was learned from the official Enphase developer APIs
- which approaches failed
- which approaches remain promising if exact EV-only live power is revisited later

## Current Working Design

As of `v0.4.1`, the plugin is intentionally split into two concerns:

1. Charger control and basic status
2. Estimated live charging power

### Charger control

This works through the homeowner-facing Enlighten web session, not the official developer API.

The plugin logs into Enlighten with:

- `enlightenUser`
- `enlightenPasswd`

And then uses the same web endpoints the Enlighten UI uses:

- Start charging:
  - `POST /service/evse_controller/{systemId}/ev_chargers/{chargerSerial}/start_charging`
- Stop charging:
  - `PUT /service/evse_controller/{systemId}/ev_chargers/{chargerSerial}/stop_charging`
- Charger state:
  - `GET /service/evse_controller/{systemId}/ev_chargers/status`

This path is stable and should be preserved unless there is a strong reason to replace it.

### Optional accessories

The plugin currently exposes:

- Main charger accessory as a `Switch`
- Optional `Contact Sensor` named `EV Charging Status`
- Optional `Light Sensor` named `Estimated EV Charging Power`

The light sensor uses lux as a proxy for watts:

- `lux == estimated watts`
- For example, `3800 lux` means about `3800 W`

This was chosen so Apple Home automations can use the value.

### Estimated live charging power

The plugin does not have access to the exact EV-only live wattage from Enphase.

So the current implementation uses:

- general site livestream
- decoded site load
- minus a pre-charge baseline

In other words:

`estimated charger watts = current site load - pre-charge site load`

This is useful and updates near-real-time, but it is only an estimate.

## Known IDs For This System

These values were identified during testing:

- Enphase system ID: `705286`
- EV charger serial: `482530029136`
- Gateway serial: `482531068306`
- Enphase username used for testing: `sanjay@mathur.ws`

## What The UI Numbers Mean

The Enlighten live-status page shows at least two different "consuming" style numbers:

1. Top site flow "Consuming"
2. Lower EV charger card "Consuming"

Those are not the same thing.

### Top site flow "Consuming"

This is total site load.

It was successfully matched to decoded site livestream data.

### Lower EV charger card "Consuming"

This is the charger-specific number shown in the IQ EV Charger card.

This is the number we wanted to recover exactly.

Important conclusion:

- The lower EV card value is not the same as total site load
- It is not fully reproducible from the currently decoded site-wide stream alone

## Reverse-Engineering Timeline

## Stage 1: Prove basic control

Initial goal:

- determine whether the charger could be controlled through homeowner-accessible Enphase paths

Outcome:

- success

The plugin was able to use the Enlighten web session and the `evse_controller` endpoints for start/stop.

This became the permanent control path.

## Stage 2: Investigate private EV livestream

The next goal was to find exact live EV wattage.

The first likely candidate was the EVSE-specific livestream returned by:

- `start_live_stream`

The plugin was able to:

- start livestream setup
- authenticate to AWS IoT
- connect
- subscribe

Observed topic:

- `v1/evse/prod/live-stream/482530029136`

However:

- the topic was effectively silent for useful payloads in our tests
- even wildcard subscription around it did not produce the expected charger-power messages

Conclusion:

- the EVSE topic exists
- but for this site/configuration it did not yield the exact live power signal we needed

## Stage 3: Investigate general HEMS livestream

The next major breakthrough was the general site livestream topic:

- `v1/live-stream/30058b1374c80e17`

This topic did produce messages.

The payloads were binary / protobuf-like.

Eventually the site-level `DataMsg` messages were decoded successfully.

These contained fields like:

- `loadWatts`
- `gridWatts`
- `storageWatts`
- `pvWatts`
- `dryContactRelayStatus`
- `loadStatus`

This was a major result because it let us recover live site load at about 1 Hz.

### What the decoded fields appeared to mean

- `loadWatts`: whole-site consuming value
- `gridWatts`: net import/export direction and magnitude
- `storageWatts`: battery charging/discharging contribution
- `pvWatts`: solar production when present

This lined up well with the top site power-flow diagram in Enlighten.

### What it did not give us

It did not expose a clean EV-only watt field.

In particular:

- `loadStatus` was empty in observed samples
- no obvious charger-only meter field was available in the decoded `DataMsg`

## Stage 4: Estimate EV power from site-load delta

Because exact EV-only watts were still missing, the plugin switched to:

- capture pre-charge site-load baseline
- start charging
- estimate charger watts using site-load delta

This worked reasonably well in practice.

### Why it works

When the charger starts, the whole-site load often jumps sharply.

Examples observed:

- baseline house/site load around `0.8 kW` or `1.2 kW`
- charging site load around `6.3 kW`, `6.8 kW`, `10+ kW`, etc.

So:

- `site load during charging - baseline load`

gave a practical proxy for charger demand.

### Why it is imperfect

It does not match the lower EV card exactly because:

- house load can change independently while charging
- batteries, solar, and grid behavior complicate interpretation
- the lower EV card appears to come from a separate Enphase internal source

Still, this estimate was good enough to support:

- Eve app visibility
- Apple Home automations via the light sensor

## HAR Findings

Multiple HARs were captured from:

- Safari on Mac
- iPhone
- live-status page while charging
- startup/stop runs

Key findings:

### Control endpoints were confirmed

HARs repeatedly confirmed:

- `POST /service/evse_controller/.../start_charging`
- `PUT /service/evse_controller/.../stop_charging`

### Status endpoints were confirmed

HARs also confirmed:

- `GET /service/evse_controller/{systemId}/ev_chargers/status`
- `GET /service/evse_controller/api/v2/{systemId}/ev_chargers/status`

### Live-status page had working MQTT

At least one HAR showed:

- `POST /app-api/705286/log_live_status`

with values indicating:

- `mqtt_start_time`
- `mqtt_packet_received_at`
- `status=Success`

This confirmed the browser really was receiving live data while the page showed charger activity.

### HEMS protobuf resource

The web app also loaded:

- `HemsStreamMessage.proto`

That pointed strongly toward HEMS/general livestream usage for site data.

## Frontend Code Findings

The frontend bundle revealed several important clues.

### EV card DOM structure

The lower charger card was rendered separately from the top site diagram.

Relevant classes found in DOM inspection:

- `device-title-section`
- `consumption-section live-status-consumption`
- `<span class="value">...`

This confirmed the charger card is driven from a separate data path or component model than the top site flow.

### HEMS device-style EV updates

The frontend bundle contained logic strongly suggesting a per-device HEMS feed.

Important clues:

- charger power appeared tied to:
  - `streamData["asset-id"]`
  - `streamData.metrics["power.in"]`
- the bundle referenced:
  - `hems-device-facet-id`
  - `EVSE_HEMS_DEVICES_LOCAL_STORAGE`
  - `/api/v1/hems/@SITE_ID/hems-devices?refreshData=false`

Interpretation:

- there may be a device-level HEMS stream for EV assets
- the exact charger-card power may come from `metrics["power.in"]`

This became the strongest reverse-engineering candidate for exact EV-only power.

### EV-specific SSE/event hints

The frontend also referenced:

- `EVSE_SSE_CHANNEL_TOPIC_STATUS`
- `EVSE_SSE_CHANNEL_TOPIC_LIVE_STATUS`

This suggested some EV-specific event channel exists in the web app architecture.

But no reproducible working endpoint was recovered from our plugin experiments.

Attempted guessed path:

- `/service/evse_sse?key=705286`

Result:

- `404`

Conclusion:

- the SSE path is real inside the app
- but the actual externally reproducible endpoint or auth flow was not identified

### EV-native MeterValues trigger

Frontend code also showed:

- `POST /service/evse_controller/{siteId}/ev_charger/{id}/trigger_message`
- with `requestedMessage: "MeterValues"`

This looked promising for exact charger telemetry.

However:

- it appeared gated by regional/frontend logic
- it did not become a working path in this US homeowner setup

## Official Enphase Developer API Findings

Later in the project, the official Enphase developer docs were examined.

The user already had a Watt-plan developer app with:

- API key
- client ID
- client secret

OAuth flow was completed successfully.

### Confirmed working official API flow

Successful steps:

1. OAuth authorization code exchange
2. Access token retrieval
3. Systems API call

Confirmed:

- official API access worked
- system `705286` was accessible

### EV telemetry endpoint

This official endpoint worked:

- `GET /api/v4/systems/{system_id}/ev_charger/{serial_no}/telemetry`

For this charger:

- `GET /api/v4/systems/705286/ev_charger/482530029136/telemetry`

### Why the official API was not used for live power

The telemetry endpoint returned:

- interval consumption buckets
- not near-real-time instantaneous power

Observed behavior:

- requested `interval_duration=5mins`
- but response effectively came back in coarser interval energy data

Conclusion:

- the official API is useful for history/session analysis
- it is not sufficient for responsive live HomeKit power updates

This is why the official OAuth/developer path was ultimately removed from the shipping plugin.

## Dead Ends And Failed Approaches

These were tried and should not be repeated unless there is a new reason.

### 1. Private HEMS devices endpoint with homeowner web auth

Tried:

- `/api/v1/hems/{siteId}/hems-devices?refreshData=false`

Result:

- repeated `401 Unauthorized`

We tried:

- browser-like headers
- bearer token reuse
- JWT bootstrap variants
- auth-ms style flow guesses

Still failed.

Conclusion:

- homeowner web session auth was not enough to unlock this endpoint in our implementation

### 2. Exact EV power from EVSE MQTT topic

Topic:

- `v1/evse/prod/live-stream/482530029136`

Result:

- connect/subscribe worked
- useful charger-power messages did not materialize

Conclusion:

- not a practical source for this plugin as tested

### 3. Official developer telemetry as live-power replacement

Result:

- works for interval telemetry only
- too slow/coarse for live Apple Home power usage

Conclusion:

- not suitable as the main live-power source

## Practical Lessons About Baselines

Several bugs were found and fixed in baseline handling.

### Bad baseline sources that caused wrong estimates

These caused trouble and should be avoided:

- using charging-era site load as if it were a non-charging baseline
- capturing the first charging sample as the baseline
- learning baseline too late in the session

### Better baseline strategy

The most practical approach found was:

1. Before sending `start_charging`, briefly warm up the site livestream
2. Capture a short non-charging site-load sample
3. Use that as baseline for the charging session

Even with this, the result remains an estimate, not exact EV-card parity.

## Why The Estimate Sometimes "Looks Wrong"

The estimate is based on top site load, not the lower EV card.

Examples seen in screenshots:

### Example A

Before charging:

- site consuming around `0.8 kW`

During charging:

- site consuming around `6.8 kW`
- lower EV card around `11.1 kW`

Plugin estimate:

- around `6.0-6.5 kW`

Interpretation:

- the plugin matched the increase in site load
- the EV card was clearly using a different internal source

### Example B

Before charging:

- site consuming around `0.9 kW`

During charging:

- site consuming around `6.3 kW`

A reasonable site-delta estimate:

- about `5.4 kW`

Again, this is useful as a proxy, but not exact EV-only watts.

## Why The Plugin Was Ultimately Simplified

The shipping plugin intentionally removed:

- official OAuth/developer telemetry code
- HEMS devices mapping code
- abandoned SSE experiments

Reason:

- those paths made the plugin more complex
- none of them produced better live HomeKit behavior than the current estimate
- homeowner-login start/stop already worked cleanly

The final simplified architecture was considered better because:

- it is easier to configure
- it has fewer brittle auth flows
- it keeps the working parts stable

## What Remains Most Promising If Exact EV-Only Power Is Revisited

If exact EV-only live power becomes a goal again, the best remaining paths are:

### Option 1: Unlock device-level HEMS stream

Best hypothesis:

- exact charger-card power may come from per-device HEMS data
- likely keyed by:
  - `asset-id`
  - `hems-device-facet-id`
  - `metrics["power.in"]`

To resume this path, future work should focus on:

- reproducing the exact auth/bootstrap the browser uses for HEMS devices
- confirming the device asset mapping
- confirming the live payload format on the general topic

This still looks like the best reverse-engineering target.

### Option 2: Recover exact browser EV-specific event path

The frontend clearly references EV-specific event channels.

Future work could try:

- deeper browser devtools instrumentation
- direct request replay from the live-status page
- looking for hidden websocket/SSE bootstrap steps not preserved in HAR export

This is plausible, but harder than Option 1.

### Option 3: Revisit official APIs if Enphase adds finer-grained telemetry

If the official Monitoring API later exposes:

- near-real-time power
- or 1-minute / sub-minute charger telemetry

then the official OAuth path may become the best long-term solution.

At the time of this work, it was not adequate for live power.

## Files That Matter In The Current Plugin

Key files in the repo:

- `src/client.js`
  - homeowner-auth login
  - charger autodiscovery
  - Enlighten web control
  - livestream decoding
  - estimated power logic
- `src/platform.js`
  - platform wiring
  - optional accessory registration
- `src/accessory.js`
  - switch accessory
  - optional contact sensor
  - optional light sensor
- `config.schema.json`
  - Homebridge UI config options
- `README.md`
  - current published behavior and user-facing design

## Final Honest Summary

What is solved:

- homeowner-login charger control
- charger autodiscovery
- optional charging status sensor
- optional live power proxy for Apple Home automations

What is not solved:

- exact reproduction of the lower Enphase EV card wattage

Why:

- the exact EV-only live feed appears to be internal/private and was not fully recovered

What the current plugin provides instead:

- a practical estimated EV charging power based on site-load delta

That is the correct mental model to bring into any future iteration.
