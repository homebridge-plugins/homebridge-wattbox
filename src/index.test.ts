import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { WattBoxHomebridgePlatform } from './platform';
import registerPlatform from './index';
import { expect, jest } from '@jest/globals';

describe('index', () => {
  it('should register the platform with Homebridge', () => {
    const api = {
      registerPlatform: jest.fn(),
    } as unknown as API;

    registerPlatform(api);

    expect(api.registerPlatform).toHaveBeenCalledWith(PLATFORM_NAME, WattBoxHomebridgePlatform);
  });
});
