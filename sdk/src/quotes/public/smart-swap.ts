import { AddressUtil, Percentage } from "@orca-so/common-sdk";
import { Address, BN } from "@project-serum/anchor";
import { u64 } from "@solana/spl-token";
import { AccountFetcher, SwapUtils } from "../..";
import { SwapErrorCode } from "../../errors/errors";
import { batchBuildSwapQuoteParams } from "../smart-swap/batch-swap-quotes";
import { getRankedRoutes, getRouteCompareFn } from "../smart-swap/rank-route-sets";
import { InternalRouteQuote } from "../smart-swap/types";
import { getRouteId, PoolWalks, TokenPairPool } from "./pool-graph";
import { BestRoutesResult, RouteQueryError, RouteQuote } from "./smart-swap-types";
import { SwapQuoteParam, swapQuoteWithParams } from "./swap-quote";

export interface RoutingOptions {
  /**
   * Allowed % increment for route, i.e. 10%, 20%, etc
   */
  percentIncrement: number;

  /**
   * Number of routes to return from the calculated routes
   */
  numTopRoutes: number;

  /**
   * Number of quotes to prune to after calculating quotes
   */
  numTopPartialQuotes: number;

  /**
   * Max splits
   */
  maxSplits: number;
}

export const DEFAULT_ROUTING_OPTIONS = {
  percentIncrement: 20,
  numTopRoutes: 50,
  numTopPartialQuotes: 10,
  maxSplits: 3,
};

export async function findBestRoutes(
  inputTokenMint: string,
  outputTokenMint: string,
  tradeAmount: u64,
  amountSpecifiedIsInput: boolean,
  walks: PoolWalks,
  pools: Record<string, TokenPairPool>,
  programId: Address,
  fetcher: AccountFetcher,
  userRoutingOptions: Partial<RoutingOptions> = DEFAULT_ROUTING_OPTIONS
): Promise<BestRoutesResult> {
  const pairRoutes = walks[getRouteId(inputTokenMint, outputTokenMint)];

  if (!pairRoutes) {
    return Promise.reject({
      success: false,
      error: RouteQueryError.ROUTE_DOES_NOT_EXIST,
    });
  }

  if (tradeAmount.isZero()) {
    return Promise.reject({
      success: false,
      error: RouteQueryError.ZERO_INPUT_AMOUNT,
    });
  }

  const routingOptions = { ...DEFAULT_ROUTING_OPTIONS, ...userRoutingOptions };
  const { percentIncrement, numTopRoutes, numTopPartialQuotes, maxSplits } = routingOptions;

  // Pre-fetch
  await prefetchRoutes(pairRoutes, programId, fetcher);

  const { percents, amounts } = generatePercentageAmounts(tradeAmount, percentIncrement);
  // The max route length is the number of iterations of quoting that we need to do
  const maxRouteLength = Math.max(...pairRoutes.map((route) => route.length));

  // For hop 0 of all routes, get swap quotes using [inputAmount, inputTokenMint]
  // For hop 1..n of all routes, get swap quotes using [outputAmount, outputTokenMint] of hop n-1 as input
  const quoteMap: Record<
    number,
    Array<Pick<InternalRouteQuote, "route" | "percent" | "calculatedHops">>
  > = {};
  let iteration = Array.from(Array(maxRouteLength).keys());
  if (!amountSpecifiedIsInput) {
    iteration = iteration.reverse();
  }

  try {
    for (const hop of iteration) {
      // Each batch of quotes needs to be iterative
      const quoteUpdates = buildQuoteUpdateRequests(
        inputTokenMint,
        outputTokenMint,
        pools,
        pairRoutes,
        percents,
        amounts,
        hop,
        amountSpecifiedIsInput,
        quoteMap
      );

      const quoteParams = await batchBuildSwapQuoteParams(
        quoteUpdates.map((update) => update.request),
        AddressUtil.toPubKey(programId),
        fetcher,
        false
      );

      updateQuoteMap(quoteUpdates, quoteParams, quoteMap);
    }
  } catch (e: any) {
    return {
      success: false,
      error: RouteQueryError.GENERAL,
      stack: e.stack,
    };
  }

  const [cleanedQuoteMap, failures] = categorizeQuotes(
    tradeAmount,
    amountSpecifiedIsInput,
    quoteMap
  );

  const prunedQuoteMap = pruneQuoteMap(
    cleanedQuoteMap,
    numTopPartialQuotes,
    amountSpecifiedIsInput
  );

  const bestRoutes = [
    ...getRankedRoutes(prunedQuoteMap, amountSpecifiedIsInput, numTopRoutes, maxSplits),
    ...getSingleHopSplit(cleanedQuoteMap),
  ].sort(getRouteCompareFn(amountSpecifiedIsInput));

  // TODO: Rudementary implementation to determine error. Find a better solution
  if (bestRoutes.length === 0) {
    // TODO: TRADE_AMOUNT_TOO_HIGH actually corresponds to TickArrayCrossingAboveMax. Fix swap quote.
    if (failures.has(SwapErrorCode.TickArraySequenceInvalid)) {
      return {
        success: false,
        error: RouteQueryError.TRADE_AMOUNT_TOO_HIGH,
      };
    }
  }

  return {
    success: true,
    bestRoutes,
  };
}

