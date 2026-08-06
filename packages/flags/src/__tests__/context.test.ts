import { describe, expect, it } from 'vitest';
import { defaultContextFrom } from '../context.js';

describe('defaultContextFrom', () => {
  it('maps identity to targetingKey and carries tid/type', () => {
    expect(defaultContextFrom({ identity: 'user-1', tid: 7, type: 'USER' })).toEqual({
      targetingKey: 'user-1',
      tid: 7,
      type: 'USER',
    });
  });

  it('omits absent optional attributes', () => {
    expect(defaultContextFrom({ identity: 'user-1' })).toEqual({ targetingKey: 'user-1' });
  });

  it('yields an empty context for anonymous/absent principals', () => {
    expect(defaultContextFrom(undefined)).toEqual({});
    expect(defaultContextFrom(null)).toEqual({});
    expect(defaultContextFrom({})).toEqual({});
  });
});
