export class UtilityPowerAccessory {
  [key: string]: any;

  constructor(platform, accessory) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.accessory = accessory;
    this.displayName = 'Utility Power';

    const { Service, Characteristic } = this.api.hap;
    this.Service = Service;
    this.Characteristic = Characteristic;

    this.informationService = this.accessory.getService(Service.AccessoryInformation)
      || this.accessory.addService(Service.AccessoryInformation);
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, 'Enphase')
      .setCharacteristic(Characteristic.Model, 'IQ Gateway / Enpower Grid State')
      .setCharacteristic(Characteristic.SerialNumber, platform.config.gatewaySerial || platform.config.gatewayHost || 'unknown');

    this.service = this.accessory.getService(Service.ContactSensor)
      || this.accessory.addService(Service.ContactSensor);
    this.service.setCharacteristic(Characteristic.Name, this.displayName);

    this.service.getCharacteristic(Characteristic.ContactSensorState)
      .onGet(this.handleGetContactState.bind(this));

    if (!this.service.testCharacteristic(Characteristic.StatusFault)) {
      this.service.addOptionalCharacteristic(Characteristic.StatusFault);
    }
    this.service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
  }

  refreshState(state) {
    this.utilityAvailable = state.available !== false;
    this.isUnknown = Boolean(state.unknown);

    this.service.updateCharacteristic(
      this.Characteristic.ContactSensorState,
      this.getContactState()
    );

    this.service.updateCharacteristic(
      this.Characteristic.StatusFault,
      this.isUnknown
        ? this.Characteristic.StatusFault.GENERAL_FAULT
        : this.Characteristic.StatusFault.NO_FAULT
    );
  }

  async handleGetContactState() {
    return this.getContactState();
  }

  getContactState() {
    return this.utilityAvailable
      ? this.Characteristic.ContactSensorState.CONTACT_DETECTED
      : this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }
}
