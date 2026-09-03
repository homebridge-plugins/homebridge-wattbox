export interface WattBoxStatus {
  information: WattBoxInformation;
  autoReboot: WattBoxAutoReboot;
  outlets: WattBoxOutlet[];
  leds: WattBoxLEDs;
  safeVoltageStatus: WattBoxSafeVoltageStatus;
  voltage: number;
  current: number;
  power: number;
  cloudOnline: boolean;
  ups: WattBoxUPS | null;
}

export interface WattBoxInformation {
  hostname: string;
  model: string;
  serialNumber: string;
}

export interface WattBoxAutoReboot {
  enabled: boolean;
  connections: WattBoxConnectionStatus[];
}

export interface WattBoxConnectionStatus {
  targetIp: string;
  responseTimeMs: number;
  timeoutPercent: number;
}

export interface WattBoxOutlet {
  id: string;
  name: string;
  status: WattBoxOutletStatus;
  mode: WattBoxOutletMode;
  // Per-outlet metering, when the device and transport support it (WB-800-IPVM over the
  // Integration Protocol). Undefined when unavailable.
  powerWatts?: number;
  currentAmps?: number;
  voltageVolts?: number;
}

export enum WattBoxOutletStatus {
  UNKNOWN = -1,
  OFF = 0,
  ON = 1,
}

export enum WattBoxOutletMode {
  DISABLED = 0,
  NORMAL = 1,
  RESET_ONLY = 2,
}

export interface WattBoxLEDs {
  internet: WattBoxLedStatus;
  system: WattBoxLedStatus;
  autoReboot: WattBoxLedStatus;
}

export enum WattBoxLedStatus {
  OFF = 0,
  GREEN_ON = 1,
  RED_ON = 2,
  GREEN_BLINKING = 3,
  RED_BLINKING = 4,
}

export enum WattBoxSafeVoltageStatus {
  OFF = 0,
  SAFE = 1,
  UNSAFE = 2,
}

export enum WattBoxOutletAction {
  OFF = 0,
  ON = 1,
  POWER_RESET = 3, // Outlet must be on.
  AUTO_REBOOT_ON = 4,
  AUTO_REBOOT_OFF = 5,
}

export interface WattBoxUPS {
  audibleAlarmEnabled: boolean;
  estRunTimeMinutes: number;
  batteryTestEnabled: boolean;
  batteryHealthy: boolean;
  batteryChargePercent: number;
  batteryLoadPercent: number;
  onBattery: boolean;
  isMuted: boolean;
}

// Which wire protocol to use to talk to the WattBox.
//  - 'http':        legacy HTTP/XML API (older/cloud firmware)
//  - 'integration': WattBox Integration Protocol over TCP (current OvrC firmware)
//  - 'auto':        probe the Integration Protocol first, fall back to HTTP
export type WattBoxTransportKind = 'auto' | 'http' | 'integration';

export interface WattBoxConfig {
  address: string;
  username: string;
  password: string;
  transport?: WattBoxTransportKind;
  port?: number;
  outletStatusPollInterval?: number;
  outletStatusCacheTtl?: number;
}
