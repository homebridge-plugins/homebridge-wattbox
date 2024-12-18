import xml2js from 'xml2js';
import PubSub from 'pubsub-js';
import { Logger } from 'homebridge';

import { Cache, createCache } from 'cache-manager';
import net from 'net';
import querystring, { ParsedUrlQueryInput } from 'querystring';
import AsyncLock from 'async-lock';
import Token = PubSubJS.Token;
import { HTTPParser } from 'http-parser-js';
import { Keyv, KeyvCacheableMemory } from 'cacheable';

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

export interface WattBoxConfig {
  address: string;
  username: string;
  password: string;
  outletStatusPollInterval?: number;
  outletStatusCacheTtl?: number;
}

export class WattBox {
  private static readonly PUB_SUB_OUTLET_TOPIC = 'outlet';

  private static readonly OUTLET_STATUS_CACHE_KEY = 'outlet-status';
  private static readonly OUTLET_STATUS_CACHE_TTL_MS_DEFAULT = 15 * 1000;
  private static readonly OUTLET_STATUS_CACHE_TTL_MS_MIN = 5 * 1000;
  private static readonly OUTLET_STATUS_CACHE_TTL_MS_MAX = 60 * 1000;

  private static readonly OUTLET_STATUS_POLL_INTERVAL_MS_DEFAULT = 15 * 1000;
  private static readonly OUTLET_STATUS_POLL_INTERVAL_MS_MIN = 5 * 1000;
  private static readonly OUTLET_STATUS_POLL_INTERVAL_MS_MAX = 60 * 1000;

  private static readonly OUTLET_STATUS_LOCK = 'OUTLET_STATUS';

  private readonly lock = new AsyncLock();
  private readonly cache: Cache;

  constructor(
    public readonly log: Logger,
    private readonly config: WattBoxConfig,
  ) {
    const store = new KeyvCacheableMemory({
      ttl: undefined, // No default ttl
      lruSize: 0, // Infinite capacity
    });
    const keyv = new Keyv({ store });
    this.cache = createCache({ stores: [keyv] });
  }

  subscribe(outletId: string, func: (outlet: WattBoxOutlet) => void): Token {
    const topic = WattBox.outletStatusTopic(outletId);
    const token = PubSub.subscribe(topic, async (_, data) => {
      if (!data) {
        return;
      }
      func(data);
    });
    this.log.debug('[API] Status subscription added for outlet %s [token=%s]', outletId, token);

    // When this is the first subscription, start polling to publish updates.
    if (PubSub.countSubscriptions(topic) === 1) {
      const poll = async () => {
        // Stop polling when there are no active subscriptions.
        if (PubSub.countSubscriptions(topic) === 0) {
          this.log.debug('[API] There are no outlet status subscriptions; skipping poll');
          return;
        }
        // Acquire the status lock before emitting any new events.
        this.log.debug('[API] Polling status for outlet %s', outletId);
        try {
          PubSub.publish(topic, await this.getOutletStatus(outletId));
        } catch (error: unknown) {
          if (error instanceof Error) {
            this.log.error(
              '[API] An error occurred polling for a status update; %s',
              error.message,
            );
          }
        }
        setTimeout(poll, this.pollIntervalMs);
      };
      setTimeout(poll, 0);
    }
    return token;
  }

  unsubscribe(token: Token): void {
    PubSub.unsubscribe(token);
    this.log.debug('[API] Status subscription removed for token %s', token);
  }

