let CharacteristicRef;

export function registerCustomCharacteristics(api) {
  const { Characteristic, Formats, Perms, Units } = api.hap;

  class ChargingPowerWatts extends Characteristic {
    constructor() {
      super('Charging Power', 'C5E00101-6C88-4D39-9A0C-4A0C1D2D0101');
      this.setProps({
        format: Formats.FLOAT,
        unit: Units.WATT,
        minValue: 0,
        maxValue: 20000,
        minStep: 1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY]
      });
      this.value = this.getDefaultValue();
    }
  }

  class ChargerSessionState extends Characteristic {
    constructor() {
      super('Charger Session State', 'C5E00102-6C88-4D39-9A0C-4A0C1D2D0101');
      this.setProps({
        format: Formats.STRING,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY]
      });
      this.value = this.getDefaultValue();
    }
  }

  Characteristic.ChargingPowerWatts = ChargingPowerWatts;
  Characteristic.ChargerSessionState = ChargerSessionState;
  CharacteristicRef = Characteristic;
}

export function getCustomCharacteristics() {
  return CharacteristicRef;
}
