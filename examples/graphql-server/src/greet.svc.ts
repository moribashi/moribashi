let nextInstanceId = 0;

/**
 * Trivial service demonstrating DI-resolved resolver dependencies.
 *
 * An `instanceId` is assigned on construction so tests can assert that two
 * concurrent GraphQL operations get distinct `GreetService` instances (i.e.
 * the service is SCOPED under `WEB_REQUEST_SCOPE`, not a singleton).
 */
export default class GreetService {
  readonly instanceId: number;

  constructor() {
    this.instanceId = ++nextInstanceId;
  }

  hello(name: string): string {
    return `Hello, ${name}!`;
  }
}
