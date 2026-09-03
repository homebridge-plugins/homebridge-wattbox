import PubSub from 'pubsub-js';
import { Logger } from 'homebridge';

import { Cache, createCache } from 'cache-manager';
import AsyncLock from 'async-lock';
import Token = PubSubJS.Token;
import { Keyv, KeyvCacheableMemory } from 'cacheable';

import { WattBoxTransport } from './transports/transport';
import { HttpXmlTransport } from './transports/httpXmlTransport';
import { IntegrationTransport } from './transports/integrationTransport';
import {
  WattBoxConfig,
  WattBoxOutlet,
  WattBoxOutletAction,
  WattBoxStatus,
} from './transports/types';

// Re-export the shared types so existing importers (platform, platformAccessory) keep working.
export * from './transports/types';

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

  private transportPromise?: Promise<WattBoxTransport>;

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

    // When this is the first subscription, start polling to publish updates. Transports with a
    // push channel (Integration Protocol) also publish updates out-of-band; polling remains a
    // fallback and the source of truth for transports without push.
    if (PubSub.countSubscriptions(topic) === 1) {
      // Kick off transport resolution so a persistent connection / push wiring starts promptly.
      this.transport().catch(() => {
        // Errors surface on the first getStatus/getOutletStatus call.
      });
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
    const transport = await this.transport();
    return this.lock.acquire(
      WattBox.OUTLET_STATUS_LOCK,
      async (): Promise<WattBoxStatus> =>
        this.cache.wrap(
          WattBox.OUTLET_STATUS_CACHE_KEY,
          async (): Promise<WattBoxStatus> => transport.getStatus(),
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
    const transport = await this.transport();
    return this.lock.acquire(WattBox.OUTLET_STATUS_LOCK, async () => {
      await transport.commandOutlet(outletId, command, fireAndForget);
      await this.cache.del(WattBox.OUTLET_STATUS_CACHE_KEY);
    });
  }

  private transport(): Promise<WattBoxTransport> {
    if (!this.transportPromise) {
      this.transportPromise = this.resolveTransport();
    }
    return this.transportPromise;
  }

  private async resolveTransport(): Promise<WattBoxTransport> {
    const kind = this.config.transport ?? 'auto';

    if (kind === 'http') {
      this.log.info('[API] Using WattBox HTTP transport');
      return this.wireTransport(new HttpXmlTransport(this.log, this.config));
    }

    if (kind === 'integration') {
      this.log.info('[API] Using WattBox Integration Protocol transport');
      const integration = new IntegrationTransport(this.log, this.config);
      integration.activate();
      return this.wireTransport(integration);
    }

    // auto: prefer the Integration Protocol, fall back to the legacy HTTP/XML API.
    const integration = new IntegrationTransport(this.log, this.config);
    if (await integration.probe()) {
      this.log.info('[API] Using WattBox Integration Protocol transport (auto-detected)');
      integration.activate();
      return this.wireTransport(integration);
    }
    integration.dispose();
    this.log.info('[API] Integration Protocol unavailable; using WattBox HTTP transport');
    return this.wireTransport(new HttpXmlTransport(this.log, this.config));
  }

  private wireTransport(transport: WattBoxTransport): WattBoxTransport {
    // Bridge out-of-band outlet updates into pub/sub so HomeKit reflects them immediately.
    transport.onOutletUpdate((outlet) => {
      this.cache.del(WattBox.OUTLET_STATUS_CACHE_KEY).catch(() => {
        // Best effort cache invalidation; the next poll refreshes regardless.
      });
      PubSub.publish(WattBox.outletStatusTopic(outlet.id), outlet);
    });
    return transport;
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
