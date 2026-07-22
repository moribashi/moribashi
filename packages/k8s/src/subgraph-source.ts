import type { SubgraphEndpoint } from './subgraph.domain.js';

export type SubgraphSourceEvent =
  | { type: 'ADD' | 'MODIFY'; endpoint: SubgraphEndpoint }
  | { type: 'DELETE'; name: string };

/**
 * Discovery backend for K8sSubgraphLocator. The MVP implementation
 * (LabeledServiceSource) watches labeled Services + EndpointSlices; a future
 * CRD-backed source can implement the same interface without any change to
 * the locator or its consumers.
 */
export interface SubgraphSource {
  list(): Promise<SubgraphEndpoint[]>;
  onChange(cb: (event: SubgraphSourceEvent) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
