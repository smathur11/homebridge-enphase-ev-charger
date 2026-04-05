import { EnphaseChargerClient } from './client.js';
import {
  EnphaseEvChargerAccessory,
  EnphaseEvChargingPowerAccessory,
  EnphaseEvChargingStatusAccessory
} from './accessory.js';
import { DEFAULT_POLL_INTERVAL_SECONDS, PLATFORM_NAME, PLUGIN_NAME } from './constants.js';

export class EnphaseEvChargerPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];
    this.lastKnownState = {
      enabled: false,
      active: false,
      powerWatts: 0,
      sessionState: 'unknown'
    };

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
    const exposeChargingStatusSensor = this.config.exposeChargingStatusSensor !== false;
    const exposeChargingPowerSensor = Boolean(this.config.exposeChargingPowerSensor);
    const expectedUuids = new Set([controlUuid]);

    if (exposeChargingStatusSensor) {
      expectedUuids.add(statusUuid);
    }
    if (exposeChargingPowerSensor) {
      expectedUuids.add(powerUuid);
    }

    this.unregisterStaleAccessories([name, statusName, powerName], expectedUuids);

    const controlAccessory = this.getOrCreateAccessory(platformAccessory, name, controlUuid);

    this.evChargerAccessory = new EnphaseEvChargerAccessory(this, controlAccessory);
    this.evChargingStatusAccessory = null;
    this.evChargingPowerAccessory = null;

    if (exposeChargingStatusSensor) {
      const statusAccessory = this.getOrCreateAccessory(platformAccessory, statusName, statusUuid);
      this.evChargingStatusAccessory = new EnphaseEvChargingStatusAccessory(this, statusAccessory);
    }

    if (exposeChargingPowerSensor) {
      const powerAccessory = this.getOrCreateAccessory(platformAccessory, powerName, powerUuid);
      this.evChargingPowerAccessory = new EnphaseEvChargingPowerAccessory(this, powerAccessory);
    }

    await this.refreshAccessories();

    const pollIntervalSeconds = Math.max(10, Number(this.config.pollIntervalSeconds || DEFAULT_POLL_INTERVAL_SECONDS));
    setInterval(() => {
      void this.refreshAccessories();
    }, pollIntervalSeconds * 1000);
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

  async refreshAccessories() {
    try {
      const state = await this.client.getChargerState();
      this.applySharedState(state);
    } catch (error) {
      this.log.warn(`Charger state refresh failed: ${error.message || error}`);
    }
  }
}
