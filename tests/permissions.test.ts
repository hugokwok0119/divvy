import { describe, it, expect } from 'vitest';
import { permissionsFor } from '../src/lib/permissions';

describe('permissionsFor', () => {
  it('grants every gated capability to an owner', () => {
    expect(permissionsFor('owner')).toEqual({
      canSettleCycle: true,
      canManageMembers: true,
      canManageCards: true,
      canManageCategories: true,
      canExportData: true,
    });
  });

  it('denies every gated capability to a member', () => {
    expect(permissionsFor('member')).toEqual({
      canSettleCycle: false,
      canManageMembers: false,
      canManageCards: false,
      canManageCategories: false,
      canExportData: false,
    });
  });
});
