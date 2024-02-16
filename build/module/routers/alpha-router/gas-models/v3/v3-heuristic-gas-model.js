import { BigNumber } from '@ethersproject/bignumber';
import { Price } from '@uniswap/sdk-core';
import _ from 'lodash';
import { WRAPPED_NATIVE_CURRENCY } from '../../../..';
import { CurrencyAmount } from '../../../../util/amounts';
import { calculateL1GasFeesHelper } from '../../../../util/gas-factory-helpers';
import { log } from '../../../../util/log';
import { getQuoteThroughNativePool, IOnChainGasModelFactory, } from '../gas-model';
import { BASE_SWAP_COST, COST_PER_HOP, COST_PER_INIT_TICK, COST_PER_UNINIT_TICK, SINGLE_HOP_OVERHEAD, TOKEN_OVERHEAD, } from './gas-costs';
/**
 * Computes a gas estimate for a V3 swap using heuristics.
 * Considers number of hops in the route, number of ticks crossed
 * and the typical base cost for a swap.
 *
 * We get the number of ticks crossed in a swap from the QuoterV2
 * contract.
 *
 * We compute gas estimates off-chain because
 *  1/ Calling eth_estimateGas for a swaps requires the caller to have
 *     the full balance token being swapped, and approvals.
 *  2/ Tracking gas used using a wrapper contract is not accurate with Multicall
 *     due to EIP-2929. We would have to make a request for every swap we wanted to estimate.
 *  3/ For V2 we simulate all our swaps off-chain so have no way to track gas used.
 *
 * @export
 * @class V3HeuristicGasModelFactory
 */
