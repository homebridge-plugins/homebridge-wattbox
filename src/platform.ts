import {
  API,
  APIEvent,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import {
  WattBoxOutletPlatformAccessory,
  WattBoxOutletPlatformAccessoryContext,
} from './platformAccessory';
import { WattBox, WattBoxConfig, WattBoxStatus } from './wattbox';
import { createEveCharacteristics, EveCharacteristics } from './customCharacteristics';

type WattBoxHomebridgePlatformConfig = PlatformConfig &
  WattBoxConfig & {
    includeOutlets?: string[];
    excludeOutlets?: string[];
  };

export class WattBoxHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  public readonly config: WattBoxHomebridgePlatformConfig;
  public readonly wattbox: WattBox;
  public readonly eve: EveCharacteristics;

  constructor(
    public readonly log: Logger,
    public readonly platformConfig: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.eve = createEveCharacteristics(this.api);
    this.config = <WattBoxHomebridgePlatformConfig>this.platformConfig;
    this.wattbox = new WattBox(log, this.config);
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => this.discoverDevices());
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    let wattBoxStatus: WattBoxStatus;
    try {
      wattBoxStatus = await this.wattbox.getStatus();
    } catch (error: unknown) {
      this.log.error(
        'Failed to get the status from the wattbox; verify IP address, username, and password are correct',
      );
      return;
    }
    const discoveredServices: Array<Service> = [];

    const uuid = this.api.hap.uuid.generate(wattBoxStatus.information.serialNumber);
    const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);
    const accessory =
      existingAccessory ?? new this.api.platformAccessory(this.config.name ?? 'WattBox', uuid);

    // Update the accessory context with the general info.
    accessory.context = <WattBoxOutletPlatformAccessoryContext>{
      model: wattBoxStatus.information.model,
      serialNumber: wattBoxStatus.information.serialNumber,
    };

    // Monkeypatch accessory methods for getting services in order to identify orphaned services.
    const patch = (methodName) => {
      const original = accessory[methodName].bind(accessory);
      accessory[methodName] = (...args) => {
        const service = original(...args);
        if (service) {
          discoveredServices.push(service);
        }
        return service;
      };
    };
    patch('getService');
    patch('addService');
    patch('getServiceById');

    accessory
      .getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, 'WattBox')
      .setCharacteristic(this.Characteristic.Model, wattBoxStatus.information.model)
      .setCharacteristic(this.Characteristic.SerialNumber, wattBoxStatus.information.serialNumber);

    for (const outlet of wattBoxStatus.outlets) {
      if (
        Array.isArray(this.config.excludeOutlets) &&
        this.config.excludeOutlets.includes(outlet.name)
      ) {
        continue;
      }
      if (
        Array.isArray(this.config.includeOutlets) &&
        !this.config.includeOutlets.includes(outlet.name)
      ) {
        continue;
      }
      new WattBoxOutletPlatformAccessory(this, accessory, outlet);
    }

    // Remove any cached services that were orphaned.
    accessory.services
      .filter((service) => !discoveredServices.some((s) => Object.is(s, service)))
      .forEach((service) => {
        this.log.info('Removing orphaned service from cache:', service.displayName);
        accessory.removeService(service);
      });

    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', accessory.displayName);
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.log.info('Adding new accessory:', accessory.displayName);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    const orphanedAccessories = this.accessories.filter((accessory) => accessory.UUID !== uuid);
    if (orphanedAccessories.length > 0) {
      this.log.info(
        'Removing orphaned accessories from cache: ',
        orphanedAccessories.map(({ displayName }) => displayName).join(', '),
      );
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, orphanedAccessories);
    }
  }
}
