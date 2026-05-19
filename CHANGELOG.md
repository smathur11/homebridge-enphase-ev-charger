# Changelog

## 0.6.0

- Added an optional `Utility Power` Contact Sensor backed by local Envoy/IQ Gateway Ensemble/Enpower data.
- Added local grid-state polling with `/ivp/ensemble/relay`, `/ivp/ensemble/inventory`, and `/ivp/ensemble/status` fallbacks.
- Added debounced utility-state changes so transient relay transitions do not immediately flip HomeKit state.
- Retain the last known utility state when the Envoy is unreachable instead of treating communication failures as outages.
- Added Homebridge config options for enabling the sensor, debounce duration, and utility polling interval.

## 0.5.0

- Migrated the plugin source to TypeScript and added a build step that publishes compiled JavaScript from `dist`.
- Added one quiet retry for transient network failures such as DNS hiccups, timeouts, and connection resets.
- Added one Enlighten web-session refresh and retry when API requests return `401` or `403`.
- Start the livestream automatically when polling discovers the charger is already charging outside Apple Home.
- Track `pluggedIn` as an explicit state field and use it for adaptive polling decisions.
- Updated documentation for TypeScript, adaptive polling, and resilience behavior.

## 0.4.2

- Added adaptive polling to reduce idle Enlighten API traffic.
- Defaults are `300s` while idle, `60s` while plugged in, and `30s` while charging.
- Kept short post-command refresh bursts after Apple Home start/stop commands.
- Added `EV Charger Learnings.md` with reverse-engineering notes for future work.

## 0.4.1

- Added Apple Home screenshot to the README.
- Published the first public GitHub and npm release.
- Clarified that the light sensor reports estimated charging power using lux as a watt proxy.
