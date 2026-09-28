import { ClaimVerificationResponseDto } from './claim-verification-response.dto.js';

// Defense-in-depth: pins the serialized key set for ClaimVerificationResponseDto
// so a future field added to the underlying claim/account entity can't silently
// leak (e.g. a raw token or secret) through this API response shape.
// Verified for #705 (duplicate of the already-resolved #644, fixed in PR #772).
describe('ClaimVerificationResponseDto', () => {
  it('only exposes the expected, allow-listed keys', () => {
    const dto = new ClaimVerificationResponseDto();
    dto.valid = true;
    dto.accountId = '4ebae33b-5b93-424c-858d-d79afc708af5';
    dto.amount = '100.0000000';
    dto.asset = 'native';
    dto.expiresAt = new Date('2026-02-21T10:30:00Z');

    const allowedKeys = ['valid', 'accountId', 'amount', 'asset', 'expiresAt'];
    const actualKeys = Object.keys(dto);

    expect(actualKeys.sort()).toEqual([...allowedKeys].sort());
    expect(actualKeys).not.toContain('secret');
    expect(actualKeys).not.toContain('token');
    expect(actualKeys).not.toContain('claimToken');
  });
});