  async getStatus(): Promise<WattBoxStatus> {
    return this.lock.acquire(
      WattBox.OUTLET_STATUS_LOCK,
      async (): Promise<WattBoxStatus> =>
        this.cache.wrap(
          WattBox.OUTLET_STATUS_CACHE_KEY,
          async (): Promise<WattBoxStatus> => {
            this.log.debug('[API] Fetching status from WattBox API');
            const { request } = await this.xmlRequest<WattBoxInfoResponse>({
              method: 'get',
              path: '/wattbox_info.xml',
            });
            return {
              information: {
                hostname: request.host_name,
                model: request.hardware_version,
                serialNumber: request.serial_number,
              },
              autoReboot: {
                enabled: request.auto_reboot === '1',
                connections: request.site_ip
                  .map((ip, i) => ({
                    targetIp: ip,
                    responseTimeMs: parseInt(request.connect_status[i]),
                    timeoutPercent: parseInt(request.site_lost[i]),
                  }))
                  .filter(({ targetIp }) => targetIp !== '0'),
              },
              outlets: request.outlet_name.map((name, i) => ({
                id: `${i + 1}`,
                name,
                status: parseInt(request.outlet_status[i]),
                mode: parseInt(request.outlet_method[i]),
              })),
              leds: {
                internet: parseInt(request.led_status[0]),
                system: parseInt(request.led_status[1]),
                autoReboot: parseInt(request.led_status[2]),
              },
              safeVoltageStatus: parseInt(request.safe_voltage_status),
              voltage: parseInt(request.voltage_value) / 10.0,
              current: parseInt(request.current_value) / 10.0,
              power: parseInt(request.power_value) / 10.0,
              cloudOnline: request.cloud_status === '1',
              ups:
                request.hasUPS === '0'
                  ? null
                  : {
                      audibleAlarmEnabled: request.audible_alarm === '1',
                      estRunTimeMinutes: parseInt(request.est_run_time),
                      batteryTestEnabled: request.battery_test === '1',
                      batteryHealthy: request.battery_health === '1',
                      batteryChargePercent: parseInt(request.battery_charge),
                      batteryLoadPercent: parseInt(request.battery_load),
                      onBattery: request.power_lost === '1',
                      isMuted: request.mute === '1',
                    },
            };
          },
          this.outletStatusCacheTtlMs,
        ),
    );
  }

  async getOutletStatus(outletId: string): Promise<WattBoxOutlet> {
    const { outlets } = await this.getStatus();
    const outletInfo = outlets.find(({ id }) => id === outletId) ?? null;
    if (outletInfo === null) {
      throw new Error(`unknown outlet with id=${outletId}`);
    }
    return outletInfo;
  }

  async commandOutlet(
    outletId: string,
    command: WattBoxOutletAction,
    fireAndForget: boolean = false,
  ): Promise<void> {
    return this.lock.acquire(WattBox.OUTLET_STATUS_LOCK, async () => {
      await this.xmlRequest(
        {
          method: 'get',
          path: '/control.cgi',
          params: {
            outlet: outletId,
            command,
          },
        },
        fireAndForget,
      );
      await this.cache.del(WattBox.OUTLET_STATUS_CACHE_KEY);
    });
  }

  private async xmlRequest(config: XmlRequest, fireAndForget: true): Promise<null>;

  private async xmlRequest<T extends xml2js.convertableToString>(
    config: XmlRequest,
    fireAndForget?: false,
  ): Promise<T>;

  private async xmlRequest<T extends xml2js.convertableToString>(
    config: XmlRequest,
    fireAndForget?: boolean,
  ): Promise<T | null>;

  private async xmlRequest<T extends xml2js.convertableToString>(
    config: XmlRequest,
    fireAndForget?: boolean,
  ): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const { host, port } = new URL(this.config.address);
      const qs = config.params ? `?${querystring.stringify(config.params)}` : '';
      const socket = net.createConnection(
        {
          host,
          port: parseInt(port || '80'),
        },
        () => {
          socket.write(
            `${config.method!.toUpperCase()} ${config.path}${qs} HTTP/1.1\r\n` +
              'Connection: keep-alive\r\n' +
              `Authorization: Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}\r\n` +
              '\r\n',
          );
          socket.end();
          if (fireAndForget) {
            socket.destroy();
            resolve(null);
          }
        },
      );
      if (fireAndForget) {
        return;
      }
      let data = Buffer.of();
      socket.on('error', (error) => {
        reject(error);
      });
      socket.on('data', (buffer: Buffer) => {
        data = Buffer.concat([data, buffer]);
      });
      socket.on('end', () => {
        try {
          const { body, statusCode } = parseHttpResponse(data);
          if (statusCode >= 200 && statusCode < 300) {
            resolve(parser.parseStringPromise(body.toString()));
          } else {
            reject(
              new Error(
                `HTTP ${config.method.toUpperCase()} request to ${this.config.address}${config.path}${qs} failed with status ${statusCode}`,
              ),
            );
          }
        } catch (error: unknown) {
          reject(error);
        }
      });
    });
  }

  private get outletStatusCacheTtlMs(): number {
    return Math.max(
      WattBox.OUTLET_STATUS_CACHE_TTL_MS_MIN,
      Math.min(
        WattBox.OUTLET_STATUS_CACHE_TTL_MS_MAX,
        (this.config.outletStatusCacheTtl ?? 0) * 1000 ||
          WattBox.OUTLET_STATUS_CACHE_TTL_MS_DEFAULT,
      ),
    );
  }

  private get pollIntervalMs(): number {
    return Math.max(
      WattBox.OUTLET_STATUS_POLL_INTERVAL_MS_MIN,
      Math.min(
        WattBox.OUTLET_STATUS_POLL_INTERVAL_MS_MAX,
        this.config.outletStatusPollInterval ?? WattBox.OUTLET_STATUS_POLL_INTERVAL_MS_DEFAULT,
      ),
    );
  }

  private static outletStatusTopic(outletId: string): string {
    return `${WattBox.PUB_SUB_OUTLET_TOPIC}.${outletId}`;
  }
}

