import { BigNumber } from '@ethersproject/bignumber';
import { Protocol } from '@uniswap/router-sdk';
import { TradeType } from '@uniswap/sdk-core';
import JSBI from 'jsbi';
import _ from 'lodash';
import FixedReverseHeap from 'mnemonist/fixed-reverse-heap';
import Queue from 'mnemonist/queue';
import { HAS_L1_FEE, V2_SUPPORTED } from '../../../util';
import { CurrencyAmount } from '../../../util/amounts';
import { log } from '../../../util/log';
import { metric, MetricLoggerUnit } from '../../../util/metric';
import { routeAmountsToString, routeToString } from '../../../util/routes';
import { usdGasTokensByChain } from '../gas-models';
export async function getBestSwapRoute(amount, percents, routesWithValidQuotes, routeType, chainId, routingConfig, portionProvider, v2GasModel, v3GasModel, swapConfig) {
    const now = Date.now();
    const { forceMixedRoutes } = routingConfig;
    /// Like with forceCrossProtocol, we apply that logic here when determining the bestSwapRoute
    if (forceMixedRoutes) {
        log.info({
            forceMixedRoutes: forceMixedRoutes,
        }, 'Forcing mixed routes by filtering out other route types');
        routesWithValidQuotes = _.filter(routesWithValidQuotes, (quotes) => {
            return quotes.protocol === Protocol.MIXED;
        });
        if (!routesWithValidQuotes) {
            return null;
        }
    }
    // Build a map of percentage of the input to list of valid quotes.
    // Quotes can be null for a variety of reasons (not enough liquidity etc), so we drop them here too.
    const percentToQuotes = {};
    for (const routeWithValidQuote of routesWithValidQuotes) {
        if (!percentToQuotes[routeWithValidQuote.percent]) {
            percentToQuotes[routeWithValidQuote.percent] = [];
        }
        percentToQuotes[routeWithValidQuote.percent].push(routeWithValidQuote);
    }
    metric.putMetric('BuildRouteWithValidQuoteObjects', Date.now() - now, MetricLoggerUnit.Milliseconds);
    // Given all the valid quotes for each percentage find the optimal route.
    const swapRoute = await getBestSwapRouteBy(routeType, percentToQuotes, percents, chainId, (rq) => rq.quoteAdjustedForGas, routingConfig, portionProvider, v2GasModel, v3GasModel, swapConfig);
    // It is possible we were unable to find any valid route given the quotes.
    if (!swapRoute) {
        return null;
    }
    // Due to potential loss of precision when taking percentages of the input it is possible that the sum of the amounts of each
    // route of our optimal quote may not add up exactly to exactIn or exactOut.
    //
    // We check this here, and if there is a mismatch
    // add the missing amount to a random route. The missing amount size should be neglible so the quote should still be highly accurate.
    const { routes: routeAmounts } = swapRoute;
    const totalAmount = _.reduce(routeAmounts, (total, routeAmount) => total.add(routeAmount.amount), CurrencyAmount.fromRawAmount(routeAmounts[0].amount.currency, 0));
    const missingAmount = amount.subtract(totalAmount);
    if (missingAmount.greaterThan(0)) {
        log.info({
            missingAmount: missingAmount.quotient.toString(),
        }, `Optimal route's amounts did not equal exactIn/exactOut total. Adding missing amount to last route in array.`);
        routeAmounts[routeAmounts.length - 1].amount =
            routeAmounts[routeAmounts.length - 1].amount.add(missingAmount);
    }
    log.info({
        routes: routeAmountsToString(routeAmounts),
        numSplits: routeAmounts.length,
        amount: amount.toExact(),
        quote: swapRoute.quote.toExact(),
        quoteGasAdjusted: swapRoute.quoteGasAdjusted.toFixed(Math.min(swapRoute.quoteGasAdjusted.currency.decimals, 2)),
        estimatedGasUSD: swapRoute.estimatedGasUsedUSD.toFixed(Math.min(swapRoute.estimatedGasUsedUSD.currency.decimals, 2)),
        estimatedGasToken: swapRoute.estimatedGasUsedQuoteToken.toFixed(Math.min(swapRoute.estimatedGasUsedQuoteToken.currency.decimals, 2)),
    }, `Found best swap route. ${routeAmounts.length} split.`);
    return swapRoute;
}
export async function getBestSwapRouteBy(routeType, percentToQuotes, percents, chainId, by, routingConfig, portionProvider, v2GasModel, v3GasModel, swapConfig) {
    var _a;
    // Build a map of percentage to sorted list of quotes, with the biggest quote being first in the list.
    const percentToSortedQuotes = _.mapValues(percentToQuotes, (routeQuotes) => {
        return routeQuotes.sort((routeQuoteA, routeQuoteB) => {
            if (routeType == TradeType.EXACT_INPUT) {
                return by(routeQuoteA).greaterThan(by(routeQuoteB)) ? -1 : 1;
            }
            else {
                return by(routeQuoteA).lessThan(by(routeQuoteB)) ? -1 : 1;
            }
        });
    });
    const quoteCompFn = routeType == TradeType.EXACT_INPUT
        ? (a, b) => a.greaterThan(b)
        : (a, b) => a.lessThan(b);
    const sumFn = (currencyAmounts) => {
        let sum = currencyAmounts[0];
        for (let i = 1; i < currencyAmounts.length; i++) {
            sum = sum.add(currencyAmounts[i]);
        }
        return sum;
    };
    let bestQuote;
    let bestSwap;
    // Min-heap for tracking the 5 best swaps given some number of splits.
    const bestSwapsPerSplit = new FixedReverseHeap(Array, (a, b) => {
        return quoteCompFn(a.quote, b.quote) ? -1 : 1;
    }, 3);
    const { minSplits, maxSplits, forceCrossProtocol } = routingConfig;
    if (!percentToSortedQuotes[100] || minSplits > 1 || forceCrossProtocol) {
        log.info({
            percentToSortedQuotes: _.mapValues(percentToSortedQuotes, (p) => p.length),
        }, 'Did not find a valid route without any splits. Continuing search anyway.');
    }
    else {
        bestQuote = by(percentToSortedQuotes[100][0]);
        bestSwap = [percentToSortedQuotes[100][0]];
        for (const routeWithQuote of percentToSortedQuotes[100].slice(0, 5)) {
            bestSwapsPerSplit.push({
                quote: by(routeWithQuote),
                routes: [routeWithQuote],
            });
        }
    }
    // We do a BFS. Each additional node in a path represents us adding an additional split to the route.
    const queue = new Queue();
    // First we seed BFS queue with the best quotes for each percentage.
    // i.e. [best quote when sending 10% of amount, best quote when sending 20% of amount, ...]
    // We will explore the various combinations from each node.
    for (let i = percents.length; i >= 0; i--) {
        const percent = percents[i];
        if (!percentToSortedQuotes[percent]) {
            continue;
        }
        queue.enqueue({
            curRoutes: [percentToSortedQuotes[percent][0]],
            percentIndex: i,
            remainingPercent: 100 - percent,
            special: false,
        });
        if (!percentToSortedQuotes[percent] ||
            !percentToSortedQuotes[percent][1]) {
            continue;
        }
        queue.enqueue({
            curRoutes: [percentToSortedQuotes[percent][1]],
            percentIndex: i,
            remainingPercent: 100 - percent,
            special: true,
        });
    }
    let splits = 1;
    let startedSplit = Date.now();
    while (queue.size > 0) {
        metric.putMetric(`Split${splits}Done`, Date.now() - startedSplit, MetricLoggerUnit.Milliseconds);
        startedSplit = Date.now();
        log.info({
            top5: _.map(Array.from(bestSwapsPerSplit.consume()), (q) => `${q.quote.toExact()} (${_(q.routes)
                .map((r) => r.toString())
                .join(', ')})`),
            onQueue: queue.size,
        }, `Top 3 with ${splits} splits`);
        bestSwapsPerSplit.clear();
        // Size of the queue at this point is the number of potential routes we are investigating for the given number of splits.
        let layer = queue.size;
        splits++;
        // If we didn't improve our quote by adding another split, very unlikely to improve it by splitting more after that.
        if (splits >= 3 && bestSwap && bestSwap.length < splits - 1) {
            break;
        }
        if (splits > maxSplits) {
            log.info('Max splits reached. Stopping search.');
            metric.putMetric(`MaxSplitsHitReached`, 1, MetricLoggerUnit.Count);
            break;
        }
        while (layer > 0) {
            layer--;
            const { remainingPercent, curRoutes, percentIndex, special } = queue.dequeue();
            // For all other percentages, add a new potential route.
            // E.g. if our current aggregated route if missing 50%, we will create new nodes and add to the queue for:
            // 50% + new 10% route, 50% + new 20% route, etc.
            for (let i = percentIndex; i >= 0; i--) {
                const percentA = percents[i];
                if (percentA > remainingPercent) {
                    continue;
                }
                // At some point the amount * percentage is so small that the quoter is unable to get
                // a quote. In this case there could be no quotes for that percentage.
                if (!percentToSortedQuotes[percentA]) {
                    continue;
                }
                const candidateRoutesA = percentToSortedQuotes[percentA];
                // Find the best route in the complimentary percentage that doesn't re-use a pool already
                // used in the current route. Re-using pools is not allowed as each swap through a pool changes its liquidity,
                // so it would make the quotes inaccurate.
                const routeWithQuoteA = findFirstRouteNotUsingUsedPools(curRoutes, candidateRoutesA, forceCrossProtocol);
                if (!routeWithQuoteA) {
                    continue;
                }
                const remainingPercentNew = remainingPercent - percentA;
                const curRoutesNew = [...curRoutes, routeWithQuoteA];
                // If we've found a route combination that uses all 100%, and it has at least minSplits, update our best route.
                if (remainingPercentNew == 0 && splits >= minSplits) {
                    const quotesNew = _.map(curRoutesNew, (r) => by(r));
                    const quoteNew = sumFn(quotesNew);
                    let gasCostL1QuoteToken = CurrencyAmount.fromRawAmount(quoteNew.currency, 0);
                    if (HAS_L1_FEE.includes(chainId)) {
                        if (v2GasModel == undefined && v3GasModel == undefined) {
                            throw new Error("Can't compute L1 gas fees.");
                        }
                        else {
                            const v2Routes = curRoutesNew.filter((routes) => routes.protocol === Protocol.V2);
                            if (v2Routes.length > 0 && V2_SUPPORTED.includes(chainId)) {
                                if (v2GasModel) {
                                    const v2GasCostL1 = await v2GasModel.calculateL1GasFees(v2Routes);
                                    gasCostL1QuoteToken = gasCostL1QuoteToken.add(v2GasCostL1.gasCostL1QuoteToken);
                                }
                            }
                            const v3Routes = curRoutesNew.filter((routes) => routes.protocol === Protocol.V3);
                            if (v3Routes.length > 0) {
                                if (v3GasModel) {
                                    const v3GasCostL1 = await v3GasModel.calculateL1GasFees(v3Routes);
                                    gasCostL1QuoteToken = gasCostL1QuoteToken.add(v3GasCostL1.gasCostL1QuoteToken);
                                }
                            }
                        }
                    }
                    const quoteAfterL1Adjust = routeType == TradeType.EXACT_INPUT
                        ? quoteNew.subtract(gasCostL1QuoteToken)
                        : quoteNew.add(gasCostL1QuoteToken);
                    bestSwapsPerSplit.push({
                        quote: quoteAfterL1Adjust,
                        routes: curRoutesNew,
                    });
                    if (!bestQuote || quoteCompFn(quoteAfterL1Adjust, bestQuote)) {
                        bestQuote = quoteAfterL1Adjust;
                        bestSwap = curRoutesNew;
                        // Temporary experiment.
                        if (special) {
                            metric.putMetric(`BestSwapNotPickingBestForPercent`, 1, MetricLoggerUnit.Count);
                        }
                    }
                }
                else {
                    queue.enqueue({
                        curRoutes: curRoutesNew,
                        remainingPercent: remainingPercentNew,
                        percentIndex: i,
                        special,
                    });
                }
            }
        }
    }
    if (!bestSwap) {
        log.info(`Could not find a valid swap`);
        return undefined;
    }
    const postSplitNow = Date.now();
    let quoteGasAdjusted = sumFn(_.map(bestSwap, (routeWithValidQuote) => routeWithValidQuote.quoteAdjustedForGas));
    // this calculates the base gas used
    // if on L1, its the estimated gas used based on hops and ticks across all the routes
    // if on L2, its the gas used on the L2 based on hops and ticks across all the routes
    const estimatedGasUsed = _(bestSwap)
        .map((routeWithValidQuote) => routeWithValidQuote.gasEstimate)
        .reduce((sum, routeWithValidQuote) => sum.add(routeWithValidQuote), BigNumber.from(0));
    if (!usdGasTokensByChain[chainId] || !usdGasTokensByChain[chainId][0]) {
        // Each route can use a different stablecoin to account its gas costs.
        // They should all be pegged, and this is just an estimate, so we do a merge
        // to an arbitrary stable.
        throw new Error(`Could not find a USD token for computing gas costs on ${chainId}`);
    }
    const usdToken = usdGasTokensByChain[chainId][0];
    const usdTokenDecimals = usdToken.decimals;
    // if on L2, calculate the L1 security fee
    const gasCostsL1ToL2 = {
        gasUsedL1: BigNumber.from(0),
        gasUsedL1OnL2: BigNumber.from(0),
        gasCostL1USD: CurrencyAmount.fromRawAmount(usdToken, 0),
        gasCostL1QuoteToken: CurrencyAmount.fromRawAmount(
        // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
        (_a = bestSwap[0]) === null || _a === void 0 ? void 0 : _a.quoteToken, 0),
    };
    // If swapping on an L2 that includes a L1 security fee, calculate the fee and include it in the gas adjusted quotes
    if (HAS_L1_FEE.includes(chainId)) {
        if (v2GasModel == undefined && v3GasModel == undefined) {
            throw new Error("Can't compute L1 gas fees.");
        }
        else {
            // Before v2 deploy everywhere, a quote on L2 can only go through v3 protocol,
            // so a split between v2 and v3 is not possible.
            // After v2 deploy everywhere, a quote on L2 can go through v2 AND v3 protocol.
            // Since a split is possible now, the gas cost will be the summation of both v2 and v3 gas models.
            // So as long as any route contains v2/v3 protocol, we will calculate the gas cost accumulatively.
            const v2Routes = bestSwap.filter((routes) => routes.protocol === Protocol.V2);
            if (v2Routes.length > 0 && V2_SUPPORTED.includes(chainId)) {
                if (v2GasModel) {
                    const v2GasCostL1 = await v2GasModel.calculateL1GasFees(v2Routes);
                    gasCostsL1ToL2.gasUsedL1 = gasCostsL1ToL2.gasUsedL1.add(v2GasCostL1.gasUsedL1);
                    gasCostsL1ToL2.gasUsedL1OnL2 = gasCostsL1ToL2.gasUsedL1OnL2.add(v2GasCostL1.gasUsedL1OnL2);
                    if (gasCostsL1ToL2.gasCostL1USD.currency.equals(v2GasCostL1.gasCostL1USD.currency)) {
                        gasCostsL1ToL2.gasCostL1USD = gasCostsL1ToL2.gasCostL1USD.add(v2GasCostL1.gasCostL1USD);
                    }
                    else {
                        // This is to handle the case where gasCostsL1ToL2.gasCostL1USD and v2GasCostL1.gasCostL1USD have different currencies.
                        //
                        // gasCostsL1ToL2.gasCostL1USD was initially hardcoded to CurrencyAmount.fromRawAmount(usdGasTokensByChain[chainId]![0]!, 0)
                        // (https://github.com/Uniswap/smart-order-router/blob/main/src/routers/alpha-router/functions/best-swap-route.ts#L438)
                        // , where usdGasTokensByChain is coded in the descending order of decimals per chain,
                        // e.g. Arbitrum_one DAI (18 decimals), USDC bridged (6 decimals), USDC native (6 decimals)
                        // so gasCostsL1ToL2.gasCostL1USD will have DAI as currency.
                        //
                        // For v2GasCostL1.gasCostL1USD, it's calculated within getHighestLiquidityUSDPool among usdGasTokensByChain[chainId]!,
                        // (https://github.com/Uniswap/smart-order-router/blob/b970aedfec8a9509f9e22f14cc5c11be54d47b35/src/routers/alpha-router/gas-models/v2/v2-heuristic-gas-model.ts#L220)
                        // , so the code will actually see which USD pool has the highest liquidity, if any.
                        // e.g. Arbitrum_one on v2 only has liquidity on USDC native
                        // so v2GasCostL1.gasCostL1USD will have USDC native as currency.
                        //
                        // We will re-assign gasCostsL1ToL2.gasCostL1USD to v2GasCostL1.gasCostL1USD in this case.
                        gasCostsL1ToL2.gasCostL1USD = v2GasCostL1.gasCostL1USD;
                    }
                    gasCostsL1ToL2.gasCostL1QuoteToken =
                        gasCostsL1ToL2.gasCostL1QuoteToken.add(v2GasCostL1.gasCostL1QuoteToken);
                }
            }
            const v3Routes = bestSwap.filter((routes) => routes.protocol === Protocol.V3);
            if (v3Routes.length > 0) {
                if (v3GasModel) {
                    const v3GasCostL1 = await v3GasModel.calculateL1GasFees(v3Routes);
                    gasCostsL1ToL2.gasUsedL1 = gasCostsL1ToL2.gasUsedL1.add(v3GasCostL1.gasUsedL1);
                    gasCostsL1ToL2.gasUsedL1OnL2 = gasCostsL1ToL2.gasUsedL1OnL2.add(v3GasCostL1.gasUsedL1OnL2);
                    if (gasCostsL1ToL2.gasCostL1USD.currency.equals(v3GasCostL1.gasCostL1USD.currency)) {
                        gasCostsL1ToL2.gasCostL1USD = gasCostsL1ToL2.gasCostL1USD.add(v3GasCostL1.gasCostL1USD);
                    }
                    else {
                        // This is to handle the case where gasCostsL1ToL2.gasCostL1USD and v3GasCostL1.gasCostL1USD have different currencies.
                        //
                        // gasCostsL1ToL2.gasCostL1USD was initially hardcoded to CurrencyAmount.fromRawAmount(usdGasTokensByChain[chainId]![0]!, 0)
                        // (https://github.com/Uniswap/smart-order-router/blob/main/src/routers/alpha-router/functions/best-swap-route.ts#L438)
                        // , where usdGasTokensByChain is coded in the descending order of decimals per chain,
                        // e.g. Arbitrum_one DAI (18 decimals), USDC bridged (6 decimals), USDC native (6 decimals)
                        // so gasCostsL1ToL2.gasCostL1USD will have DAI as currency.
                        //
                        // For v3GasCostL1.gasCostL1USD, it's calculated within getHighestLiquidityV3USDPool among usdGasTokensByChain[chainId]!,
                        // (https://github.com/Uniswap/smart-order-router/blob/1c93e133c46af545f8a3d8af7fca3f1f2dcf597d/src/util/gas-factory-helpers.ts#L110)
                        // , so the code will actually see which USD pool has the highest liquidity, if any.
                        // e.g. Arbitrum_one on v3 has highest liquidity on USDC native
                        // so v3GasCostL1.gasCostL1USD will have USDC native as currency.
                        //
                        // We will re-assign gasCostsL1ToL2.gasCostL1USD to v3GasCostL1.gasCostL1USD in this case.
                        gasCostsL1ToL2.gasCostL1USD = v3GasCostL1.gasCostL1USD;
                    }
                    gasCostsL1ToL2.gasCostL1QuoteToken =
                        gasCostsL1ToL2.gasCostL1QuoteToken.add(v3GasCostL1.gasCostL1QuoteToken);
                }
            }
        }
    }
    const { gasUsedL1OnL2, gasCostL1USD, gasCostL1QuoteToken } = gasCostsL1ToL2;
    // For each gas estimate, normalize decimals to that of the chosen usd token.
    const estimatedGasUsedUSDs = _(bestSwap)
        .map((routeWithValidQuote) => {
        // TODO: will error if gasToken has decimals greater than usdToken
        const decimalsDiff = usdTokenDecimals - routeWithValidQuote.gasCostInUSD.currency.decimals;
        if (decimalsDiff == 0) {
            return CurrencyAmount.fromRawAmount(usdToken, routeWithValidQuote.gasCostInUSD.quotient);
        }
        return CurrencyAmount.fromRawAmount(usdToken, JSBI.multiply(routeWithValidQuote.gasCostInUSD.quotient, JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(decimalsDiff))));
    })
        .value();
    let estimatedGasUsedUSD = sumFn(estimatedGasUsedUSDs);
    // if they are different usd pools, convert to the usdToken
    if (estimatedGasUsedUSD.currency != gasCostL1USD.currency) {
        const decimalsDiff = usdTokenDecimals - gasCostL1USD.currency.decimals;
        estimatedGasUsedUSD = estimatedGasUsedUSD.add(CurrencyAmount.fromRawAmount(usdToken, JSBI.multiply(gasCostL1USD.quotient, JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(decimalsDiff)))));
    }
    else {
        estimatedGasUsedUSD = estimatedGasUsedUSD.add(gasCostL1USD);
    }
    log.info({
        estimatedGasUsedUSD: estimatedGasUsedUSD.toExact(),
        normalizedUsdToken: usdToken,
        routeUSDGasEstimates: _.map(bestSwap, (b) => `${b.percent}% ${routeToString(b.route)} ${b.gasCostInUSD.toExact()}`),
        flatL1GasCostUSD: gasCostL1USD.toExact(),
    }, 'USD gas estimates of best route');
    const estimatedGasUsedQuoteToken = sumFn(_.map(bestSwap, (routeWithValidQuote) => routeWithValidQuote.gasCostInToken)).add(gasCostL1QuoteToken);
    let estimatedGasUsedGasToken;
    if (routingConfig.gasToken) {
        // sum the gas costs in the gas token across all routes
        // if there is a route with undefined gasCostInGasToken, throw an error
        if (bestSwap.some((routeWithValidQuote) => routeWithValidQuote.gasCostInGasToken === undefined)) {
            log.info({
                bestSwap,
                routingConfig,
            }, 'Could not find gasCostInGasToken for a route in bestSwap');
            throw new Error("Can't compute estimatedGasUsedGasToken");
        }
        estimatedGasUsedGasToken = sumFn(_.map(bestSwap, 
        // ok to type cast here because we throw above if any are not defined
        (routeWithValidQuote) => routeWithValidQuote.gasCostInGasToken));
    }
    const quote = sumFn(_.map(bestSwap, (routeWithValidQuote) => routeWithValidQuote.quote));
    // Adjust the quoteGasAdjusted for the l1 fee
    if (routeType == TradeType.EXACT_INPUT) {
        const quoteGasAdjustedForL1 = quoteGasAdjusted.subtract(gasCostL1QuoteToken);
        quoteGasAdjusted = quoteGasAdjustedForL1;
    }
    else {
        const quoteGasAdjustedForL1 = quoteGasAdjusted.add(gasCostL1QuoteToken);
        quoteGasAdjusted = quoteGasAdjustedForL1;
    }
    const routeWithQuotes = bestSwap.sort((routeAmountA, routeAmountB) => routeAmountB.amount.greaterThan(routeAmountA.amount) ? 1 : -1);
    metric.putMetric('PostSplitDone', Date.now() - postSplitNow, MetricLoggerUnit.Milliseconds);
    return {
        quote,
        quoteGasAdjusted,
        estimatedGasUsed: estimatedGasUsed.add(gasUsedL1OnL2),
        estimatedGasUsedUSD,
        estimatedGasUsedQuoteToken,
        estimatedGasUsedGasToken,
        routes: portionProvider.getRouteWithQuotePortionAdjusted(routeType, routeWithQuotes, swapConfig),
    };
}
// We do not allow pools to be re-used across split routes, as swapping through a pool changes the pools state.
// Given a list of used routes, this function finds the first route in the list of candidate routes that does not re-use an already used pool.
const findFirstRouteNotUsingUsedPools = (usedRoutes, candidateRouteQuotes, forceCrossProtocol) => {
    const poolAddressSet = new Set();
    const usedPoolAddresses = _(usedRoutes)
        .flatMap((r) => r.poolAddresses)
        .value();
    for (const poolAddress of usedPoolAddresses) {
        poolAddressSet.add(poolAddress);
    }
    const protocolsSet = new Set();
    const usedProtocols = _(usedRoutes)
        .flatMap((r) => r.protocol)
        .uniq()
        .value();
    for (const protocol of usedProtocols) {
        protocolsSet.add(protocol);
    }
    for (const routeQuote of candidateRouteQuotes) {
        const { poolAddresses, protocol } = routeQuote;
        if (poolAddresses.some((poolAddress) => poolAddressSet.has(poolAddress))) {
            continue;
        }
        // This code is just for debugging. Allows us to force a cross-protocol split route by skipping
        // consideration of routes that come from the same protocol as a used route.
        const needToForce = forceCrossProtocol && protocolsSet.size == 1;
        if (needToForce && protocolsSet.has(protocol)) {
            continue;
        }
        return routeQuote;
    }
    return null;
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmVzdC1zd2FwLXJvdXRlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL3JvdXRlcnMvYWxwaGEtcm91dGVyL2Z1bmN0aW9ucy9iZXN0LXN3YXAtcm91dGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBQ3JELE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUMvQyxPQUFPLEVBQVcsU0FBUyxFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFDdkQsT0FBTyxJQUFJLE1BQU0sTUFBTSxDQUFDO0FBQ3hCLE9BQU8sQ0FBQyxNQUFNLFFBQVEsQ0FBQztBQUN2QixPQUFPLGdCQUFnQixNQUFNLDhCQUE4QixDQUFDO0FBQzVELE9BQU8sS0FBSyxNQUFNLGlCQUFpQixDQUFDO0FBR3BDLE9BQU8sRUFBRSxVQUFVLEVBQUUsWUFBWSxFQUFFLE1BQU0sZUFBZSxDQUFDO0FBQ3pELE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSx1QkFBdUIsQ0FBQztBQUN2RCxPQUFPLEVBQUUsR0FBRyxFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFDeEMsT0FBTyxFQUFFLE1BQU0sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBQ2hFLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxhQUFhLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUczRSxPQUFPLEVBQTZCLG1CQUFtQixFQUFFLE1BQU0sZUFBZSxDQUFDO0FBa0IvRSxNQUFNLENBQUMsS0FBSyxVQUFVLGdCQUFnQixDQUNwQyxNQUFzQixFQUN0QixRQUFrQixFQUNsQixxQkFBNEMsRUFDNUMsU0FBb0IsRUFDcEIsT0FBZ0IsRUFDaEIsYUFBZ0MsRUFDaEMsZUFBaUMsRUFDakMsVUFBNkMsRUFDN0MsVUFBNkMsRUFDN0MsVUFBd0I7SUFFeEIsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLEdB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