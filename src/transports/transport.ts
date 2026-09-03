import { WattBoxOutlet, WattBoxOutletAction, WattBoxStatus } from './types';

export type OutletUpdateHandler = (outlet: WattBoxOutlet) => void;

// A transport is the wire-level driver that knows how to talk to a WattBox. The WattBox facade
// owns caching, polling and pub/sub and delegates the actual I/O to whichever transport matches
// the device firmware.
export interface WattBoxTransport {
  // Fetch a full status snapshot (device info + every outlet).
  getStatus(): Promise<WattBoxStatus>;

  // Turn an outlet on/off/reset. When fireAndForget is set the caller does not expect (or wait
  // for) a confirmation response.
  commandOutlet(
    outletId: string,
    command: WattBoxOutletAction,
    fireAndForget?: boolean,
  ): Promise<void>;

  // Register a handler invoked whenever the transport learns an outlet's state out-of-band (e.g.
  // an unsolicited push over a persistent connection). Transports without push support may never
  // call the handler.
  onOutletUpdate(handler: OutletUpdateHandler): void;

  // Release any resources (sockets, timers). The transport must not be used after disposal.
  dispose(): void;
}

// Resolve a bare host / host:port / URL-ish address into a host and port for a raw TCP transport.
// Accepts '10.0.0.9', '10.0.0.9:23', or 'http://10.0.0.9' and strips any scheme or path.
export function resolveHostPort(
  address: string,
  defaultPort: number,
  portOverride?: number,
): { host: string; port: number } {
  let value = (address ?? '').trim();
  const scheme = value.match(/^[a-z][a-z0-9+.-]*:\/\/(.*)$/i);
  if (scheme) {
    value = scheme[1];
  }
  value = value.split('/')[0];
  let host = value;
  let port = portOverride;
  const hostPort = value.match(/^(.*):(\d+)$/);
  if (hostPort) {
    host = hostPort[1];
    if (!port) {
      port = parseInt(hostPort[2], 10);
    }
  }
  return { host, port: port || defaultPort };
}
