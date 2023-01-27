import { BN } from "@project-serum/anchor";
import { PublicKey } from "@solana/web3.js";

/**
 * Program ID hosting Orca's Whirlpool program.
 * @category Constants
 */
export const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey(
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
);

/**
 * Orca's WhirlpoolsConfig PublicKey.
 * @category Constants
 */
export const ORCA_WHIRLPOOLS_CONFIG = new PublicKey("2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ");

export const ORCA_SUPPORTED_TICK_SPACINGS = [1, 8, 64, 128];

export const TOKEN_MINTS = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  SOL: "So11111111111111111111111111111111111111112",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  USDH: "USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX",
  mSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  stSOL: "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj",
};

/**
 * The number of rewards supported by this whirlpool.
 * @category Constants
 */
export const NUM_REWARDS = 3;

/**
 * The maximum tick index supported by the Whirlpool program.
 * @category Constants
 */
export const MAX_TICK_INDEX = 443636;

/**
 * The minimum tick index supported by the Whirlpool program.
 * @category Constants
 */
export const MIN_TICK_INDEX = -443636;

/**
 * The maximum sqrt-price supported by the Whirlpool program.
 * @category Constants
 */
export const MAX_SQRT_PRICE = "79226673515401279992447579055";

/**
 * The minimum sqrt-price supported by the Whirlpool program.
 * @category Constants
 */
export const MIN_SQRT_PRICE = "4295048016";

/**
 * The number of initialized ticks that a tick-array account can hold.
 * @category Constants
 */
export const TICK_ARRAY_SIZE = 88;

/**
 * @category Constants
 */
export const METADATA_PROGRAM_ADDRESS = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

/**
 * The maximum number of tick-arrays that can traversed across in a swap.
 * @category Constants
 */
export const MAX_SWAP_TICK_ARRAYS = 3;

/**
 * The denominator which the protocol fee rate is divided on.
 * @category Constants
 */
export const PROTOCOL_FEE_RATE_MUL_VALUE = new BN(10_000);

/**
 * The denominator which the fee rate is divided on.
 * @category Constants
 */
export const FEE_RATE_MUL_VALUE = new BN(1_000_000);
