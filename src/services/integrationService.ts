import type { SecretBox } from '../crypto/secretBox';
import type { Integration } from '../domain';
import { Errors } from '../errors';
import { ProviderError, type ProviderClient, type ProviderClientFactory, type ProviderCredentials } from '../provider/types';
import type { IntegrationRepository } from '../repositories/types';
import type { InFlightSends } from './inFlightSends';

export interface IntegrationView {
  status: 'connected' | 'disconnected' | 'not_configured';
  /** Degraded when connected but the last provider call failed. */
  health: 'ok' | 'degraded' | null;
  accountSid: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  lastSyncAt: Date | null;
  lastError: string | null;
}

export interface ActiveIntegration {
  integration: Integration;
  client: ProviderClient;
}

/** Shows only the last four characters, e.g. `AC••••••1234`. */
export function maskSid(sid: string): string {
  return sid.length <= 6 ? '••••' : `${sid.slice(0, 2)}••••••${sid.slice(-4)}`;
}

export function toView(integration: Integration | null): IntegrationView {
  if (!integration) {
    return {
      status: 'not_configured',
      health: null,
      accountSid: null,
      connectedAt: null,
      disconnectedAt: null,
      lastSyncAt: null,
      lastError: null,
    };
  }
  return {
    status: integration.status,
    health: integration.status === 'connected' ? (integration.lastError ? 'degraded' : 'ok') : null,
    accountSid: maskSid(integration.accountSid),
    connectedAt: integration.connectedAt,
    disconnectedAt: integration.disconnectedAt,
    lastSyncAt: integration.lastSyncAt,
    lastError: integration.lastError,
  };
}

export interface IntegrationServiceDeps {
  integrations: IntegrationRepository;
  providerFactory: ProviderClientFactory;
  secretBox: SecretBox;
  sends: InFlightSends;
  now?: () => Date;
}

export class IntegrationService {
  private readonly now: () => Date;

  constructor(private readonly deps: IntegrationServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** OP-001. Verifies the credentials with the provider before storing them; replaces any active integration. */
  async connect(credentials: ProviderCredentials): Promise<IntegrationView> {
    try {
      await this.deps.providerFactory(credentials).verify();
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'unauthorized') throw Errors.invalidProviderCredentials();
      throw Errors.providerUnavailable((err as Error).message);
    }

    this.deps.sends.abortAll();
    const integration = await this.deps.integrations.activate(
      {
        accountSid: credentials.accountSid,
        credentialsCiphertext: this.deps.secretBox.seal(JSON.stringify(credentials)),
      },
      this.now(),
    );
    return toView(integration);
  }

  /** OP-002. Idempotent: disconnecting when nothing is connected returns the current status. */
  async disconnect(): Promise<{ integration: IntegrationView; cancelledSends: number }> {
    const active = await this.deps.integrations.findActive();
    const cancelledSends = this.deps.sends.abortAll();
    if (active) await this.deps.integrations.deactivate(active.id, this.now());
    return { integration: toView(await this.deps.integrations.findLatest()), cancelledSends };
  }

  /** OP-003 */
  async status(): Promise<IntegrationView> {
    return toView(await this.deps.integrations.findLatest());
  }

  /** The provider client for the active integration, or null if disconnected. */
  async active(): Promise<ActiveIntegration | null> {
    const integration = await this.deps.integrations.findActive();
    if (!integration) return null;
    const credentials = JSON.parse(this.deps.secretBox.open(integration.credentialsCiphertext)) as ProviderCredentials;
    return { integration, client: this.deps.providerFactory(credentials) };
  }

  async recordSync(integrationId: string, result: { at: Date } | { error: string }): Promise<void> {
    await this.deps.integrations.recordSync(integrationId, result);
  }
}
