import { getCustomCharacteristics } from './custom-characteristics.js';

class EnphaseBaseAccessory {
  constructor(platform, accessory, displayName) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.config = platform.config;
    this.client = platform.client;
    this.accessory = accessory;

    const { Service, Characteristic } = this.api.hap;
    const CustomCharacteristic = getCustomCharacteristics();

    this.Service = Service;
    this.Characteristic = Characteristic;
    this.CustomCharacteristic = CustomCharacteristic;
    this.displayName = displayName;

    this.informationService = this.accessory.getService(Service.AccessoryInformation)
      || this.accessory.addService(Service.AccessoryInformation);
    this.updateAccessoryInformation();

    this.chargingEnabled = false;
    this.chargingActive = false;
    this.powerWatts = 0;
    this.sessionState = 'unknown';
  }

  applyState(state) {
    this.chargingEnabled = Boolean(state.enabled);
    this.chargingActive = Boolean(state.active);
    this.powerWatts = Number.isFinite(state.powerWatts) ? state.powerWatts : 0;
    this.sessionState = state.sessionState || 'unknown';
    this.updateAccessoryInformation();
  }

  updateAccessoryInformation() {
    const discovered = this.client.getAccessoryInfo?.() || {};
    const info = {
      manufacturer: discovered.manufacturer || this.platform.accessoryInfo.manufacturer || 'Enphase',
      model: discovered.model || this.platform.accessoryInfo.model || 'IQ-EVSE-60R',
      serialNumber: discovered.serialNumber || this.platform.accessoryInfo.serialNumber || 'unknown',
      firmwareRevision: discovered.firmwareRevision || this.platform.accessoryInfo.firmwareRevision || ''
    };

    this.informationService
      .setCharacteristic(this.Characteristic.Manufacturer, info.manufacturer)
      .setCharacteristic(this.Characteristic.Model, info.model)
      .setCharacteristic(this.Characteristic.SerialNumber, info.serialNumber);

    if (info.firmwareRevision) {
      this.informationService.setCharacteristic(
        this.Characteristic.FirmwareRevision,
        info.firmwareRevision
      );
    }
  }

  ensurePrimaryService(targetService) {
    const existing = this.accessory.getService(targetService);
    if (existing) {
      return existing;
    }

    const staleServices = this.accessory.services.filter((service) => (
      service.UUID !== this.Service.AccessoryInformation.UUID
      && service.displayName === this.displayName
      && service.UUID !== targetService.UUID
    ));

    for (const staleService of staleServices) {
      this.accessory.removeService(staleService);
    }

    return this.accessory.addService(targetService, this.displayName);
  }
}

export class EnphaseEvChargerAccessory extends EnphaseBaseAccessory {
  constructor(platform, accessory) {
    super(platform, accessory, platform.config.name);

    this.service = this.ensurePrimaryService(this.Service.Switch);
    this.service.setCharacteristic(this.Characteristic.Name, this.displayName);

    this.service.getCharacteristic(this.Characteristic.On)
      .onGet(this.handleGetOn.bind(this))
      .onSet(this.handleSetOn.bind(this));

    if (!this.service.testCharacteristic(this.CustomCharacteristic.ChargingPowerWatts)) {
      this.service.addOptionalCharacteristic(this.CustomCharacteristic.ChargingPowerWatts);
    }

    if (!this.service.testCharacteristic(this.CustomCharacteristic.ChargerSessionState)) {
      this.service.addOptionalCharacteristic(this.CustomCharacteristic.ChargerSessionState);
    }

  }

  refreshState(state) {
    this.applyState(state);
    this.service.updateCharacteristic(this.Characteristic.On, this.chargingEnabled);
    this.service.updateCharacteristic(this.CustomCharacteristic.ChargingPowerWatts, this.powerWatts);
    this.service.updateCharacteristic(this.CustomCharacteristic.ChargerSessionState, this.sessionState);
  }

  async handleGetOn() {
    return this.chargingEnabled;
  }

  async handleSetOn(value) {
    const nextState = await this.client.setChargingEnabled(Boolean(value));
    this.platform.applySharedState(nextState);
    this.platform.schedulePostControlRefresh();
  }
}

export class EnphaseEvChargingStatusAccessory extends EnphaseBaseAccessory {
  constructor(platform, accessory) {
    super(platform, accessory, 'EV Charging Status');

    this.service = this.accessory.getService(this.Service.ContactSensor)
      || this.accessory.addService(this.Service.ContactSensor);
    this.service.setCharacteristic(this.Characteristic.Name, this.displayName);

    this.service.getCharacteristic(this.Characteristic.ContactSensorState)
      .onGet(this.handleGetContactState.bind(this));
  }

  refreshState(state) {
    this.applyState(state);
    this.service.updateCharacteristic(
      this.Characteristic.ContactSensorState,
      this.chargingActive
        ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.Characteristic.ContactSensorState.CONTACT_DETECTED
    );
  }

  async handleGetContactState() {
    return this.chargingActive
      ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }
}

export class EnphaseEvChargingPowerAccessory extends EnphaseBaseAccessory {
  constructor(platform, accessory) {
    super(platform, accessory, 'Estimated EV Charging Power');

    this.service = this.accessory.getService(this.Service.LightSensor)
      || this.accessory.addService(this.Service.LightSensor);
    this.service.setCharacteristic(this.Characteristic.Name, this.displayName);

    this.service.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
      .onGet(this.handleGetLightLevel.bind(this));
  }

  refreshState(state) {
    this.applyState(state);
    this.service.updateCharacteristic(
      this.Characteristic.CurrentAmbientLightLevel,
      this.convertWattsToLux(this.powerWatts)
    );
  }

  async handleGetLightLevel() {
    return this.convertWattsToLux(this.powerWatts);
  }

  convertWattsToLux(powerWatts) {
    if (!Number.isFinite(powerWatts) || powerWatts <= 0) {
      return 0.0001;
    }

    return Math.min(100000, Math.max(0.0001, powerWatts));
  }
}
