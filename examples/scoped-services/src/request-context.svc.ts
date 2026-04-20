import { randomUUID } from 'node:crypto';

export default class RequestContext {
  readonly id: string;

  constructor() {
    this.id = randomUUID();
  }
}
