import { CharacteristicValue, HAP, Logger, PlatformAccessory, Service } from 'homebridge';

import { WattBoxHomebridgePlatform } from './platform';
import {
  WattBox,
  WattBoxOutlet,
  WattBoxOutletAction,
  WattBoxOutletMode,
  WattBoxOutletStatus,
} from './wattbox';

export type WattBoxOutletOptionalState = Pick<WattBoxOutlet, 'name' | 'id'> &
  Partial<WattBoxOutlet>;

export interface WattBoxOutletPlatformAccessoryContext {
  model: string;
  serialNumber: string;
}

// An outlet is considered "in use" once it draws more than this many watts.
const OUTLET_IN_USE_THRESHOLD_WATTS = 0.5;

export class WattBoxOutletPlatformAccessory {
  private readonly log: Logger;
  private readonly hap: HAP;
  private readonly wattbox: WattBox;
  private readonly context: WattBoxOutletPlatformAccessoryContext;
  private readonly service: Service;
  private readonly outletId: string;
  private readonly outletName: string;
  private readonly serialNumber: string;
  private readonly id: string;

  private status = WattBoxOutletStatus.UNKNOWN;

  constructor(
    private readonly platform: WattBoxHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly outlet: WattBoxOutletOptionalState,
  ) {
    this.log = this.platform.log;
    this.hap = this.platform.api.hap;
    this.wattbox = this.platform.wattbox;
    this.context = <WattBoxOutletPlatformAccessoryContext>this.accessory.context;
    this.serialNumber = this.context.serialNumber;
    this.outletId = this.outlet.id;
    this.outletName = this.outlet.name;
    this.id = `${this.serialNumber}:${this.outletId}`;

    this.service =
      this.accessory.getServiceById(this.platform.Service.Outlet, this.id) ||
      this.accessory.addService(this.platform.Service.Outlet, this.outletName, this.id);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.outletName);

    const statusCharacteristic = this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    // Add Eve power-metering characteristics when the transport provides per-outlet metering.
    if (this.outlet.powerWatts !== undefined) {
      for (const ctor of [
        this.platform.eve.CurrentConsumption,
        this.platform.eve.Voltage,
        this.platform.eve.ElectricCurrent,
      ]) {
        if (!this.service.testCharacteristic(ctor)) {
          this.service.addCharacteristic(ctor);
        }
      }
      this.updateMetering(this.outlet);
    }

    this.wattbox.subscribe(this.outletId, (outlet) => {
      const { status } = outlet;
      if (this.status !== status) {
        this.log.debug(
          '[%s] Received outlet subscription status update: %s -> %s',
          this.outletName,
          WattBoxOutletStatus[this.status],
          WattBoxOutletStatus[status],
        );
        this.status = status;
        statusCharacteristic.updateValue(!!status);
      }
      this.updateMetering(outlet);
    });
  }

  // Update the native OutletInUse flag and, when metered, the Eve consumption characteristics.
  private updateMetering(outlet: WattBoxOutletOptionalState): void {
    const inUse =
      outlet.powerWatts !== undefined
        ? outlet.powerWatts > OUTLET_IN_USE_THRESHOLD_WATTS
        : outlet.status === WattBoxOutletStatus.ON;
    this.service.updateCharacteristic(this.platform.Characteristic.OutletInUse, inUse);
    if (outlet.powerWatts !== undefined) {
      this.service.updateCharacteristic(this.platform.eve.CurrentConsumption, outlet.powerWatts);
    }
    if (outlet.currentAmps !== undefined) {
      this.service.updateCharacteristic(this.platform.eve.ElectricCurrent, outlet.currentAmps);
    }
    if (outlet.voltageVolts !== undefined) {
      this.service.updateCharacteristic(this.platform.eve.Voltage, outlet.voltageVolts);
    }
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    this.log.debug('[%s] Set Characteristic On ->', this.outletName, value);
    try {
      let action: WattBoxOutletAction;
      let fireAndForget = false;
      if (value) {
        action = WattBoxOutletAction.ON;
      } else if (this.outlet.mode === WattBoxOutletMode.RESET_ONLY) {
        action = WattBoxOutletAction.POWER_RESET;
        // The reset command takes a while to respond and doesn't return a valid HTTP response so
        // just fire and forget it.
        fireAndForget = true;
      } else {
        action = WattBoxOutletAction.OFF;
      }
      await this.wattbox.commandOutlet(this.outletId, action, fireAndForget);
    } catch (error: unknown) {
      this.log.error(
        '[%s] An error occurred setting Characteristic On; %s',
        this.outletName,
        (<Error>error).message,
      );
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private getOn(): CharacteristicValue {
    if (this.status === WattBoxOutletStatus.UNKNOWN) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    this.log.debug(
      '[%s] Get Characteristic On ->',
      this.outletName,
      WattBoxOutletStatus[this.status],
    );
    return !!this.status;
  }
}
