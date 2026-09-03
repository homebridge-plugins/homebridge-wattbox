import net from 'net';
import { Logger } from 'homebridge';

import { OutletUpdateHandler, resolveHostPort, WattBoxTransport } from './transport';
import {
  WattBoxConfig,
  WattBoxOutlet,
  WattBoxOutletAction,
  WattBoxOutletMode,
  WattBoxOutletStatus,
  WattBoxSafeVoltageStatus,
  WattBoxStatus,
  WattBoxUPS,
} from './types';

const DEFAULT_PORT = 23;
const CONNECT_TIMEOUT_MS = 8000;
const COMMAND_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 6000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const OUTLET_STATUS_PREFIX = '?OutletStatus=';

// Map the plugin's outlet actions onto the Integration Protocol's !OutletSet verbs.
const INTEGRATION_ACTION: Partial<Record<WattBoxOutletAction, string>> = {
  [WattBoxOutletAction.ON]: 'ON',
  [WattBoxOutletAction.OFF]: 'OFF',
  [WattBoxOutletAction.POWER_RESET]: 'RESET',
};

// Outlet names come back brace-wrapped and comma-separated, e.g.
//   {Router},{Switch},{Sub Amps, XBOX & Rack Fans}
// so a name may itself contain commas; parse by brace groups, not a plain split.
export function parseOutletNames(value: string): string[] {
  const names: string[] = [];
  const re = /\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    names.push(match[1]);
  }
  if (names.length === 0 && value.trim().length > 0) {
    // Fall back to a plain comma split for firmware that does not brace-wrap.
    return value.split(',').map((v) => v.trim());
  }
  return names;
}

// Outlet status is a comma-separated list of 0/1, e.g. 1,0,1,1
export function parseOutletStatuses(value: string): WattBoxOutletStatus[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => (v === '1' ? WattBoxOutletStatus.ON : WattBoxOutletStatus.OFF));
}

export function integrationAction(command: WattBoxOutletAction): string | undefined {
  return INTEGRATION_ACTION[command];
}

// The reply echoes the command: '?Model' -> '?Model=<data>', and an argument-bearing query
// '?OutletPowerStatus=2' -> '?OutletPowerStatus=2,<data>'. Matching on this full prefix (argument
// included) stops a late/stale reply for one argument from resolving an in-flight query for
// another (e.g. a timed-out outlet 1 reply satisfying the outlet 2 query).
export function replyPrefixFor(command: string): string {
  const eq = command.indexOf('=');
  return eq === -1 ? `${command}=` : `${command},`;
}

export interface UnitPower {
  currentAmps: number;
  powerWatts: number;
  voltageVolts: number;
  safeVoltageStatus: WattBoxSafeVoltageStatus;
}

// ?PowerStatus=<current>,<power>,<voltage>,<safeVoltage>  e.g. 2.84,344.84,122.18,0
export function parsePowerStatus(value: string): UnitPower {
  const [current, power, voltage, safe] = value.split(',').map((v) => v.trim());
  const safeVoltageStatus =
    (parseInt(safe, 10) as WattBoxSafeVoltageStatus) || WattBoxSafeVoltageStatus.OFF;
  return {
    currentAmps: parseFloat(current) || 0,
    powerWatts: parseFloat(power) || 0,
    voltageVolts: parseFloat(voltage) || 0,
    safeVoltageStatus,
  };
}

export interface OutletPower {
  id: string;
  powerWatts: number;
  currentAmps: number;
  voltageVolts: number;
}

// ?OutletPowerStatus=<outlet>,<power>,<current>,<voltage>  e.g. 1,18.51,0.07,122.18
export function parseOutletPowerStatus(value: string): OutletPower {
  const [id, power, current, voltage] = value.split(',').map((v) => v.trim());
  return {
    id,
    powerWatts: parseFloat(power) || 0,
    currentAmps: parseFloat(current) || 0,
    voltageVolts: parseFloat(voltage) || 0,
  };
}

