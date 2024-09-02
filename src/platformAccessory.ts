import { CharacteristicValue, HAP, Logger, PlatformAccessory } from 'homebridge';

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

export class WattBoxOutletPlatformAccessory {
  private readonly log: Logger;
  private readonly hap: HAP;
  private readonly wattbox: WattBox;
  private readonly context: WattBoxOutletPlatformAccessoryContext;
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

    const statusCharacteristic = (this.accessory.getServiceById(
      this.platform.Service.Outlet,
      this.id,
    ) || this.accessory.addService(this.platform.Service.Outlet, this.outletName, this.id))!
      .setCharacteristic(this.platform.Characteristic.Name, this.outletName)
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.wattbox.subscribe(this.outletId, ({ status }) => {
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
    });
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
