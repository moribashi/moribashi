import { readFileSync } from 'node:fs';
import { KubeConfig } from '@kubernetes/client-node';
import { asFunction, asValue, Lifetime, type MoribashiApp, type MoribashiPlugin } from '@moribashi/core';
import { LabeledServiceSource, type LabeledServiceSourceOptions } from './labeled-service.source.js';
import { K8sSubgraphLocator, type K8sSubgraphLocatorOptions } from './subgraph-locator.svc.js';

const IN_CLUSTER_NAMESPACE_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

function defaultNamespace(): string {
  try {
    return readFileSync(IN_CLUSTER_NAMESPACE_FILE, 'utf8').trim();
  } catch {
    return 'default';
  }
}

function defaultKubeConfig(): KubeConfig {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromDefault();
  return kubeConfig;
}

export interface K8sSubgraphLocatorPluginOptions
  extends Omit<LabeledServiceSourceOptions, 'kubeConfig' | 'namespace'>,
    K8sSubgraphLocatorOptions {
  kubeConfig?: KubeConfig;
  /** Defaults to the in-cluster Service Account namespace, or 'default' outside a cluster. */
  namespace?: string;
}

/**
 * Registers `subgraphSource` and `k8sSubgraphLocator` as singletons. The
 * locator's `onInit`/`onDestroy` (called automatically by app.start()/stop())
 * drive the underlying watch's lifecycle.
 */
export function k8sSubgraphLocatorPlugin(opts: K8sSubgraphLocatorPluginOptions = {}): MoribashiPlugin {
  const { kubeConfig, namespace, labelSelector, portName, path, trackPods, debounceMs } = opts;

  return {
    name: '@moribashi/k8s',
    register(app: MoribashiApp) {
      const source = new LabeledServiceSource({
        kubeConfig: kubeConfig ?? defaultKubeConfig(),
        namespace: namespace ?? defaultNamespace(),
        labelSelector,
        portName,
        path,
        trackPods,
      });

      app.container.register({
        subgraphSource: asValue(source),
        k8sSubgraphLocator: asFunction(
          (cradle: { subgraphSource: LabeledServiceSource }) =>
            new K8sSubgraphLocator({
              subgraphSource: cradle.subgraphSource,
              k8sSubgraphLocatorOptions: { debounceMs },
            }),
        ).setLifetime(Lifetime.SINGLETON),
      });
    },
  };
}