async function prefetchRoutes(pairRoutes: string[][], programId: Address, fetcher: AccountFetcher) {
  // Pre-fetch
  const poolSet = new Set<string>();
  for (let i = 0; i < pairRoutes.length; i++) {
    const route = pairRoutes[i];
    for (let j = 0; j < route.length; j++) {
      poolSet.add(route[j]);
    }
  }

  const ps = Array.from(poolSet);
  const allWps = await fetcher.listPools(ps, false);

  const tickArrayAddresses = [];
  for (let i = 0; i < allWps.length; i++) {
    const wp = allWps[i];
    if (wp == null) {
      continue;
    }
    const addr1 = SwapUtils.getTickArrayPublicKeys(
      wp.tickCurrentIndex,
      wp.tickSpacing,
      true,
      AddressUtil.toPubKey(programId),
      AddressUtil.toPubKey(ps[i])
    );
    const addr2 = SwapUtils.getTickArrayPublicKeys(
      wp.tickCurrentIndex,
      wp.tickSpacing,
      false,
      AddressUtil.toPubKey(programId),
      AddressUtil.toPubKey(ps[i])
    );
    const allAddrs = [...addr1, ...addr2].map((k) => k.toBase58());
    const unique = Array.from(new Set(allAddrs));
    tickArrayAddresses.push(...unique);
  }

  await fetcher.listTickArrays(tickArrayAddresses, false);
}

function getSingleHopSplit(quoteMap: { [key: number]: RouteQuote[] }) {
  const fullFlow = quoteMap[100];
  if (fullFlow) {
    return fullFlow
      .filter((f) => f.calculatedHops.length == 1 && f.calculatedHops[0]?.success)
      .map((f) => {
        const oneHop = f.calculatedHops[0];
        if (oneHop?.success) {
          return {
            quotes: [f],
            percent: 100,
            totalIn: oneHop.amountIn,
            totalOut: oneHop.amountOut,
          };
        }
        return undefined;
      })
      .flatMap((g) => (!!g ? g : []));
  }
  return [];
}

