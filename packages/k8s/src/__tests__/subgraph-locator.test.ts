import { describe, it, expect, vi } from 'vitest';
import { K8sSubgraphLocator, type SubgraphEndpoint, type SubgraphSource, type SubgraphSourceEvent } from '../index.js';

function endpoint(name: string, ready = true): SubgraphEndpoint {
  return { name, ready, namespace: 'default', url: `http://${name}/graphql`, labels: {} };
}

class FakeSource implements SubgraphSource {
  private listeners = new Set<(event: SubgraphSourceEvent) => void>();
  initial: SubgraphEndpoint[] = [];
  started = false;
  stopped = false;

  async list() {
    return this.initial;
  }

  onChange(cb: (event: SubgraphSourceEvent) => void) {
    this.listeners.add(cb);
  }

  async start() {
    this.started = true;
  }

  async stop() {
    this.stopped = true;
  }

  emit(event: SubgraphSourceEvent) {
    for (const cb of this.listeners) cb(event);
  }
}

describe('K8sSubgraphLocator', () => {
  it('exposes the initial list from the source after onInit', async () => {
    const source = new FakeSource();
    source.initial = [endpoint('books')];
    const locator = new K8sSubgraphLocator({ subgraphSource: source });

    await locator.onInit();

    expect(locator.all).toEqual([endpoint('books')]);
    expect(locator.get('books')).toEqual(endpoint('books'));
    expect(source.started).toBe(true);
  });

  it('excludes not-ready endpoints from .all and .get', async () => {
    const source = new FakeSource();
    source.initial = [endpoint('books', true), endpoint('reviews', false)];
    const locator = new K8sSubgraphLocator({ subgraphSource: source });

    await locator.onInit();

    expect(locator.all.map((e) => e.name)).toEqual(['books']);
    expect(locator.get('reviews')).toBeUndefined();
  });

  it('applies ADD/MODIFY/DELETE events from the source', async () => {
    const source = new FakeSource();
    const locator = new K8sSubgraphLocator({ subgraphSource: source, k8sSubgraphLocatorOptions: { debounceMs: 5 } });
    await locator.onInit();

    source.emit({ type: 'ADD', endpoint: endpoint('books') });
    expect(locator.get('books')).toEqual(endpoint('books'));

    source.emit({ type: 'DELETE', name: 'books' });
    expect(locator.get('books')).toBeUndefined();
  });

  it('debounces onChange notifications for bursty events', async () => {
    vi.useFakeTimers();
    try {
      const source = new FakeSource();
      const locator = new K8sSubgraphLocator({ subgraphSource: source, k8sSubgraphLocatorOptions: { debounceMs: 100 } });
      await locator.onInit();

      const cb = vi.fn();
      locator.onChange(cb);

      source.emit({ type: 'ADD', endpoint: endpoint('books') });
      source.emit({ type: 'ADD', endpoint: endpoint('reviews') });
      source.emit({ type: 'ADD', endpoint: endpoint('accounts') });

      expect(cb).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].map((e: SubgraphEndpoint) => e.name).sort()).toEqual(['accounts', 'books', 'reviews']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('onChange returns an unsubscribe function', async () => {
    vi.useFakeTimers();
    try {
      const source = new FakeSource();
      const locator = new K8sSubgraphLocator({ subgraphSource: source, k8sSubgraphLocatorOptions: { debounceMs: 10 } });
      await locator.onInit();

      const cb = vi.fn();
      const unsubscribe = locator.onChange(cb);
      unsubscribe();

      source.emit({ type: 'ADD', endpoint: endpoint('books') });
      await vi.advanceTimersByTimeAsync(10);

      expect(cb).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitFor resolves immediately if already ready', async () => {
    const source = new FakeSource();
    source.initial = [endpoint('books')];
    const locator = new K8sSubgraphLocator({ subgraphSource: source });
    await locator.onInit();

    await expect(locator.waitFor('books', 10)).resolves.toEqual(endpoint('books'));
  });

  it('waitFor resolves once the subgraph becomes ready', async () => {
    const source = new FakeSource();
    const locator = new K8sSubgraphLocator({ subgraphSource: source, k8sSubgraphLocatorOptions: { debounceMs: 5 } });
    await locator.onInit();

    const promise = locator.waitFor('books', 1000);
    source.emit({ type: 'ADD', endpoint: endpoint('books') });

    await expect(promise).resolves.toEqual(endpoint('books'));
  });

  it('waitFor rejects on timeout', async () => {
    const source = new FakeSource();
    const locator = new K8sSubgraphLocator({ subgraphSource: source });
    await locator.onInit();

    await expect(locator.waitFor('missing', 10)).rejects.toThrow(/Timed out/);
  });

  it('onDestroy stops the underlying source', async () => {
    const source = new FakeSource();
    const locator = new K8sSubgraphLocator({ subgraphSource: source });
    await locator.onInit();

    await locator.onDestroy();

    expect(source.stopped).toBe(true);
  });
});
