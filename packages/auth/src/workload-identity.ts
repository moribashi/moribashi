import { readFile } from 'node:fs/promises';
import { asValue, type MoribashiApp, type MoribashiPlugin } from '@moribashi/core';

/**
 * Singleton provider of an IdP-issued access token for outbound
 * service-to-service calls. Registered as `serviceToken` in the container.
 */
export interface ServiceToken {
  /** A currently-valid access token, refreshed ahead of expiry. */
  get(): Promise<string>;
}

export interface WorkloadIdentityOptions {
  /** The IdP's OAuth token endpoint (must support RFC 8693 token exchange). */
  tokenEndpoint: string;
  /** Path to the projected ServiceAccount token file (kubelet rotates it). */
  subjectTokenPath: string;
  /** `audience` parameter for the exchange — the resource the token is for. */
  audience: string;
  /** OAuth client_id, when the IdP requires one for the exchange. */
  clientId?: string;
  /** Refresh this long before expiry, in ms. Default 60_000. */
  refreshSkewMs?: number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';
const REQUESTED_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

export class ServiceTokenProvider implements ServiceToken {
  private readonly opts: WorkloadIdentityOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;

  private cached?: { token: string; expiresAt: number };
  private inflight?: Promise<string>;

  constructor(opts: WorkloadIdentityOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.refreshSkewMs = opts.refreshSkewMs ?? 60_000;
  }

  async get(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.refreshSkewMs > this.now()) {
      return this.cached.token;
    }
    // Coalesce concurrent refreshes; drop the inflight marker on failure so
    // the next call retries.
    this.inflight ??= this.exchange().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async exchange(): Promise<string> {
    // Re-read the projected file every exchange — the kubelet rotates it.
    const subjectToken = (await readFile(this.opts.subjectTokenPath, 'utf8')).trim();

    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      subject_token: subjectToken,
      subject_token_type: SUBJECT_TOKEN_TYPE,
      requested_token_type: REQUESTED_TOKEN_TYPE,
      audience: this.opts.audience,
    });
    if (this.opts.clientId) {
      body.set('client_id', this.opts.clientId);
    }

    const res = await this.fetchImpl(this.opts.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Token exchange failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
      );
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error('Token exchange response contained no access_token');
    }

    const expiresInMs = (json.expires_in ?? 300) * 1000;
    this.cached = { token: json.access_token, expiresAt: this.now() + expiresInMs };
    return json.access_token;
  }
}

/**
 * Outbound workload identity for services on Kubernetes: exchanges the pod's
 * projected ServiceAccount token for an IdP-issued access token via RFC 8693,
 * with no deployed secrets — the ServiceAccount *is* the credential. The IdP
 * must trust the cluster's OIDC issuer.
 *
 * Independent of `authPlugin`; needs no web server.
 */
export function workloadIdentityPlugin(opts: WorkloadIdentityOptions): MoribashiPlugin {
  return {
    name: '@moribashi/auth/workload-identity',
    register(app: MoribashiApp) {
      app.container.register({
        serviceToken: asValue(new ServiceTokenProvider(opts)),
      });
    },
  };
}