function updateQuoteMap(
  quoteUpdates: ReturnType<typeof buildQuoteUpdateRequests>,
  quoteParams: SwapQuoteParam[],
  quoteMap: Record<number, Array<Pick<InternalRouteQuote, "route" | "percent" | "calculatedHops">>>
) {
  for (const { address, percent, routeIndex, quoteIndex, hopIndex } of quoteUpdates) {
    const swapParam = quoteParams[quoteIndex];
    const route = quoteMap[percent][routeIndex];
    try {
      const quote = swapQuoteWithParams(swapParam, Percentage.fromFraction(0, 1000));
      const { whirlpoolData, tokenAmount, aToB, amountSpecifiedIsInput } = swapParam;
      const [mintA, mintB, vaultA, vaultB] = [
        whirlpoolData.tokenMintA.toBase58(),
        whirlpoolData.tokenMintB.toBase58(),
        whirlpoolData.tokenVaultA.toBase58(),
        whirlpoolData.tokenVaultB.toBase58(),
      ];
      const [inputMint, outputMint] = aToB ? [mintA, mintB] : [mintB, mintA];
      route.calculatedHops[hopIndex] = {
        success: true,
        percent,
        amountIn: amountSpecifiedIsInput ? tokenAmount : quote.otherAmountThreshold,
        amountOut: amountSpecifiedIsInput ? quote.otherAmountThreshold : tokenAmount,
        whirlpool: address,
        inputMint,
        outputMint,
        mintA,
        mintB,
        vaultA,
        vaultB,
        quote,
      };
    } catch (e: any) {
      const errorCode: SwapErrorCode = e.errorCode;
      route.calculatedHops[hopIndex] = {
        success: false,
        error: errorCode,
      };
      continue;
    }
  }
}

function buildQuoteUpdateRequests(
  inputTokenMint: string,
  outputTokenMint: string,
  pools: Record<string, TokenPairPool>,
  pairRoutes: string[][],
  percents: number[],
  amounts: BN[],
  hop: number,
  amountSpecifiedIsInput: boolean,
  quoteMap: Record<number, Array<Pick<InternalRouteQuote, "route" | "percent" | "calculatedHops">>>
) {
  // Each batch of quotes needs to be iterative
  const quoteUpdates = [];
  for (let amountIndex = 0; amountIndex < amounts.length; amountIndex++) {
    const percent = percents[amountIndex];
    const tradeAmount = amounts[amountIndex];

    // Initialize quote map for first hop
    if (!quoteMap[percent]) {
      quoteMap[percent] = Array(pairRoutes.length);
    }

    // Iterate over all routes
    for (let routeIndex = 0; routeIndex < pairRoutes.length; routeIndex++) {
      const route = pairRoutes[routeIndex];
      // If the current route is already complete (amountSpecifiedIsInput = true) or if the current hop is beyond
      // this route's length (amountSpecifiedIsInput = false), don't do anything
      if (amountSpecifiedIsInput ? route.length <= hop : hop > route.length - 1) {
        continue;
      }

      const startingRouteEval = amountSpecifiedIsInput ? hop === 0 : hop === route.length - 1;

      // If this is the first hop of the route, initialize the quote map
      if (startingRouteEval) {
        quoteMap[percent][routeIndex] = {
          percent,
          route,
          calculatedHops: Array(route.length),
        };
      }
      const currentQuote = quoteMap[percent][routeIndex];
      const initialPool = pools[route[0]];

      // TODO: we could pre-sort the routes here to not have to constantly reverse the routes
      let orderedRoute = route;

      // If either of the initial hop's token mints aren't the inputTokenMint, then we need to reverse the route
      if (
        AddressUtil.toPubKey(initialPool.tokenMintA).toBase58() !== inputTokenMint &&
        AddressUtil.toPubKey(initialPool.tokenMintB).toBase58() !== inputTokenMint
      ) {
        orderedRoute = [...route].reverse();
      }

      const pool = pools[orderedRoute[hop]];
      const lastHop = amountSpecifiedIsInput
        ? currentQuote.calculatedHops[hop - 1]
        : currentQuote.calculatedHops[hop + 1];

      // If this is the first hop, use the input mint and amount, otherwise use the output of the last hop
      let tokenAmount: u64;
      let tradeToken: Address;
      if (startingRouteEval) {
        tokenAmount = tradeAmount;
        tradeToken = amountSpecifiedIsInput ? inputTokenMint : outputTokenMint;
      } else {
        if (!lastHop?.success) {
          continue;
        }
        tokenAmount = amountSpecifiedIsInput ? lastHop.amountOut : lastHop.amountIn;
        tradeToken = amountSpecifiedIsInput ? lastHop.outputMint : lastHop.inputMint;
      }

      quoteUpdates.push({
        percent,
        routeIndex,
        hopIndex: hop,
        quoteIndex: quoteUpdates.length,
        address: pool.address,
        request: {
          whirlpool: pool.address,
          tradeTokenMint: tradeToken,
          tokenAmount,
          amountSpecifiedIsInput,
        },
      });
    }
  }
  return quoteUpdates;
}