export class V3HeuristicGasModelFactory extends IOnChainGasModelFactory {
    constructor() {
        super();
    }
    async buildGasModel({ chainId, gasPriceWei, pools, amountToken, quoteToken, l2GasDataProvider, providerConfig, }) {
        const l2GasData = l2GasDataProvider
            ? await l2GasDataProvider.getGasData(providerConfig)
            : undefined;
        const usdPool = pools.usdPool;
        const calculateL1GasFees = async (route) => {
            return await calculateL1GasFeesHelper(route, chainId, usdPool, quoteToken, pools.nativeAndQuoteTokenV3Pool, l2GasData);
        };
        const nativeCurrency = WRAPPED_NATIVE_CURRENCY[chainId];
        let nativeAmountPool = null;
        if (!amountToken.equals(nativeCurrency)) {
            nativeAmountPool = pools.nativeAndAmountTokenV3Pool;
        }
        const usdToken = usdPool.token0.equals(nativeCurrency)
            ? usdPool.token1
            : usdPool.token0;
        const estimateGasCost = (routeWithValidQuote) => {
            var _a;
            const { totalGasCostNativeCurrency, baseGasUse } = this.estimateGas(routeWithValidQuote, gasPriceWei, chainId, providerConfig);
            /** ------ MARK: USD logic  -------- */
            const gasCostInTermsOfUSD = getQuoteThroughNativePool(chainId, totalGasCostNativeCurrency, usdPool);
            /** ------ MARK: Conditional logic run if gasToken is specified  -------- */
            const nativeAndSpecifiedGasTokenPool = pools.nativeAndSpecifiedGasTokenV3Pool;
            let gasCostInTermsOfGasToken = undefined;
            // we don't want to fetch the gasToken pool if the gasToken is the native currency
            if (nativeAndSpecifiedGasTokenPool) {
                gasCostInTermsOfGasToken = getQuoteThroughNativePool(chainId, totalGasCostNativeCurrency, nativeAndSpecifiedGasTokenPool);
            }
            // if the gasToken is the native currency, we can just use the totalGasCostNativeCurrency
            else if ((_a = providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.gasToken) === null || _a === void 0 ? void 0 : _a.equals(nativeCurrency)) {
                gasCostInTermsOfGasToken = totalGasCostNativeCurrency;
            }
            /** ------ MARK: return early if quoteToken is wrapped native currency ------- */
            if (quoteToken.equals(nativeCurrency)) {
                return {
                    gasEstimate: baseGasUse,
                    gasCostInToken: totalGasCostNativeCurrency,
                    gasCostInUSD: gasCostInTermsOfUSD,
                    gasCostInGasToken: gasCostInTermsOfGasToken,
                };
            }
            /** ------ MARK: Main gas logic in terms of quote token -------- */
            // Since the quote token is not in the native currency, we convert the gas cost to be in terms of the quote token.
            // We do this by getting the highest liquidity <quoteToken>/<nativeCurrency> pool. eg. <quoteToken>/ETH pool.
            const nativeAndQuoteTokenPool = pools.nativeAndQuoteTokenV3Pool;
            let gasCostInTermsOfQuoteToken = null;
            if (nativeAndQuoteTokenPool) {
                gasCostInTermsOfQuoteToken = getQuoteThroughNativePool(chainId, totalGasCostNativeCurrency, nativeAndQuoteTokenPool);
            }
            // We may have a nativeAmountPool, but not a nativePool
            else {
                log.info(`Unable to find ${nativeCurrency.symbol} pool with the quote token, ${quoteToken.symbol} to produce gas adjusted costs. Using amountToken to calculate gas costs.`);
            }
            /** ------ MARK: (V3 ONLY) Logic for calculating synthetic gas cost in terms of amount token -------- */
            // TODO: evaluate effectiveness and potentially refactor
            // Highest liquidity pool for the non quote token / ETH
            // A pool with the non quote token / ETH should not be required and errors should be handled separately
            if (nativeAmountPool) {
                // get current execution price (amountToken / quoteToken)
                const executionPrice = new Price(routeWithValidQuote.amount.currency, routeWithValidQuote.quote.currency, routeWithValidQuote.amount.quotient, routeWithValidQuote.quote.quotient);
                const inputIsToken0 = nativeAmountPool.token0.address == nativeCurrency.address;
                // ratio of input / native
                const nativeAndAmountTokenPrice = inputIsToken0
                    ? nativeAmountPool.token0Price
                    : nativeAmountPool.token1Price;
                const gasCostInTermsOfAmountToken = nativeAndAmountTokenPrice.quote(totalGasCostNativeCurrency);
                // Convert gasCostInTermsOfAmountToken to quote token using execution price
                const syntheticGasCostInTermsOfQuoteToken = executionPrice.quote(gasCostInTermsOfAmountToken);
                // Note that the syntheticGasCost being lessThan the original quoted value is not always strictly better
                // e.g. the scenario where the amountToken/ETH pool is very illiquid as well and returns an extremely small number
                // however, it is better to have the gasEstimation be almost 0 than almost infinity, as the user will still receive a quote
                if (gasCostInTermsOfQuoteToken === null ||
                    syntheticGasCostInTermsOfQuoteToken.lessThan(gasCostInTermsOfQuoteToken.asFraction)) {
                    log.info({
                        nativeAndAmountTokenPrice: nativeAndAmountTokenPrice.toSignificant(6),
                        gasCostInTermsOfQuoteToken: gasCostInTermsOfQuoteToken
                            ? gasCostInTermsOfQuoteToken.toExact()
                            : 0,
                        gasCostInTermsOfAmountToken: gasCostInTermsOfAmountToken.toExact(),
                        executionPrice: executionPrice.toSignificant(6),
                        syntheticGasCostInTermsOfQuoteToken: syntheticGasCostInTermsOfQuoteToken.toSignificant(6),
                    }, 'New gasCostInTermsOfQuoteToken calculated with synthetic quote token price is less than original');
                    gasCostInTermsOfQuoteToken = syntheticGasCostInTermsOfQuoteToken;
                }
            }
            // If gasCostInTermsOfQuoteToken is null, both attempts to calculate gasCostInTermsOfQuoteToken failed (nativePool and amountNativePool)
            if (gasCostInTermsOfQuoteToken === null) {
                log.info(`Unable to find ${nativeCurrency.symbol} pool with the quote token, ${quoteToken.symbol}, or amount Token, ${amountToken.symbol} to produce gas adjusted costs. Route will not account for gas.`);
                return {
                    gasEstimate: baseGasUse,
                    gasCostInToken: CurrencyAmount.fromRawAmount(quoteToken, 0),
                    gasCostInUSD: CurrencyAmount.fromRawAmount(usdToken, 0),
                };
            }
            return {
                gasEstimate: baseGasUse,
                gasCostInToken: gasCostInTermsOfQuoteToken,
                gasCostInUSD: gasCostInTermsOfUSD,
                gasCostInGasToken: gasCostInTermsOfGasToken,
            };
        };
        return {
            estimateGasCost: estimateGasCost.bind(this),
            calculateL1GasFees,
        };
    }
    estimateGas(routeWithValidQuote, gasPriceWei, chainId, providerConfig) {
        var _a;
        const totalInitializedTicksCrossed = BigNumber.from(Math.max(1, _.sum(routeWithValidQuote.initializedTicksCrossedList)));
        const totalHops = BigNumber.from(routeWithValidQuote.route.pools.length);
        let hopsGasUse = COST_PER_HOP(chainId).mul(totalHops);
        // We have observed that this algorithm tends to underestimate single hop swaps.
        // We add a buffer in the case of a single hop swap.
        if (totalHops.eq(1)) {
            hopsGasUse = hopsGasUse.add(SINGLE_HOP_OVERHEAD(chainId));
        }
        // Some tokens have extremely expensive transferFrom functions, which causes
        // us to underestimate them by a large amount. For known tokens, we apply an
        // adjustment.
        const tokenOverhead = TOKEN_OVERHEAD(chainId, routeWithValidQuote.route);
        const tickGasUse = COST_PER_INIT_TICK(chainId).mul(totalInitializedTicksCrossed);
        const uninitializedTickGasUse = COST_PER_UNINIT_TICK.mul(0);
        // base estimate gas used based on chainId estimates for hops and ticks gas useage
        const baseGasUse = BASE_SWAP_COST(chainId)
            .add(hopsGasUse)
            .add(tokenOverhead)
            .add(tickGasUse)
            .add(uninitializedTickGasUse)
            .add((_a = providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.additionalGasOverhead) !== null && _a !== void 0 ? _a : BigNumber.from(0));
        const baseGasCostWei = gasPriceWei.mul(baseGasUse);
        const wrappedCurrency = WRAPPED_NATIVE_CURRENCY[chainId];
        const totalGasCostNativeCurrency = CurrencyAmount.fromRawAmount(wrappedCurrency, baseGasCostWei.toString());
        return {
            totalGasCostNativeCurrency,
            totalInitializedTicksCrossed,
            baseGasUse,
        };
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidjMtaGV1cmlzdGljLWdhcy1tb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uLy4uL3NyYy9yb3V0ZXJzL2FscGhhLXJvdXRlci9nYXMtbW9kZWxzL3YzL3YzLWhldXJpc3RpYy1nYXMtbW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBQ3JELE9BQU8sRUFBVyxLQUFLLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUVuRCxPQUFPLENBQUMsTUFBTSxRQUFRLENBQUM7QUFFdkIsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sYUFBYSxDQUFDO0FBQ3RELE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSwwQkFBMEIsQ0FBQztBQUMxRCxPQUFPLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSxzQ0FBc0MsQ0FBQztBQUNoRixPQUFPLEVBQUUsR0FBRyxFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFFM0MsT0FBTyxFQUdMLHlCQUF5QixFQUV6Qix1QkFBdUIsR0FDeEIsTUFBTSxjQUFjLENBQUM7QUFFdEIsT0FBTyxFQUNMLGNBQWMsRUFDZCxZQUFZLEVBQ1osa0JBQWtCLEVBQ2xCLG9CQUFvQixFQUNwQixtQkFBbUIsRUFDbkIsY0FBYyxHQUNmLE1BQU0sYUFBYSxDQUFDO0FBRXJCOzs7Ozs7Ozs7Ozs7Ozs7OztHQWlCRztBQUNILE1BQU0sT0FBTywwQkFBMkIsU0FBUSx1QkFBdUI7SUFDckU7UUFDRSxLQUFLLEVBQUUsQ0FBQztJQUNWLENBQUM7SUFFTSxLQUFLLENBQUMsYUFBYSxDQUFDLEVBQ3pCLE9BQU8sRUFDUCxXQUFXLEVBQ1gsS0FBSyxFQUNMLFdBQVcsRUFDWCxVQUFVLEVBQ1YsaUJBQWlCLEVBQ2pCLGNBQWMsR0FDa0I7UUFHaEMsTUFBTSxTQUFTLEdBQUcsaUJBQWlCO1lBQ2pDLENBQUMsQ0FBQyxNQUFNLGlCQUFpQixDQUFDLFVBQVUsQ0FBQyxjQUFjLENBQUM7WUFDcEQsQ0FBQyxDQUFDLFNBQVMsQ0FBQztRQUVkLE1BQU0sT0FBTyxHQUFTLEtBQUssQ0FBQyxPQUFPLENBQUM7UUFFcEMsTUFBTSxrQkFBa0IsR0FBRyxLQUFLLEVBQzlCLEtBQThCLEVBTTdCLEVBQUU7WUFDSCxPQUFPLE1BQU0sd0JBQXdCLENBQ25DLEtBQUssRUFDTCxPQUFPLEVBQ1AsT0FBTyxFQUNQLFVBQVUsRUFDVixLQUFLLENBQUMseUJBQXlCLEVBQy9CLFNBQVMsQ0FDVixDQUFDO1FBQ0osQ0FBQyxDQUFDO1FBRUYsTUFBTSxjQUFjLEdBQUcsdUJBQXVCLENBQUMsT0FBTyxDQUFFLENBQUM7UUFDekQsSUFBSSxnQkFBZ0IsR0FBZ0IsSUFBSSxDQUFDO1FBQ3pDLElBQUksQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDLGNBQWMsQ0FBQyxFQUFFO1lBQ3ZDLGdCQUFnQixHQUFHLEtBQUssQ0FBQywwQkFBMEIsQ0FBQztTQUNyRDtRQUVELE1BQU0sUUFBUSxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLGNBQWMsQ0FBQztZQUNwRCxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU07WUFDaEIsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUM7UUFFbkIsTUFBTSxlQUFlLEdBQUcsQ0FDdEIsbUJBQTBDLEVBTTFDLEVBQUU7O1lBQ0YsTUFBTSxFQUFFLDBCQUEwQixFQUFFLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxXQUFXLENBQ2pFLG1CQUFtQixFQUNuQixXQUFXLEVBQ1gsT0FBTyxFQUNQLGNBQWMsQ0FDZixDQUFDO1lBRUYsdUNBQXVDO1lBQ3ZDLE1BQU0sbUJBQW1CLEdBQUcseUJBQXlCLENBQ25ELE9BQU8sRUFDUCwwQkFBMEIsRUFDMUIsT0FBTyxDQUNSLENBQUM7WUFFRiw0RUFBNEU7WUFDNUUsTUFBTSw4QkFBOEIsR0FDbEMsS0FBSyxDQUFDLGdDQUFnQyxDQUFDO1lBQ3pDLElBQUksd0JBQXdCLEdBQStCLFNBQVMsQ0FBQztZQUNyRSxrRkFBa0Y7WUFDbEYsSUFBSSw4QkFBOEIsRUFBRTtnQkFDbEMsd0JBQXdCLEdBQUcseUJBQXlCLENBQ2xELE9BQU8sRUFDUCwwQkFBMEIsRUFDMUIsOEJBQThCLENBQy9CLENBQUM7YUFDSDtZQUNELHlGQUF5RjtpQkFDcEYsSUFBSSxNQUFBLGNBQWMsYUFBZCxjQUFjLHVCQUFkLGNBQWMsQ0FBRSxRQUFRLDBDQUFFLE1BQU0sQ0FBQyxjQUFjLENBQUMsRUFBRTtnQkFDekQsd0JBQXdCLEdBQUcsMEJBQTBCLENBQUM7YUFDdkQ7WUFFRCxpRkFBaUY7WUFDakYsSUFBSSxVQUFVLENBQUMsTUFBTSxDQUFDLGNBQWMsQ0FBQyxFQUFFO2dCQUNyQyxPQUFPO29CQUNMLFdBQVcsRUFBRSxVQUFVO29CQUN2QixjQUFjLEVBQUUsMEJBQTBCO29CQUMxQyxZQUFZLEVBQUUsbUJBQW1CO29CQUNqQyxpQkFBaUIsRUFBRSx3QkFBd0I7aUJBQzVDLENBQUM7YUFDSDtZQUVELG1FQUFtRTtZQUVuRSxrSEFBa0g7WUFDbEgsNkdBQTZHO1lBQzdHLE1BQU0sdUJBQXVCLEdBQzNCLEtBQUssQ0FBQyx5QkFBeUIsQ0FBQztZQUVsQyxJQUFJLDBCQUEwQixHQUEwQixJQUFJLENBQUM7WUFDN0QsSUFBSSx1QkFBdUIsRUFBRTtnQkFDM0IsMEJBQTBCLEdBQUcseUJBQXlCLENBQ3BELE9BQU8sRUFDUCwwQkFBMEIsRUFDMUIsdUJBQXVCLENBQ3hCLENBQUM7YUFDSDtZQUNELHVEQUF1RDtpQkFDbEQ7Z0JBQ0gsR0FBRyxDQUFDLElBQUksQ0FDTixrQkFBa0IsY0FBYyxDQUFDLE1BQU0sK0JBQStCLFVBQVUsQ0FBQyxNQUFNLDJFQUEyRSxDQUNuSyxDQUFDO2FBQ0g7WUFFRCx3R0FBd0c7WUFDeEcsd0RBQXdEO1lBRXhELHVEQUF1RDtZQUN2RCx1R0FBdUc7WUFDdkcsSUFBSSxnQkFBZ0IsRUFBRTtnQkFDcEIseURBQXlEO2dCQUN6RCxNQUFNLGNBQWMsR0FBRyxJQUFJLEtBQUssQ0FDOUIsbUJBQW1CLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFDbkMsbUJBQW1CLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFDbEMsbUJBQW1CLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFDbkMsbUJBQW1CLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FDbkMsQ0FBQztnQkFFRixNQUFNLGFBQWEsR0FDakIsZ0JBQWdCLENBQUMsTUFBTSxDQUFDLE9BQU8sSUFBSSxjQUFjLENBQUMsT0FBTyxDQUFDO2dCQUM1RCwwQkFBMEI7Z0JBQzFCLE1BQU0seUJBQXlCLEdBQUcsYUFBYTtvQkFDN0MsQ0FBQyxDQUFDLGdCQUFnQixDQUFDLFdBQVc7b0JBQzlCLENBQUMsQ0FBQyxnQkFBZ0IsQ0FBQyxXQUFXLENBQUM7Z0JBRWpDLE1BQU0sMkJBQTJCLEdBQUcseUJBQXlCLENBQUMsS0FBSyxDQUNqRSwwQkFBMEIsQ0FDVCxDQUFDO2dCQUVwQiwyRUFBMkU7Z0JBQzNFLE1BQU0sbUNBQW1DLEdBQUcsY0FBYyxDQUFDLEtBQUssQ0FDOUQsMkJBQTJCLENBQzVCLENBQUM7Z0JBRUYsd0dBQXdHO2dCQUN4RyxrSEFBa0g7Z0JBQ2xILDJIQUEySDtnQkFDM0gsSUFDRSwwQkFBMEIsS0FBSyxJQUFJO29CQUNuQyxtQ0FBbUMsQ0FBQyxRQUFRLENBQzFDLDBCQUEwQixDQUFDLFVBQVUsQ0FDdEMsRUFDRDtvQkFDQSxHQUFHLENBQUMsSUFBSSxDQUNOO3dCQUNFLHlCQUF5QixFQUN2Qix5QkFBeUIsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDO3dCQUM1QywwQkFBMEIsRUFBRSwwQkFBMEI7NEJBQ3BELENBQUMsQ0FBQywwQkFBMEIsQ0FBQyxPQUFPLEVBQUU7NEJBQ3RDLENBQUMsQ0FBQyxDQUFDO3dCQUNMLDJCQUEyQixFQUN6QiwyQkFBMkIsQ0FBQyxPQUFPLEVBQUU7d0JBQ3ZDLGNBQWMsRUFBRSxjQUFjLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQzt3QkFDL0MsbUNBQW1DLEVBQ2pDLG1DQUFtQyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUM7cUJBQ3ZELEVBQ0Qsa0dBQWtHLENBQ25HLENBQUM7b0JBRUYsMEJBQTBCLEdBQUcsbUNBQW1DLENBQUM7aUJBQ2xFO2FBQ0Y7WUFFRCx3SUFBd0k7WUFDeEksSUFBSSwwQkFBMEIsS0FBSyxJQUFJLEVBQUU7Z0JBQ3ZDLEdBQUcsQ0FBQyxJQUFJLENBQ04sa0JBQWtCLGNBQWMsQ0FBQyxNQUFNLCtCQUErQixVQUFVLENBQUMsTUFBTSxzQkFBc0IsV0FBVyxDQUFDLE1BQU0saUVBQWlFLENBQ2pNLENBQUM7Z0JBQ0YsT0FBTztvQkFDTCxXQUFXLEVBQUUsVUFBVTtvQkFDdkIsY0FBYyxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQztvQkFDM0QsWUFBWSxFQUFFLGNBQWMsQ0FBQyxhQUFhLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztpQkFDeEQsQ0FBQzthQUNIO1lBRUQsT0FBTztnQkFDTCxXQUFXLEVBQUUsVUFBVTtnQkFDdkIsY0FBYyxFQUFFLDBCQUEwQjtnQkFDMUMsWUFBWSxFQUFFLG1CQUFvQjtnQkFDbEMsaUJBQWlCLEVBQUUsd0JBQXdCO2FBQzVDLENBQUM7UUFDSixDQUFDLENBQUM7UUFFRixPQUFPO1lBQ0wsZUFBZSxFQUFFLGVBQWUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO1lBQzNDLGtCQUFrQjtTQUNuQixDQUFDO0lBQ0osQ0FBQztJQUVPLFdBQVcsQ0FDakIsbUJBQTBDLEVBQzFDLFdBQXNCLEVBQ3RCLE9BQWdCLEVBQ2hCLGNBQXVDOztRQUV2QyxNQUFNLDRCQUE0QixHQUFHLFNBQVMsQ0FBQyxJQUFJLENBQ2pELElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsbUJBQW1CLENBQUMsMkJBQTJCLENBQUMsQ0FBQyxDQUNwRSxDQUFDO1FBQ0YsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBRXpFLElBQUksVUFBVSxHQUFHLFlBQVksQ0FBQyxPQUFPLENBQUMsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUM7UUFFdEQsZ0ZBQWdGO1FBQ2hGLG9EQUFvRDtRQUNwRCxJQUFJLFNBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUU7WUFDbkIsVUFBVSxHQUFHLFVBQVUsQ0FBQyxHQUFHLENBQUMsbUJBQW1CLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztTQUMzRDtRQUVELDRFQUE0RTtRQUM1RSw0RUFBNEU7UUFDNUUsY0FBYztRQUNkLE1BQU0sYUFBYSxHQUFHLGNBQWMsQ0FBQyxPQUFPLEVBQUUsbUJBQW1CLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFekUsTUFBTSxVQUFVLEdBQUcsa0JBQWtCLENBQUMsT0FBTyxDQUFDLENBQUMsR0FBRyxDQUNoRCw0QkFBNEIsQ0FDN0IsQ0FBQztRQUNGLE1BQU0sdUJBQXVCLEdBQUcsb0JBQW9CLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBRTVELGtGQUFrRjtRQUNsRixNQUFNLFVBQVUsR0FBRyxjQUFjLENBQUMsT0FBTyxDQUFDO2FBQ3ZDLEdBQUcsQ0FBQyxVQUFVLENBQUM7YUFDZixHQUFHLENBQUMsYUFBYSxDQUFDO2FBQ2xCLEdBQUcsQ0FBQyxVQUFVLENBQUM7YUFDZixHQUFHLENBQUMsdUJBQXVCLENBQUM7YUFDNUIsR0FBRyxDQUFDLE1BQUEsY0FBYyxhQUFkLGNBQWMsdUJBQWQsY0FBYyxDQUFFLHFCQUFxQixtQ0FBSSxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFFbkUsTUFBTSxjQUFjLEdBQUcsV0FBVyxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUVuRCxNQUFNLGVBQWUsR0FBRyx1QkFBdUIsQ0FBQyxPQUFPLENBQUUsQ0FBQztRQUUxRCxNQUFNLDBCQUEwQixHQUFHLGNBQWMsQ0FBQyxhQUFhLENBQzdELGVBQWUsRUFDZixjQUFjLENBQUMsUUFBUSxFQUFFLENBQzFCLENBQUM7UUFFRixPQUFPO1lBQ0wsMEJBQTBCO1lBQzFCLDRCQUE0QjtZQUM1QixVQUFVO1NBQ1gsQ0FBQztJQUNKLENBQUM7Q0FDRiJ9