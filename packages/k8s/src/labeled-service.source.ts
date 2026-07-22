import {
  CoreV1Api,
  DiscoveryV1Api,
  makeInformer,
  type Informer,
  type ObjectCache,
  type KubeConfig,
  type V1Service,
  type V1EndpointSlice,
} from '@kubernetes/client-node';
import type { PodEndpoint, SubgraphEndpoint } from './subgraph.domain.js';
import type { SubgraphSource, SubgraphSourceEvent } from './subgraph-source.js';

const SERVICE_NAME_LABEL = 'kubernetes.io/service-name';

export interface LabeledServiceSourceOptions {
  kubeConfig: KubeConfig;
  namespace: string;
  /** Defaults to 'moribashi.io/role=subgraph'. */
  labelSelector?: string;
  /** Named Service port to use. Falls back to the first port if omitted. */
  portName?: string;
  /** Defaults to '/graphql'. */
  path?: string;
  /** Populate SubgraphEndpoint.pods. No extra API calls — EndpointSlices are already watched for readiness. */
  trackPods?: boolean;
}

export function resolvePort(svc: V1Service, portName?: string): number | undefined {
  const ports = svc.spec?.ports ?? [];
  if (ports.length === 0) return undefined;
  if (portName) return (ports.find((p) => p.name === portName) ?? ports[0])?.port;
  return ports[0]?.port;
}

export function buildUrl(name: string, namespace: string, port: number | undefined, path: string): string {
  const portSuffix = port !== undefined ? `:${port}` : '';
  return `http://${name}.${namespace}.svc.cluster.local${portSuffix}${path}`;
}

export function isSliceReady(slice: V1EndpointSlice): boolean {
  return slice.endpoints.some((ep) => ep.conditions?.ready !== false);
}

export function slicesForService(slices: readonly V1EndpointSlice[], serviceName: string): V1EndpointSlice[] {
  return slices.filter((s) => s.metadata?.labels?.[SERVICE_NAME_LABEL] === serviceName);
}

export function podsFromSlices(slices: readonly V1EndpointSlice[]): PodEndpoint[] {
  const pods: PodEndpoint[] = [];
  for (const slice of slices) {
    for (const ep of slice.endpoints) {
      pods.push({
        name: ep.targetRef?.name ?? ep.addresses[0] ?? 'unknown',
        ip: ep.addresses[0] ?? '',
        ready: ep.conditions?.ready !== false,
        node: ep.nodeName,
      });
    }
  }
  return pods;
}

/**
 * MVP SubgraphSource: watches Services carrying `labelSelector` for the subgraph
 * roster, and all EndpointSlices in the namespace for readiness (EndpointSlices
 * only carry a `kubernetes.io/service-name` label, not the Service's own labels,
 * so they can't be label-filtered the same way — this joins them locally instead,
 * the same way kube-proxy's own reflector does).
 */
export class LabeledServiceSource implements SubgraphSource {
  private readonly namespace: string;
  private readonly portName: string | undefined;
  private readonly path: string;
  private readonly trackPods: boolean;
  private readonly serviceInformer: Informer<V1Service> & ObjectCache<V1Service>;
  private readonly sliceInformer: Informer<V1EndpointSlice> & ObjectCache<V1EndpointSlice>;
  private readonly listeners = new Set<(event: SubgraphSourceEvent) => void>();

  constructor(options: LabeledServiceSourceOptions) {
    const { kubeConfig, namespace, labelSelector = 'moribashi.io/role=subgraph' } = options;
    this.namespace = namespace;
    this.portName = options.portName;
    this.path = options.path ?? '/graphql';
    this.trackPods = options.trackPods ?? false;

    const coreApi = kubeConfig.makeApiClient(CoreV1Api);
    const discoveryApi = kubeConfig.makeApiClient(DiscoveryV1Api);

    this.serviceInformer = makeInformer(
      kubeConfig,
      `/api/v1/namespaces/${namespace}/services`,
      () => coreApi.listNamespacedService({ namespace, labelSelector }),
      labelSelector,
    );

    this.sliceInformer = makeInformer(kubeConfig, `/apis/discovery.k8s.io/v1/namespaces/${namespace}/endpointslices`, () =>
      discoveryApi.listNamespacedEndpointSlice({ namespace }),
    );

    this.serviceInformer.on('add', (svc) => this.emitFromService(svc));
    this.serviceInformer.on('update', (svc) => this.emitFromService(svc));
    this.serviceInformer.on('delete', (svc) => this.emitDelete(svc));

    // A slice-only change (pod rollout) can flip readiness without the Service object changing.
    this.sliceInformer.on('add', (slice) => this.emitFromSlice(slice));
    this.sliceInformer.on('update', (slice) => this.emitFromSlice(slice));
    this.sliceInformer.on('delete', (slice) => this.emitFromSlice(slice));
  }

  async list(): Promise<SubgraphEndpoint[]> {
    return this.serviceInformer.list().map((svc) => this.toEndpoint(svc));
  }

  onChange(cb: (event: SubgraphSourceEvent) => void): void {
    this.listeners.add(cb);
  }

  async start(): Promise<void> {
    await Promise.all([this.serviceInformer.start(), this.sliceInformer.start()]);
  }

  async stop(): Promise<void> {
    await Promise.all([this.serviceInformer.stop(), this.sliceInformer.stop()]);
  }

  private emitFromService(svc: V1Service): void {
    if (!svc.metadata?.name) return;
    this.notify({ type: 'ADD', endpoint: this.toEndpoint(svc) });
  }

  private emitDelete(svc: V1Service): void {
    const name = svc.metadata?.name;
    if (!name) return;
    this.notify({ type: 'DELETE', name });
  }

  private emitFromSlice(slice: V1EndpointSlice): void {
    const serviceName = slice.metadata?.labels?.[SERVICE_NAME_LABEL];
    if (!serviceName) return;
    const svc = this.serviceInformer.get(serviceName, this.namespace);
    if (!svc) return; // slice belongs to a Service we're not tracking (unlabeled)
    this.notify({ type: 'MODIFY', endpoint: this.toEndpoint(svc) });
  }

  private notify(event: SubgraphSourceEvent): void {
    for (const cb of this.listeners) cb(event);
  }

  private toEndpoint(svc: V1Service): SubgraphEndpoint {
    const name = svc.metadata!.name!;
    const namespace = svc.metadata?.namespace ?? this.namespace;
    const slices = slicesForService(this.sliceInformer.list(), name);
    const port = resolvePort(svc, this.portName);

    return {
      name,
      namespace,
      url: buildUrl(name, namespace, port, this.path),
      ready: slices.some(isSliceReady),
      labels: svc.metadata?.labels ?? {},
      ...(this.trackPods ? { pods: podsFromSlices(slices) } : {}),
    };
  }
}