/**
 * Annotate amountIn/amountOut for calculations
 * @param tradeAmount
 * @param quoteMap
 * @returns
 */
function categorizeQuotes(
  tradeAmount: u64,
  amountSpecifiedIsInput: boolean,
  quoteMap: Record<number, Array<Pick<InternalRouteQuote, "route" | "percent" | "calculatedHops">>>
) {
  const percents = Object.keys(quoteMap).map((percent) => Number(percent));
  const cleanedQuoteMap: { [key: number]: RouteQuote[] } = {};
  const failureErrors: Set<SwapErrorCode> = new Set();
  for (let i = 0; i < percents.length; i++) {
    const percent = percents[i];
    const uncleanedQuotes = quoteMap[percent];
    cleanedQuoteMap[percent] = [];
    for (const { route, calculatedHops } of uncleanedQuotes) {
      // If the route was successful at each step, add it to the clean quote stack
      const filteredCalculatedHops = calculatedHops.flatMap((val) =>
        !!val && val.success ? val : []
      );
      if (filteredCalculatedHops.length === route.length) {
        const otherAmount = amountSpecifiedIsInput
          ? filteredCalculatedHops[filteredCalculatedHops.length - 1].amountOut
          : filteredCalculatedHops[0].amountIn;
        cleanedQuoteMap[percent].push({
          percent,
          route,
          amountIn: amountSpecifiedIsInput ? tradeAmount : otherAmount,
          amountOut: amountSpecifiedIsInput ? otherAmount : tradeAmount,
          calculatedHops: filteredCalculatedHops,
        });
        continue;
      }

      // If a route failed, there would only be one failure
      const quoteFailures = calculatedHops.flatMap((f) => (f && !f?.success ? f : []));
      failureErrors.add(quoteFailures[0].error);
    }
  }
  return [cleanedQuoteMap, failureErrors] as const;
}

function pruneQuoteMap(
  quoteMap: { [key: number]: RouteQuote[] },
  pruneN: number,
  amountSpecifiedIsInput: boolean
) {
  const percents = Object.keys(quoteMap).map((percent) => Number(percent));
  const prunedQuoteMap: { [key: number]: RouteQuote[] } = {};
  const sortFn = amountSpecifiedIsInput
    ? (a: RouteQuote, b: RouteQuote) => b.amountOut.cmp(a.amountOut)
    : (a: RouteQuote, b: RouteQuote) => a.amountIn.cmp(b.amountIn);
  for (let i = 0; i < percents.length; i++) {
    const sortedQuotes = quoteMap[percents[i]].sort(sortFn);
    const slicedSorted = sortedQuotes.slice(0, pruneN);
    prunedQuoteMap[percents[i]] = slicedSorted;
  }
  return prunedQuoteMap;
}

function generatePercentageAmounts(inputAmount: u64, minPercent: number = 5) {
  const percents = [];
  const amounts = [];

  for (let i = 1; i <= 100 / minPercent; i++) {
    percents.push(i * minPercent);
    amounts.push(inputAmount.mul(new u64(i * minPercent)).div(new u64(100)));
  }

  return { percents, amounts };
}