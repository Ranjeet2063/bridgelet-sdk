import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Account } from '../../accounts/entities/account.entity.js';

@Entity('claims')
export class Claim {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index('IDX_claims_accountId')
  accountId: string;

  /**
   * `onDelete: 'CASCADE'` only fires on a hard DELETE of the account row.
   * `accounts` soft-delete (`deletedAt`) sets a flag and never removes the row,
   * so claims survive soft-deletion and remain queryable. Documented under
   * "Foreign Key Cascade Behavior" in docs/database-schema.md.
   *
   * Verified for #706 (duplicate of the already-resolved #645, fixed in PR #772).
   */
  @ManyToOne(() => Account, { eager: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'accountId',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'FK_claims_accountId',
  })
  account: Account;

  @Column({ type: 'varchar', length: 56 })
  destinationAddress: string;

  @Column({ type: 'varchar', length: 64 })
  sweepTxHash: string;

  @Column({ type: 'varchar', length: 100 })
  amountSwept: string;

  @Column({ type: 'varchar', length: 100 })
  asset: string;

  @Column({ type: 'timestamp' })
  claimedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
