import { EnphaseChargerClient } from './client.js';
import { EnphaseGridClient } from './grid-client.js';
import {
  EnphaseEvChargerAccessory,
  EnphaseEvChargingPowerAccessory,
  EnphaseEvChargingStatusAccessory
} from './accessory.js';
import { UtilityPowerAccessory } from './utility-power-accessory.js';
import {
  DEFAULT_CHARGING_POLL_INTERVAL_SECONDS,
  DEFAULT_IDLE_POLL_INTERVAL_SECONDS,
  DEFAULT_PLUGGED_IN_POLL_INTERVAL_SECONDS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_UTILITY_POWER_DEBOUNCE_SECONDS,
  DEFAULT_UTILITY_POWER_POLL_INTERVAL_SECONDS,
  PLATFORM_NAME,
  PLUGIN_NAME
} from './constants.js';

export class EnphaseEvChargerPlatform {
  [key: string]: any;

  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];
    this.lastKnownState = {
      enabled: false,
      active: false,
      pluggedIn: false,
      powerWatts: 0,
      sessionState: 'unknown'
    };
    this.refreshTimer = null;
    this.refreshInFlight = false;
    this.gridRefreshTimer = null;
    this.gridRefreshInFlight = false;
    this.utilityPowerState = {
      available: true,
      unknown: true,
      rawState: '',
      source: 'initial-default',
      gridMode: '',
      updatedAt: 0
    };
    this.pendingUtilityPowerState = null;

    if (!config) {
      this.log.warn('No configuration found for Enphase EV Charger.');
      return;
    }

    this.client = new EnphaseChargerClient(this.log, {
      name: config.name || 'Enphase EV Charger',
      systemId: config.systemId || '',
      chargerSerial: config.chargerSerial || '',
      gatewayHost: config.gatewayHost || '192.168.0.205',
      gatewaySerial: config.gatewaySerial || '',
      enlightenUser: config.enlightenUser || '',
      enlightenPasswd: config.enlightenPasswd || '',
      envoyToken: config.envoyToken || '',
      apiMode: config.apiMode || 'enlighten-web',
      authMode: config.authMode || 'enlighten-web-session',
      chargingLevel: config.chargingLevel ?? 48,
      connectorId: config.connectorId ?? 1,
      stateRequest: config.stateRequest || {},
      controlRequest: config.controlRequest || {},
      onLivePowerUpdate: (powerWatts) => this.handleLivePowerUpdate(powerWatts),
      mockEnabled: config.mockEnabled ?? false,
      mockActive: config.mockActive ?? false,
      mockPowerWatts: config.mockPowerWatts ?? 0,
      mockSessionState: config.mockSessionState || 'idle'
    });

    this.gridClient = new EnphaseGridClient(this.log, {
      gatewayHost: config.gatewayHost || '192.168.0.205',
      gatewaySerial: config.gatewaySerial || '',
      envoyToken: config.envoyToken || '',
      utilityPowerTimeoutMs: config.utilityPowerTimeoutMs
    });

    this.accessoryInfo = {
      manufacturer: config.manufacturer || 'Enphase',
      model: config.model || 'IQ-EVSE-60R',
      serialNumber: config.chargerSerial || config.gatewaySerial || '',
      firmwareRevision: config.chargerFirmware || ''
    };

    this.api.on('didFinishLaunching', async () => {
      this.log.info('Launching Enphase EV Charger platform.');
      this.log.info(`API mode: ${this.config.apiMode || 'enlighten-web'}`);
      await this.setupAccessories();
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  async setupAccessories() {
    const { platformAccessory, hap } = this.api;
    const name = this.config.name || 'Enphase EV Charger';
    const controlUuid = hap.uuid.generate(`${PLUGIN_NAME}:${name}:control`);
    const statusName = 'EV Charging Status';
    const statusUuid = hap.uuid.generate(`${PLUGIN_NAME}:${name}:status`);
    const powerName = 'Estimated EV Charging Power';
    const powerUuid = hap.uuid.generate(`${PLUGIN_NAME}:${name}:power`);
    const utilityPowerName = 'Utility Power';
    const utilityPowerUuid = hap.uuid.generate(`${PLUGIN_NAME}:${name}:utility-power`);
    const exposeChargingStatusSensor = this.config.exposeChargingStatusSensor !== false;
    const exposeChargingPowerSensor = Boolean(this.config.exposeChargingPowerSensor);
    const enableUtilityPowerSensor = Boolean(this.config.enableUtilityPowerSensor);
    const expectedUuids = new Set([controlUuid]);

    if (exposeChargingStatusSensor) {
      expectedUuids.add(statusUuid);
    }
    if (exposeChargingPowerSensor) {
      expectedUuids.add(powerUuid);
    }
    if (enableUtilityPowerSensor) {
      expectedUuids.add(utilityPowerUuid);
    }

    this.unregisterStaleAccessories([name, statusName, powerName, utilityPowerName], expectedUuids);

    const controlAccessory = this.getOrCreateAccessory(platformAccessory, name, controlUuid);

    this.evChargerAccessory = new EnphaseEvChargerAccessory(this, controlAccessory);
    this.evChargingStatusAccessory = null;
    this.evChargingPowerAccessory = null;
    this.utilityPowerAccessory = null;

    if (exposeChargingStatusSensor) {
      const statusAccessory = this.getOrCreateAccessory(platformAccessory, statusName, statusUuid);
      this.evChargingStatusAccessory = new EnphaseEvChargingStatusAccessory(this, statusAccessory);
    }

    if (exposeChargingPowerSensor) {
      const powerAccessory = this.getOrCreateAccessory(platformAccessory, powerName, powerUuid);
      this.evChargingPowerAccessory = new EnphaseEvChargingPowerAccessory(this, powerAccessory);
    }

    if (enableUtilityPowerSensor) {
      const utilityPowerAccessory = this.getOrCreateAccessory(platformAccessory, utilityPowerName, utilityPowerUuid);
      this.utilityPowerAccessory = new UtilityPowerAccessory(this, utilityPowerAccessory);
      this.utilityPowerAccessory.refreshState(this.utilityPowerState);
    }

    await this.refreshAccessories({ scheduleNext: false });
    this.scheduleNextRefresh();
    if (enableUtilityPowerSensor) {
      await this.refreshUtilityPower({ scheduleNext: false });
      this.scheduleNextUtilityPowerRefresh();
    }
  }

  getOrCreateAccessory(platformAccessory, name, uuid) {
    let accessory = this.accessories.find(existing => existing.UUID === uuid);
    if (!accessory) {
      accessory = new platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    return accessory;
  }

  unregisterStaleAccessories(validNames, expectedUuids) {
    const staleAccessories = this.accessories.filter((accessory) => (
      validNames.includes(accessory.displayName)
      && !expectedUuids.has(accessory.UUID)
    ));

    if (!staleAccessories.length) {
      return;
    }

    this.log.info(
      `Removing ${staleAccessories.length} stale cached accessory${staleAccessories.length === 1 ? '' : 'ies'} `
      + `after service migration: ${staleAccessories.map((accessory) => accessory.displayName).join(', ')}`
    );
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    this.accessories = this.accessories.filter(
      (accessory) => !staleAccessories.some((staleAccessory) => staleAccessory.UUID === accessory.UUID)
    );
  }

  applySharedState(state) {
    this.lastKnownState = { ...state };
    this.evChargerAccessory?.refreshState(state);
    this.evChargingStatusAccessory?.refreshState(state);
    this.evChargingPowerAccessory?.refreshState(state);
  }

  handleLivePowerUpdate(powerWatts) {
    if (!Number.isFinite(powerWatts)) {
      return;
    }

    if (!this.lastKnownState.enabled && !this.lastKnownState.active) {
      return;
    }

    if (this.lastKnownState.powerWatts === powerWatts) {
      return;
    }

    this.applySharedState({
      ...this.lastKnownState,
      powerWatts,
      active: powerWatts > 0 ? true : this.lastKnownState.active,
      sessionState: powerWatts > 0 ? 'charging' : this.lastKnownState.sessionState
    });
  }

  schedulePostControlRefresh() {
    for (const delayMs of [5000, 15000, 30000, 60000]) {
      setTimeout(() => {
        void this.refreshAccessories();
      }, delayMs);
    }
  }

  getPollIntervals() {
    const legacyPollInterval = Number(this.config.pollIntervalSeconds || DEFAULT_POLL_INTERVAL_SECONDS);
    return {
      idle: Math.max(60, Number(this.config.idlePollIntervalSeconds || DEFAULT_IDLE_POLL_INTERVAL_SECONDS)),
      pluggedIn: Math.max(30, Number(this.config.pluggedInPollIntervalSeconds || DEFAULT_PLUGGED_IN_POLL_INTERVAL_SECONDS)),
      charging: Math.max(
        10,
        Number(this.config.chargingPollIntervalSeconds || legacyPollInterval || DEFAULT_CHARGING_POLL_INTERVAL_SECONDS)
      )
    };
  }

  getNextPollIntervalSeconds() {
    const intervals = this.getPollIntervals();
    if (this.lastKnownState.active || this.lastKnownState.enabled || this.lastKnownState.sessionState === 'charging') {
      return intervals.charging;
    }

    if (this.lastKnownState.pluggedIn || this.isPluggedInSessionState(this.lastKnownState.sessionState)) {
      return intervals.pluggedIn;
    }

    return intervals.idle;
  }

  isPluggedInSessionState(sessionState) {
    const normalized = String(sessionState || '').toLowerCase();
    return normalized !== ''
      && normalized !== 'unknown'
      && normalized !== 'idle'
      && normalized !== 'available'
      && normalized !== 'unavailable';
  }

  scheduleNextRefresh(delaySeconds = this.getNextPollIntervalSeconds()) {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshAccessories();
    }, delaySeconds * 1000);
  }

  async refreshAccessories({ scheduleNext = true } = {}) {
    if (this.refreshInFlight) {
      return;
    }

    this.refreshInFlight = true;
    try {
      const state = await this.client.getChargerState();
      this.applySharedState(state);
    } catch (error) {
      this.log.warn(`Charger state refresh failed: ${error.message || error}`);
    } finally {
      this.refreshInFlight = false;
      if (scheduleNext) {
        this.scheduleNextRefresh();
      }
    }
  }

  getUtilityPowerPollIntervalSeconds() {
    return Math.max(
      15,
      Number(this.config.utilityPowerPollIntervalSeconds || DEFAULT_UTILITY_POWER_POLL_INTERVAL_SECONDS)
    );
  }

  getUtilityPowerDebounceSeconds() {
    return Math.max(
      0,
      Number(this.config.utilityPowerDebounceSeconds ?? DEFAULT_UTILITY_POWER_DEBOUNCE_SECONDS)
    );
  }

  scheduleNextUtilityPowerRefresh(delaySeconds = this.getUtilityPowerPollIntervalSeconds()) {
    if (!this.utilityPowerAccessory) {
      return;
    }

    if (this.gridRefreshTimer) {
      clearTimeout(this.gridRefreshTimer);
    }

    this.gridRefreshTimer = setTimeout(() => {
      this.gridRefreshTimer = null;
      void this.refreshUtilityPower();
    }, delaySeconds * 1000);
  }

  async refreshUtilityPower({ scheduleNext = true } = {}) {
    if (!this.utilityPowerAccessory || this.gridRefreshInFlight) {
      return;
    }

    this.gridRefreshInFlight = true;
    try {
      const gridState = await this.gridClient.getUtilityPowerState();
      this.handleUtilityPowerObservation(gridState);
    } catch (error) {
      this.markUtilityPowerUnknown(`Envoy unreachable, retaining last state: ${error.message || error}`);
    } finally {
      this.gridRefreshInFlight = false;
      if (scheduleNext) {
        this.scheduleNextUtilityPowerRefresh();
      }
    }
  }

  handleUtilityPowerObservation(gridState) {
    if (typeof gridState.available !== 'boolean') {
      this.markUtilityPowerUnknown(`UNKNOWN, retaining last state${gridState.detail ? ` (${gridState.detail})` : ''}`);
      return;
    }

    const observed = {
      available: gridState.available,
      unknown: false,
      rawState: gridState.rawState || '',
      source: gridState.source || gridState.endpoint || 'unknown',
      gridMode: gridState.gridMode || '',
      updatedAt: Date.now()
    };

    if (observed.available === this.utilityPowerState.available && !this.utilityPowerState.unknown) {
      this.pendingUtilityPowerState = null;
      this.applyUtilityPowerState(observed);
      return;
    }

    const debounceMs = this.getUtilityPowerDebounceSeconds() * 1000;
    if (debounceMs === 0 || this.utilityPowerState.unknown) {
      this.pendingUtilityPowerState = null;
      this.applyUtilityPowerState(observed);
      return;
    }

    if (!this.pendingUtilityPowerState || this.pendingUtilityPowerState.available !== observed.available) {
      this.pendingUtilityPowerState = {
        ...observed,
        firstSeenAt: Date.now()
      };
      this.log.info(
        `Utility Power: observed ${observed.available ? 'GRID_AVAILABLE' : 'GRID_OUTAGE'}; `
        + `waiting ${this.getUtilityPowerDebounceSeconds()}s debounce before updating HomeKit`
      );
      return;
    }

    const elapsedMs = Date.now() - this.pendingUtilityPowerState.firstSeenAt;
    this.pendingUtilityPowerState = {
      ...this.pendingUtilityPowerState,
      ...observed
    };

    if (elapsedMs >= debounceMs) {
      const stableState = { ...this.pendingUtilityPowerState };
      delete stableState.firstSeenAt;
      this.pendingUtilityPowerState = null;
      this.applyUtilityPowerState(stableState);
    }
  }

  applyUtilityPowerState(nextState) {
    const previousAvailable = this.utilityPowerState.available;
    const previousUnknown = this.utilityPowerState.unknown;
    this.utilityPowerState = {
      ...this.utilityPowerState,
      ...nextState,
      unknown: false
    };
    this.utilityPowerAccessory?.refreshState(this.utilityPowerState);

    if (previousUnknown || previousAvailable !== this.utilityPowerState.available) {
      this.log.info(
        `Utility Power: ${this.utilityPowerState.available ? 'GRID_AVAILABLE' : 'GRID_OUTAGE'}`
        + `${this.utilityPowerState.rawState ? ` (${this.utilityPowerState.rawState})` : ''}`
      );
    }
  }

  markUtilityPowerUnknown(message) {
    this.pendingUtilityPowerState = null;
    this.utilityPowerState = {
      ...this.utilityPowerState,
      unknown: true
    };
    this.utilityPowerAccessory?.refreshState(this.utilityPowerState);
    this.log.warn(`Utility Power: ${message}`);
  }
}
