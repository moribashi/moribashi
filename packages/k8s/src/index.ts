export type { PodEndpoint, SubgraphEndpoint } from './subgraph.domain.js';
export type { SubgraphSource, SubgraphSourceEvent } from './subgraph-source.js';
export {
  LabeledServiceSource,
  type LabeledServiceSourceOptions,
  buildUrl,
  isSliceReady,
  podsFromSlices,
  resolvePort,
  slicesForService,
} from './labeled-service.source.js';
export { K8sSubgraphLocator, type K8sSubgraphLocatorOptions } from './subgraph-locator.svc.js';
export { k8sSubgraphLocatorPlugin, type K8sSubgraphLocatorPluginOptions } from './plugin.js';

export function diagnostics(): any {
  return {
    module: '@moribashi/k8s',
  };
}
