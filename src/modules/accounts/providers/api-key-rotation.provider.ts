import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';

interface ApiKeyRecord {
  key: string;
  integratorId: string;
  revoked: boolean;
}

/**
 * Self-service API key rotation/revocation, keyed by integrator.
 * Revocation is immediate: `isActive` reads the same in-memory record used
 * to issue the key, so there is no caching delay.
 */
@Injectable()
export class ApiKeyRotationProvider {
  private readonly logger = new Logger(ApiKeyRotationProvider.name);
  private readonly keysByIntegrator = new Map<string, ApiKeyRecord>();

  rotate(integratorId: string): string {
    const newKey = crypto.randomBytes(32).toString('hex');
    this.keysByIntegrator.set(integratorId, {
      key: newKey,
      integratorId,
      revoked: false,
    });
    this.logger.log(`API key rotated for integrator ${integratorId}`);
    return newKey;
  }

  revoke(integratorId: string): void {
    const record = this.keysByIntegrator.get(integratorId);
    if (!record) {
      throw new UnauthorizedException('No active key for integrator');
    }
    record.revoked = true;
    this.logger.log(`API key revoked for integrator ${integratorId}`);
  }

  isActive(integratorId: string, key: string): boolean {
    const record = this.keysByIntegrator.get(integratorId);
    return !!record && !record.revoked && record.key === key;
  }
}