// ?UPSStatus=<charge>,<load>,<health>,<onBattery>,<runtime>,<alarm>,<muted>
//   e.g. 100,25,Good,False,30,False,False
export function parseUpsStatus(value: string): WattBoxUPS {
  const [charge, load, health, onBattery, runtime, alarm, muted] = value
    .split(',')
    .map((v) => v.trim());
  const isTrue = (v: string) => /^true$/i.test(v);
  return {
    batteryChargePercent: parseInt(charge, 10) || 0,
    batteryLoadPercent: parseInt(load, 10) || 0,
    batteryHealthy: /^good$/i.test(health),
    onBattery: isTrue(onBattery),
    estRunTimeMinutes: parseInt(runtime, 10) || 0,
    audibleAlarmEnabled: isTrue(alarm),
    isMuted: isTrue(muted),
    // Not exposed by the Integration Protocol; default off.
    batteryTestEnabled: false,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Matches the reply line for an in-flight command. Query commands ('?Model') expect a line that
// starts with the command plus '='; control commands ('!OutletSet=..') expect 'OK' or an error.
type ReplyMatcher = { kind: 'prefix'; value: string } | { kind: 'ok' };

interface PendingCommand {
  line: string;
  matcher: ReplyMatcher;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

type Phase = 'disconnected' | 'auth-user' | 'auth-pass' | 'auth-wait' | 'ready';

// WattBox Integration Protocol transport. Holds a single persistent, logged-in TCP session, serves
// queries over it, listens for unsolicited ?OutletStatus pushes for real-time updates, and
// auto-reconnects. See the WattBox Integration Protocol reference for the command grammar.
export class IntegrationTransport implements WattBoxTransport {
  private readonly host: string;
  private readonly port: number;

  private socket: net.Socket | null = null;
  private phase: Phase = 'disconnected';
  private rxBuffer = '';

  private connectDeferred: Deferred<void> | null = null;
  private connectTimer: NodeJS.Timeout | null = null;

  private readonly queue: PendingCommand[] = [];
  private inflight: PendingCommand | null = null;

  private infoLoaded = false;
  private model = '';
  private hostname = '';
  private serviceTag = '';
  private outletNames: string[] = [];

  // Metering capabilities are assumed available until the device reports otherwise (some models do
  // not support these commands); once a command errors it is not retried for the session.
  private unitPowerSupported = true;
  private outletPowerSupported = true;
  private upsSupported = true;
  private autoRebootSupported = true;

  private readonly handlers: OutletUpdateHandler[] = [];

  // Auto-reconnect only runs once the transport has been accepted for use, so a failed probe (or a
  // non-Integration device) does not spin a reconnect loop.
  private activated = false;
  private disposed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly log: Logger,
    private readonly config: WattBoxConfig,
  ) {
    const { host, port } = resolveHostPort(config.address, DEFAULT_PORT, config.port);
    this.host = host;
    this.port = port;
  }

  // Try to connect and log in and run one query. Used by auto-detect; leaves the connection open on
  // success so it can be reused.
  async probe(): Promise<boolean> {
    try {
      await withTimeout(this.ensureConnected(), PROBE_TIMEOUT_MS, 'probe');
      await this.query('?Model');
      return true;
    } catch (error: unknown) {
      this.log.debug(
        '[Integration] Probe of %s:%d failed; %s',
        this.host,
        this.port,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  // Enable auto-reconnect once the caller has committed to this transport.
  activate(): void {
    this.activated = true;
  }

  onOutletUpdate(handler: OutletUpdateHandler): void {
    this.handlers.push(handler);
  }

  async getStatus(): Promise<WattBoxStatus> {
    await this.ensureConnected();
    await this.loadInfo();
    const statuses = parseOutletStatuses(await this.query('?OutletStatus'));
    const unit = await this.readUnitPower();
    const outletPower = await this.readOutletPower(this.outletNames.length);
    const outlets: WattBoxOutlet[] = this.outletNames.map((name, i) => {
      const id = `${i + 1}`;
      const power = outletPower.get(id);
      return {
        id,
        name,
        status: statuses[i] ?? WattBoxOutletStatus.UNKNOWN,
        mode: WattBoxOutletMode.NORMAL,
        ...(power
          ? {
              powerWatts: power.powerWatts,
              currentAmps: power.currentAmps,
              voltageVolts: power.voltageVolts,
            }
          : {}),
      };
    });
    return {
      information: {
        hostname: this.hostname || this.host,
        model: this.model,
        serialNumber: this.serviceTag || this.model,
      },
      autoReboot: { enabled: await this.readAutoReboot(), connections: [] },
      outlets,
      // LED status is not surfaced to HomeKit; reported as inert defaults.
      leds: {
        internet: 0,
        system: 0,
        autoReboot: 0,
      },
      safeVoltageStatus: unit?.safeVoltageStatus ?? WattBoxSafeVoltageStatus.OFF,
      voltage: unit?.voltageVolts ?? 0,
      current: unit?.currentAmps ?? 0,
      power: unit?.powerWatts ?? 0,
      cloudOnline: false,
      ups: await this.readUps(),
    };
  }

  private async readUnitPower(): Promise<UnitPower | null> {
    if (!this.unitPowerSupported) {
      return null;
    }
    try {
      return parsePowerStatus(await this.query('?PowerStatus'));
    } catch {
      this.unitPowerSupported = false;
      this.log.debug('[Integration] ?PowerStatus unsupported; disabling unit power monitoring');
      return null;
    }
  }

  private async readOutletPower(count: number): Promise<Map<string, OutletPower>> {
    const result = new Map<string, OutletPower>();
    if (!this.outletPowerSupported) {
      return result;
    }
    for (let i = 1; i <= count; i++) {
      try {
        const power = parseOutletPowerStatus(await this.query(`?OutletPowerStatus=${i}`));
        result.set(`${i}`, power);
      } catch {
        // First failure disables per-outlet metering for the session (model does not support it).
        this.outletPowerSupported = false;
        this.log.debug(
          '[Integration] ?OutletPowerStatus unsupported; disabling per-outlet power monitoring',
        );
        result.clear();
        return result;
      }
    }
    return result;
  }

  private async readUps(): Promise<WattBoxUPS | null> {
    if (!this.upsSupported) {
      return null;
    }
    try {
      const connected = (await this.query('?UPSConnection')).trim() === '1';
      if (!connected) {
        return null;
      }
      return parseUpsStatus(await this.query('?UPSStatus'));
    } catch {
      this.upsSupported = false;
      this.log.debug('[Integration] ?UPSStatus unsupported; disabling UPS monitoring');
      return null;
    }
  }

  private async readAutoReboot(): Promise<boolean> {
    if (!this.autoRebootSupported) {
      return false;
    }
    try {
      return (await this.query('?AutoReboot')).trim() === '1';
    } catch {
      this.autoRebootSupported = false;
      return false;
    }
  }

  async commandOutlet(
    outletId: string,
    command: WattBoxOutletAction,
    fireAndForget: boolean = false,
  ): Promise<void> {
    const action = integrationAction(command);
    if (!action) {
      throw new Error(`unsupported outlet action ${command}`);
    }
    await this.ensureConnected();
    const line = `!OutletSet=${outletId},${action}`;
    if (fireAndForget) {
      this.write(line);
      return;
    }
    await this.send(line, { kind: 'ok' });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket(new Error('transport disposed'));
  }

  private async loadInfo(): Promise<void> {
    if (this.infoLoaded) {
      return;
    }
    this.model = await this.query('?Model');
    this.hostname = await this.query('?Hostname').catch(() => this.host);
    this.serviceTag = await this.query('?ServiceTag').catch(() => this.model);
    this.outletNames = parseOutletNames(await this.query('?OutletName'));
    this.infoLoaded = true;
  }

  private async query(command: string): Promise<string> {
    await this.ensureConnected();
    // Correlate on the full echoed prefix (argument included) so a stale reply for a different
    // argument cannot resolve this query...
    const replyPrefix = replyPrefixFor(command);
    const line = await this.send(command, { kind: 'prefix', value: replyPrefix });
    // ...but return the payload after the base '?Cmd=' so any echoed argument stays in the value
    // (e.g. '?OutletPowerStatus=2,18.5,..' -> '2,18.5,..' for parseOutletPowerStatus).
    const base = command.split('=')[0];
    return line.slice(base.length + 1);
  }

  private send(line: string, matcher: ReplyMatcher): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ line, matcher, resolve, reject, timer: null });
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.inflight || this.phase !== 'ready') {
      return;
    }
    const cmd = this.queue.shift();
    if (!cmd) {
      return;
    }
    this.inflight = cmd;
    cmd.timer = setTimeout(() => {
      this.inflight = null;
      cmd.reject(new Error(`WattBox command timed out: ${cmd.line}`));
      this.processQueue();
    }, COMMAND_TIMEOUT_MS);
    this.write(cmd.line);
  }

  private resolveInflight(line: string): void {
    const cmd = this.inflight;
    if (!cmd) {
      return;
    }
    if (cmd.timer) {
      clearTimeout(cmd.timer);
    }
    this.inflight = null;
    cmd.resolve(line);
    this.processQueue();
  }

  private rejectInflight(error: Error): void {
    const cmd = this.inflight;
    if (!cmd) {
      return;
    }
    if (cmd.timer) {
      clearTimeout(cmd.timer);
    }
    this.inflight = null;
    cmd.reject(error);
    this.processQueue();
  }

  private ensureConnected(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('transport disposed'));
    }
    if (this.phase === 'ready') {
      return Promise.resolve();
    }
    if (!this.connectDeferred) {
      this.connectDeferred = deferred<void>();
      this.openSocket();
    }
    return this.connectDeferred.promise;
  }

  private openSocket(): void {
    this.teardownSocket();
    this.phase = 'auth-user';
    this.rxBuffer = '';
    this.log.debug('[Integration] Connecting to %s:%d', this.host, this.port);
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setKeepAlive(true, 30000);
    socket.on('data', (buffer: Buffer) => this.onData(buffer));
    socket.on('error', (error) => this.onSocketDown(error));
    socket.on('close', () => this.onSocketDown(new Error('connection closed')));
    this.connectTimer = setTimeout(() => {
      if (this.phase !== 'ready') {
        this.onSocketDown(new Error('login timed out'));
      }
    }, CONNECT_TIMEOUT_MS);
  }

  private onData(buffer: Buffer): void {
    this.rxBuffer += buffer.toString('utf8');
    if (this.phase !== 'ready') {
      this.handleAuth();
      return;
    }
    let newline: number;
    while ((newline = this.rxBuffer.indexOf('\n')) >= 0) {
      const line = this.rxBuffer.slice(0, newline).replace(/\r$/, '').trim();
      this.rxBuffer = this.rxBuffer.slice(newline + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
    }
  }

  private handleAuth(): void {
    const buffer = this.rxBuffer;
    if (this.phase === 'auth-user' && buffer.includes('Username:')) {
      this.rxBuffer = '';
      this.phase = 'auth-pass';
      this.write(this.config.username);
    } else if (this.phase === 'auth-pass' && buffer.includes('Password:')) {
      this.rxBuffer = '';
      this.phase = 'auth-wait';
      this.write(this.config.password);
    } else if (this.phase === 'auth-wait') {
      if (buffer.includes('Successfully Logged In')) {
        this.rxBuffer = '';
        this.onReady();
      } else if (/Invalid Login|Login Incorrect|Unsuccessful|#Error/i.test(buffer)) {
        this.onSocketDown(
          new Error('WattBox login failed; verify username and password are correct'),
        );
      }
    }
  }

  private onReady(): void {
    this.phase = 'ready';
    this.reconnectAttempts = 0;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.log.debug('[Integration] Logged in to %s:%d', this.host, this.port);
    const pending = this.connectDeferred;
    this.connectDeferred = null;
    pending?.resolve();
    this.processQueue();
  }

  private handleLine(line: string): void {
    // Unsolicited status pushes double as the reply to a ?OutletStatus query.
    if (line.startsWith(OUTLET_STATUS_PREFIX)) {
      this.emitOutletStatus(line);
      if (
        this.inflight?.matcher.kind === 'prefix' &&
        this.inflight.matcher.value === OUTLET_STATUS_PREFIX
      ) {
        this.resolveInflight(line);
      }
      return;
    }
    const cmd = this.inflight;
    if (!cmd) {
      return;
    }
    if (cmd.matcher.kind === 'prefix') {
      if (line.startsWith(cmd.matcher.value)) {
        this.resolveInflight(line);
      } else if (line.startsWith('#')) {
        this.rejectInflight(new Error(`WattBox error for ${cmd.line}: ${line}`));
      }
    } else {
      if (line === 'OK') {
        this.resolveInflight(line);
      } else if (line.startsWith('#')) {
        this.rejectInflight(new Error(`WattBox error for ${cmd.line}: ${line}`));
      }
    }
  }

  private emitOutletStatus(line: string): void {
    const statuses = parseOutletStatuses(line.slice(OUTLET_STATUS_PREFIX.length));
    statuses.forEach((status, i) => {
      const id = `${i + 1}`;
      this.handlers.forEach((handler) =>
        handler({
          id,
          name: this.outletNames[i] ?? `Outlet ${id}`,
          status,
          mode: WattBoxOutletMode.NORMAL,
        }),
      );
    });
  }

  private onSocketDown(error: Error): void {
    if (this.phase === 'disconnected' && !this.socket) {
      return;
    }
    this.log.debug(
      '[Integration] Connection to %s:%d lost; %s',
      this.host,
      this.port,
      error.message,
    );
    this.teardownSocket(error);
    // Fail any callers waiting on a connection and any in-flight/queued commands.
    const pending = this.connectDeferred;
    this.connectDeferred = null;
    pending?.reject(error);
    this.rejectInflight(error);
    while (this.queue.length > 0) {
      this.queue.shift()!.reject(error);
    }
    if (this.activated && !this.disposed) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.log.debug('[Integration] Reconnecting to %s:%d in %dms', this.host, this.port, delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) {
        return;
      }
      // Re-establish the session; info is re-fetched lazily on the next status read.
      this.infoLoaded = false;
      this.ensureConnected().catch(() => {
        // ensureConnected failures surface via onSocketDown, which reschedules.
      });
    }, delay);
  }

  private teardownSocket(error?: Error): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.phase = 'disconnected';
    if (socket) {
      socket.removeAllListeners();
      socket.destroy(error);
    }
  }

  private write(line: string): void {
    this.socket?.write(`${line}\n`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
