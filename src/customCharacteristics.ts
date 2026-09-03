import { API, Characteristic, WithUUID } from 'homebridge';

// A characteristic constructor usable with every Service method: has a zero-arg constructor (for
// get/update/add) and the Characteristic static side (for testCharacteristic), plus a UUID.
type EveCharacteristicCtor = WithUUID<{ new (): Characteristic } & typeof Characteristic>;

// Eve-style custom characteristics for power metering. The native Home app ignores these, but the
// Eve app (and other HomeKit clients) surface them as live voltage / current / consumption.
export interface EveCharacteristics {
  Voltage: EveCharacteristicCtor;
  ElectricCurrent: EveCharacteristicCtor;
  CurrentConsumption: EveCharacteristicCtor;
}

export function createEveCharacteristics(api: API): EveCharacteristics {
  const BaseCharacteristic = api.hap.Characteristic;
  const { Formats, Perms } = api.hap;

  class Voltage extends BaseCharacteristic {
    static readonly UUID = 'E863F10A-079E-48FF-8F27-9C2605A29F52';
    constructor() {
      super('Voltage', Voltage.UUID, {
        format: Formats.FLOAT,
        unit: 'V',
        minValue: 0,
        maxValue: 400,
        minStep: 0.1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  class ElectricCurrent extends BaseCharacteristic {
    static readonly UUID = 'E863F126-079E-48FF-8F27-9C2605A29F52';
    constructor() {
      super('Electric Current', ElectricCurrent.UUID, {
        format: Formats.FLOAT,
        unit: 'A',
        minValue: 0,
        maxValue: 100,
        minStep: 0.01,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  class CurrentConsumption extends BaseCharacteristic {
    static readonly UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';
    constructor() {
      super('Consumption', CurrentConsumption.UUID, {
        format: Formats.FLOAT,
        unit: 'W',
        minValue: 0,
        maxValue: 100000,
        minStep: 0.1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  return { Voltage, ElectricCurrent, CurrentConsumption };
}
