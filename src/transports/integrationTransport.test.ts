import { expect } from '@jest/globals';
import {
  integrationAction,
  parseOutletNames,
  parseOutletPowerStatus,
  parseOutletStatuses,
  parsePowerStatus,
  parseUpsStatus,
} from './integrationTransport';
import { resolveHostPort } from './transport';
import { WattBoxOutletAction, WattBoxOutletStatus, WattBoxSafeVoltageStatus } from './types';

describe('integration protocol parsing', () => {
  it('parses brace-wrapped outlet names, including names containing commas', () => {
    const line = '{Router},{Switch},{Sub Amps, XBOX & Rack Fans},{Unused}';
    expect(parseOutletNames(line)).toEqual([
      'Router',
      'Switch',
      'Sub Amps, XBOX & Rack Fans',
      'Unused',
    ]);
  });

  it('falls back to a plain comma split when names are not brace-wrapped', () => {
    expect(parseOutletNames('Router,Switch')).toEqual(['Router', 'Switch']);
  });

  it('parses outlet status flags into ON/OFF', () => {
    expect(parseOutletStatuses('1,0,1,1')).toEqual([
      WattBoxOutletStatus.ON,
      WattBoxOutletStatus.OFF,
      WattBoxOutletStatus.ON,
      WattBoxOutletStatus.ON,
    ]);
  });

  it('maps outlet actions onto Integration Protocol verbs', () => {
    expect(integrationAction(WattBoxOutletAction.ON)).toBe('ON');
    expect(integrationAction(WattBoxOutletAction.OFF)).toBe('OFF');
    expect(integrationAction(WattBoxOutletAction.POWER_RESET)).toBe('RESET');
    expect(integrationAction(WattBoxOutletAction.AUTO_REBOOT_ON)).toBeUndefined();
  });

  it('parses whole-unit power (current, power, voltage, safe voltage)', () => {
    expect(parsePowerStatus('2.84,344.84,122.18,0')).toEqual({
      currentAmps: 2.84,
      powerWatts: 344.84,
      voltageVolts: 122.18,
      safeVoltageStatus: WattBoxSafeVoltageStatus.OFF,
    });
  });

  it('parses per-outlet power (outlet, power, current, voltage)', () => {
    expect(parseOutletPowerStatus('1,18.51,0.07,122.18')).toEqual({
      id: '1',
      powerWatts: 18.51,
      currentAmps: 0.07,
      voltageVolts: 122.18,
    });
  });

  it('parses UPS status', () => {
    expect(parseUpsStatus('100,25,Good,False,30,False,True')).toEqual({
      batteryChargePercent: 100,
      batteryLoadPercent: 25,
      batteryHealthy: true,
      onBattery: false,
      estRunTimeMinutes: 30,
      audibleAlarmEnabled: false,
      isMuted: true,
      batteryTestEnabled: false,
    });
  });
});

describe('resolveHostPort', () => {
  it('handles a bare host', () => {
    expect(resolveHostPort('10.0.0.9', 23)).toEqual({ host: '10.0.0.9', port: 23 });
  });

  it('handles host:port', () => {
    expect(resolveHostPort('10.0.0.9:2323', 23)).toEqual({ host: '10.0.0.9', port: 2323 });
  });

  it('strips a scheme and path from a URL-ish address', () => {
    expect(resolveHostPort('http://10.0.0.9/foo', 23)).toEqual({ host: '10.0.0.9', port: 23 });
  });

  it('prefers an explicit port override', () => {
    expect(resolveHostPort('10.0.0.9:2323', 23, 9000)).toEqual({ host: '10.0.0.9', port: 9000 });
  });
});
