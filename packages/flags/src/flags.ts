import type {
  Client,
  EvaluationContext,
  EvaluationDetails,
  JsonValue,
} from '@openfeature/server-sdk';

/**
 * Request-context-aware wrapper over the OpenFeature {@link Client}. Registered
 * as `flags` (SCOPED) so that, inside a web request, evaluations automatically
 * carry the per-request {@link EvaluationContext} enriched from the principal —
 * app code never threads context through call sites.
 *
 * Outside a request scope (CLI, worker, or the root container) it resolves
 * against the root-registered empty context, so the same API works everywhere.
 */
export class Flags {
  private readonly client: Client;
  private readonly context: EvaluationContext;

  constructor({
    featureClient,
    evaluationContext,
  }: {
    featureClient: Client;
    evaluationContext: EvaluationContext;
  }) {
    this.client = featureClient;
    this.context = evaluationContext;
  }

  /** The evaluation context these calls run with (empty outside a request). */
  get evaluationContext(): EvaluationContext {
    return this.context;
  }

  boolean(flagKey: string, defaultValue: boolean): Promise<boolean> {
    return this.client.getBooleanValue(flagKey, defaultValue, this.context);
  }

  string<T extends string = string>(flagKey: string, defaultValue: T): Promise<T> {
    return this.client.getStringValue(flagKey, defaultValue, this.context) as Promise<T>;
  }

  number<T extends number = number>(flagKey: string, defaultValue: T): Promise<T> {
    return this.client.getNumberValue(flagKey, defaultValue, this.context) as Promise<T>;
  }

  object<T extends JsonValue>(flagKey: string, defaultValue: T): Promise<T> {
    return this.client.getObjectValue<T>(flagKey, defaultValue, this.context);
  }

  // --- Detail variants (reason, variant, error metadata) ---

  booleanDetails(
    flagKey: string,
    defaultValue: boolean,
  ): Promise<EvaluationDetails<boolean>> {
    return this.client.getBooleanDetails(flagKey, defaultValue, this.context);
  }

  stringDetails<T extends string = string>(
    flagKey: string,
    defaultValue: T,
  ): Promise<EvaluationDetails<T>> {
    return this.client.getStringDetails(flagKey, defaultValue, this.context) as Promise<
      EvaluationDetails<T>
    >;
  }

  numberDetails<T extends number = number>(
    flagKey: string,
    defaultValue: T,
  ): Promise<EvaluationDetails<T>> {
    return this.client.getNumberDetails(flagKey, defaultValue, this.context) as Promise<
      EvaluationDetails<T>
    >;
  }

  objectDetails<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
  ): Promise<EvaluationDetails<T>> {
    return this.client.getObjectDetails<T>(flagKey, defaultValue, this.context);
  }
}