const parser = new xml2js.Parser({
  explicitArray: false,
  valueProcessors: [
    // Split comma delimited strings
    (value) => {
      return value.includes(',') ? value.split(',').map((v) => v.trim()) : value;
    },
  ],
});

function parseHttpResponse(input: Buffer) {
  const parser = new HTTPParser(HTTPParser.RESPONSE);
  let complete = false;
  let shouldKeepAlive: boolean;
  let upgrade: boolean;
  let statusCode: number;
  let statusMessage: string;
  let versionMajor: number;
  let versionMinor: number;
  let headers: string[] = [];
  let trailers: string[] = [];
  const bodyChunks: Buffer[] = [];

  parser[HTTPParser.kOnHeadersComplete] = function (res) {
    shouldKeepAlive = res.shouldKeepAlive;
    upgrade = res.upgrade;
    statusCode = res.statusCode;
    statusMessage = res.statusMessage;
    versionMajor = res.versionMajor;
    versionMinor = res.versionMinor;
    headers = res.headers;
  };

  parser[HTTPParser.kOnBody] = function (chunk, offset, length) {
    bodyChunks.push(chunk.subarray(offset, offset + length));
  };

  parser[HTTPParser.kOnHeaders] = function (t) {
    trailers = t;
  };

  parser[HTTPParser.kOnMessageComplete] = function () {
    complete = true;
  };

  parser.execute(input);
  parser.finish();

  if (!complete) {
    throw new Error('Could not parse HTTP response');
  }

  return {
    shouldKeepAlive: shouldKeepAlive!,
    upgrade: upgrade!,
    statusCode: statusCode!,
    statusMessage: statusMessage!,
    versionMajor: versionMajor!,
    versionMinor: versionMinor!,
    headers,
    body: Buffer.concat(bodyChunks),
    trailers,
  };
}

interface XmlRequest {
  method:
    | 'DELETE'
    | 'delete'
    | 'GET'
    | 'get'
    | 'HEAD'
    | 'head'
    | 'PATCH'
    | 'patch'
    | 'POST'
    | 'post'
    | 'PUT'
    | 'put'
    | 'OPTIONS'
    | 'options';
  path: string;
  params?: ParsedUrlQueryInput;
}

interface WattBoxInfoResponse {
  request: WattBoxInfoResponseBody;
}

interface WattBoxInfoResponseBody {
  host_name: string;
  hardware_version: string;
  serial_number: string;
  site_ip: string[];
  connect_status: string[];
  site_lost: string[];
  auto_reboot: string;
  outlet_name: string[];
  outlet_status: string[];
  outlet_method: string[];
  led_status: string[];
  safe_voltage_status: string;
  voltage_value: string;
  current_value: string;
  power_value: string;
  cloud_status: string;
  hasUPS: string;
  audible_alarm: string;
  est_run_time: string;
  battery_test: string;
  battery_health: string;
  battery_charge: string;
  battery_load: string;
  power_lost: string;
  mute: string;
}
