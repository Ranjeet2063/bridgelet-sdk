import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';
import { AccountStatus } from '../enums/account-status.enum.js';

/**
 * Composite indexes mirror the indexes created in migration
 * 1718100006000-AddHighTrafficIndexes.  They cover the two
 * high-traffic scheduler queries:
 *
 *   • Expiry job   – WHERE status IN (…) AND expiresAt < NOW()
 *   • Init cleanup – WHERE status = 'initializing' AND createdAt < <cutoff>
 *
 * Keeping the decorators here ensures TypeORM's schema-sync check
 * (used in the integration test) stays green after the migration runs.
 */
@Index('IDX_accounts_status_expiresAt', ['status', 'expiresAt'])
@Index('IDX_accounts_status_createdAt', ['status', 'createdAt'])
@Index('IDX_accounts_createdAt', ['createdAt'])
@Index('IDX_accounts_deletedAt', ['deletedAt'])
@Entity('accounts')
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 56, unique: true })
  @Index('IDX_accounts_publicKey')
  publicKey: string;

  @Column({ type: 'varchar', length: 56, nullable: true })
  @Index('IDX_accounts_contractId')
  contractId: string | null;

  @Column({ type: 'text' })
  secretKeyEncrypted: string;

  @Column({ type: 'varchar', length: 56 })
  fundingSource: string;

  @Column({ type: 'decimal', precision: 18, scale: 7 })
  amount: string;

  @Column({ type: 'varchar', length: 100 })
  asset: string;

  @Column({
    type: 'enum',
    enum: AccountStatus,
    enumName: 'account_status_enum',
    default: AccountStatus.PENDING_PAYMENT,
  })
  @Index('IDX_accounts_status')
  status: AccountStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  @Index('IDX_accounts_claimTokenHash')
  claimTokenHash: string;

  @Column({ type: 'varchar', length: 56, nullable: true })
  destinationAddress: string;

  @Column({ type: 'timestamp' })
  @Index('IDX_accounts_expiresAt')
  expiresAt: Date; // Scheduled expiry time - set on creation, used by the expiry scheduler

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  claimedAt: Date | null;

  // Then wherever your expiry flow sets account status to EXPIRED (likely in the sweeps or a scheduler module once built), ensure this is also set:
  // account.status = AccountStatus.EXPIRED;
  // account.expiredAt = new Date();
  // await this.accountsRepository.save(account);
  @Column({ type: 'timestamp', nullable: true })
  expiredAt: Date | null; // Actual time expiry was processed - set by the expiry handler, null until then

  /**
   * Metadata is bounded integration context returned with the account and
   * merged for lifecycle diagnostics. It is not a query surface, so no GIN
   * index is maintained for it.
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @DeleteDateColumn({ type: 'timestamp', nullable: true })
  deletedAt: Date | null;
}
