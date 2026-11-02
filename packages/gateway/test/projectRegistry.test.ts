import { describe, expect, it } from 'vitest';

import { parseRegistryRecord } from '../src/registry/projectRegistry.js';

const validRecord = {
  id: 'codex-lens',
  displayName: 'Codex Lens',
  path: '/tmp/codex-lens',
  allowedCommands: ['npm test'],
  allowWorkspaceWrite: true,
  allowDependencyInstall: false,
  allowCommit: false,
  allowPush: false,
  allowDeploy: false,
};

describe('parseRegistryRecord', () => {
  it('returns a successful Result for a valid registry record', () => {
    const result = parseRegistryRecord(validRecord);

    expect(result).toEqual({ ok: true, value: validRecord });
  });

  it('returns a DomainError instead of throwing for invalid input', () => {
    expect(() =>
      parseRegistryRecord({ ...validRecord, allowPush: 'yes' }),
    ).not.toThrow();

    const result = parseRegistryRecord({ ...validRecord, allowPush: 'yes' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_REGISTRY_RECORD');
    }
  });
});
