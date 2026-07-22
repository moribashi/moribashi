import type { OnDestroy, OnInit } from '@moribashi/common';
import type { SubgraphEndpoint } from './subgraph.domain.js';
import type { SubgraphSource } from './subgraph-source.js';

export interface K8sSubgraphLocatorOptions {
  /** Coalesces bursty watch events (e.g. a rolling deploy) before notifying. Defaults to 250ms. */
  debounceMs?: number;
}

/**
 * Live, gateway-facing view of "which subgraphs currently exist and are
 * reachable." Backed by a pluggable SubgraphSource so the discovery mechanism
 * (labeled Services today, a CRD later) can change without touching this
 * class or anything that consumes it.
 */
export class K8sSubgraphLocator implements OnInit, OnDestroy {
  private readonly subgraphSource: SubgraphSource;
  private readonly debounceMs: number;
  private readonly endpoints = new Map<string, SubgraphEndpoint>();
  private readonly listeners = new Set<(all: SubgraphEndpoint[]) => void>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor({
    subgraphSource,
    k8sSubgraphLocatorOptions,
  }: {
    subgraphSource: SubgraphSource;
    k8sSubgraphLocatorOptions?: K8sSubgraphLocatorOptions;
  }) {
    this.subgraphSource = subgraphSource;
    this.debounceMs = k8sSubgraphLocatorOptions?.debounceMs ?? 250;
  }

  async onInit(): Promise<void> {
    this.subgraphSource.onChange((event) => {
      if (event.type === 'DELETE') this.endpoints.delete(event.name);
      else this.endpoints.set(event.endpoint.name, event.endpoint);
      this.scheduleNotify();
    });

    for (const endpoint of await this.subgraphSource.list()) {
      this.endpoints.set(endpoint.name, endpoint);
    }

    await this.subgraphSource.start();
  }

  async onDestroy(): Promise<void> {
    clearTimeout(this.debounceTimer);
    await this.subgraphSource.stop();
  }

  /** Ready subgraphs, live. */
  get all(): SubgraphEndpoint[] {
    return [...this.endpoints.values()].filter((e) => e.ready);
  }

  get(name: string): SubgraphEndpoint | undefined {
    const endpoint = this.endpoints.get(name);
    return endpoint?.ready ? endpoint : undefined;
  }

  /** Returns an unsubscribe function. Fires with the full ready set, debounced. */
  onChange(cb: (all: SubgraphEndpoint[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Resolves once `name` is registered and ready, or rejects on timeout. */
  waitFor(name: string, timeoutMs = 30_000): Promise<SubgraphEndpoint> {
    const existing = this.get(name);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for subgraph "${name}" after ${timeoutMs}ms`));
      }, timeoutMs);

      const unsubscribe = this.onChange((all) => {
        const found = all.find((e) => e.name === name);
        if (!found) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(found);
      });
    });
  }

  private scheduleNotify(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const snapshot = this.all;
      for (const cb of this.listeners) cb(snapshot);
    }, this.debounceMs);
  }
}
