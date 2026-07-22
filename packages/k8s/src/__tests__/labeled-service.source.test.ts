import { describe, it, expect } from 'vitest';
import type { V1EndpointSlice, V1Service } from '@kubernetes/client-node';
import { buildUrl, isSliceReady, podsFromSlices, resolvePort, slicesForService } from '../index.js';

function service(ports: Array<{ name?: string; port: number }>): V1Service {
  return { spec: { ports } } as V1Service;
}

function slice(serviceName: string, endpoints: V1EndpointSlice['endpoints']): V1EndpointSlice {
  return {
    addressType: 'IPv4',
    metadata: { labels: { 'kubernetes.io/service-name': serviceName } },
    endpoints,
  } as V1EndpointSlice;
}

describe('resolvePort', () => {
  it('returns the only port when none is named', () => {
    expect(resolvePort(service([{ port: 4000 }]))).toBe(4000);
  });

  it('picks the port matching portName', () => {
    const svc = service([
      { name: 'metrics', port: 9000 },
      { name: 'graphql', port: 4000 },
    ]);
    expect(resolvePort(svc, 'graphql')).toBe(4000);
  });

  it('falls back to the first port if portName is not found', () => {
    const svc = service([{ name: 'metrics', port: 9000 }]);
    expect(resolvePort(svc, 'graphql')).toBe(9000);
  });

  it('returns undefined when there are no ports', () => {
    expect(resolvePort(service([]))).toBeUndefined();
  });
});

describe('buildUrl', () => {
  it('builds a cluster-local URL with the given port and path', () => {
    expect(buildUrl('books', 'catalog', 4000, '/graphql')).toBe('http://books.catalog.svc.cluster.local:4000/graphql');
  });

  it('omits the port suffix when no port is resolved', () => {
    expect(buildUrl('books', 'catalog', undefined, '/graphql')).toBe('http://books.catalog.svc.cluster.local/graphql');
  });
});

describe('isSliceReady', () => {
  it('is ready when at least one endpoint has no explicit not-ready condition', () => {
    expect(isSliceReady(slice('books', [{ addresses: ['10.0.0.1'], conditions: { ready: true } }]))).toBe(true);
  });

  it('treats an absent ready condition as ready', () => {
    expect(isSliceReady(slice('books', [{ addresses: ['10.0.0.1'] }]))).toBe(true);
  });

  it('is not ready when every endpoint is explicitly not-ready', () => {
    expect(isSliceReady(slice('books', [{ addresses: ['10.0.0.1'], conditions: { ready: false } }]))).toBe(false);
  });
});

describe('slicesForService', () => {
  it('filters slices by the kubernetes.io/service-name label', () => {
    const slices = [slice('books', []), slice('reviews', [])];
    expect(slicesForService(slices, 'books')).toEqual([slices[0]]);
  });
});

describe('podsFromSlices', () => {
  it('flattens endpoints across slices into pod entries', () => {
    const slices = [
      slice('books', [{ addresses: ['10.0.0.1'], targetRef: { name: 'books-abc' }, nodeName: 'node-1', conditions: { ready: true } }]),
    ];
    expect(podsFromSlices(slices)).toEqual([{ name: 'books-abc', ip: '10.0.0.1', ready: true, node: 'node-1' }]);
  });

  it('falls back to the address as the name when targetRef is absent', () => {
    const slices = [slice('books', [{ addresses: ['10.0.0.1'], conditions: { ready: false } }])];
    expect(podsFromSlices(slices)).toEqual([{ name: '10.0.0.1', ip: '10.0.0.1', ready: false, node: undefined }]);
  });
});
