import { registerAs } from '@nestjs/config';

export default registerAs('stellar', () => ({
  network: getNetwork(),
  horizonUrl:
    process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl:
    process.env.STELLAR_SOROBAN_RPC_URL ||
    'https://soroban-testnet.stellar.org',
  fundingSecret: process.env.FUNDING_ACCOUNT_SECRET,
  recoveryPublic: process.env.RECOVERY_ACCOUNT_PUBLIC,
  contracts: {
    ephemeralAccount: process.env.EPHEMERAL_ACCOUNT_CONTRACT_ID,
    sweepController: process.env.SWEEP_CONTROLLER_CONTRACT_ID,
    // #648: version of the deployed ephemeral-account contract. Left
    // undefined when unknown so ContractProvider reports 'unknown' rather
    // than a stale literal that silently drifts from the deployed WASM.
    ephemeralAccountVersion: process.env.EPHEMERAL_ACCOUNT_CONTRACT_VERSION,
  },
  sweepSigningKeySeed: process.env.SWEEP_SIGNING_KEY_SEED,
  encryptionKey: process.env.ENCRYPTION_KEY || '64_char_hex_string_here',
  sweepControllerContractId: process.env.SWEEP_CONTROLLER_CONTRACT_ID,
}));

function getNetwork(): 'mainnet' | 'testnet' {
  const network = process.env.STELLAR_NETWORK || 'testnet';
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error(
      `Invalid STELLAR_NETWORK "${network}". Expected "mainnet" or "testnet".`,
    );
  }
  return network;
}
