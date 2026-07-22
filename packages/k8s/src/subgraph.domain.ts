export interface PodEndpoint {
  name: string;
  ip: string;
  ready: boolean;
  node?: string;
}

export interface SubgraphEndpoint {
  /** Logical subgraph name — the Service name. */
  name: string;
  /** Ready-to-introspect URL the gateway can hand to its federation client. */
  url: string;
  namespace: string;
  /** True once the Service has at least one ready backing endpoint. */
  ready: boolean;
  labels: Record<string, string>;
  /** Only populated when the source is configured with trackPods. */
  pods?: PodEndpoint[];
}
