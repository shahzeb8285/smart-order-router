import { BigNumber } from '@ethersproject/bignumber';
import _ from 'lodash';
import { log, WRAPPED_NATIVE_CURRENCY } from '../../../../util';
import { CurrencyAmount } from '../../../../util/amounts';
import { calculateL1GasFeesHelper, getV2NativePool, } from '../../../../util/gas-factory-helpers';
import { getQuoteThroughNativePool, IV2GasModelFactory, usdGasTokensByChain, } from '../gas-model';
// Constant cost for doing any swap regardless of pools.
export const BASE_SWAP_COST = BigNumber.from(135000); // 115000, bumped up by 20_000 @eric 7/8/2022
// Constant per extra hop in the route.
export const COST_PER_EXTRA_HOP = BigNumber.from(50000); // 20000, bumped up by 30_000 @eric 7/8/2022
/**
 * Computes a gas estimate for a V2 swap using heuristics.
 * Considers number of hops in the route and the typical base cost for a swap.
 *
 * We compute gas estimates off-chain because
 *  1/ Calling eth_estimateGas for a swaps requires the caller to have
 *     the full balance token being swapped, and approvals.
 *  2/ Tracking gas used using a wrapper contract is not accurate with Multicall
 *     due to EIP-2929. We would have to make a request for every swap we wanted to estimate.
 *  3/ For V2 we simulate all our swaps off-chain so have no way to track gas used.
 *
 * Note, certain tokens e.g. rebasing/fee-on-transfer, may incur higher gas costs than
 * what we estimate here. This is because they run extra logic on token transfer.
 *
 * @export
 * @class V2HeuristicGasModelFactory
 */
export class V2HeuristicGasModelFactory extends IV2GasModelFactory {
    constructor() {
        super();
    }
    async buildGasModel({ chainId, gasPriceWei, poolProvider, token, l2GasDataProvider, providerConfig, }) {
        const l2GasData = l2GasDataProvider
            ? await l2GasDataProvider.getGasData(providerConfig)
            : undefined;
        const usdPoolPromise = this.getHighestLiquidityUSDPool(chainId, poolProvider, providerConfig);
        // Only fetch the native gasToken pool if specified by the config AND the gas token is not the native currency.
        const nativeAndSpecifiedGasTokenPoolPromise = (providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.gasToken) &&
            !(providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.gasToken.equals(WRAPPED_NATIVE_CURRENCY[chainId]))
            ? this.getEthPool(chainId, providerConfig.gasToken, poolProvider, providerConfig)
            : Promise.resolve(null);
        const [usdPool, nativeAndSpecifiedGasTokenPool] = await Promise.all([
            usdPoolPromise,
            nativeAndSpecifiedGasTokenPoolPromise,
        ]);
        let ethPool = null;
        if (!token.equals(WRAPPED_NATIVE_CURRENCY[chainId])) {
            ethPool = await this.getEthPool(chainId, token, poolProvider, providerConfig);
        }
        const usdToken = usdPool.token0.address == WRAPPED_NATIVE_CURRENCY[chainId].address
            ? usdPool.token1
            : usdPool.token0;
        const calculateL1GasFees = async (route) => {
            const nativePool = !token.equals(WRAPPED_NATIVE_CURRENCY[chainId])
                ? await getV2NativePool(token, poolProvider, providerConfig)
                : null;
            return await calculateL1GasFeesHelper(route, chainId, usdPool, token, nativePool, l2GasData);
        };
        return {
            estimateGasCost: (routeWithValidQuote) => {
                var _a;
                const { gasCostInEth, gasUse } = this.estimateGas(routeWithValidQuote, gasPriceWei, chainId, providerConfig);
                /** ------ MARK: USD logic  -------- */
                const gasCostInTermsOfUSD = getQuoteThroughNativePool(chainId, gasCostInEth, usdPool);
                /** ------ MARK: Conditional logic run if gasToken is specified  -------- */
                let gasCostInTermsOfGasToken = undefined;
                if (nativeAndSpecifiedGasTokenPool) {
                    gasCostInTermsOfGasToken = getQuoteThroughNativePool(chainId, gasCostInEth, nativeAndSpecifiedGasTokenPool);
                }
                // if the gasToken is the native currency, we can just use the gasCostInEth
                else if ((_a = providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.gasToken) === null || _a === void 0 ? void 0 : _a.equals(WRAPPED_NATIVE_CURRENCY[chainId])) {
                    gasCostInTermsOfGasToken = gasCostInEth;
                }
                /** ------ MARK: return early if quoteToken is wrapped native currency ------- */
                if (token.equals(WRAPPED_NATIVE_CURRENCY[chainId])) {
                    return {
                        gasEstimate: gasUse,
                        gasCostInToken: gasCostInEth,
                        gasCostInUSD: gasCostInTermsOfUSD,
                        gasCostInGasToken: gasCostInTermsOfGasToken,
                    };
                }
                // If the quote token is not WETH, we convert the gas cost to be in terms of the quote token.
                // We do this by getting the highest liquidity <token>/ETH pool.
                if (!ethPool) {
                    log.info('Unable to find ETH pool with the quote token to produce gas adjusted costs. Route will not account for gas.');
                    return {
                        gasEstimate: gasUse,
                        gasCostInToken: CurrencyAmount.fromRawAmount(token, 0),
                        gasCostInUSD: CurrencyAmount.fromRawAmount(usdToken, 0),
                    };
                }
                const gasCostInTermsOfQuoteToken = getQuoteThroughNativePool(chainId, gasCostInEth, ethPool);
                return {
                    gasEstimate: gasUse,
                    gasCostInToken: gasCostInTermsOfQuoteToken,
                    gasCostInUSD: gasCostInTermsOfUSD,
                    gasCostInGasToken: gasCostInTermsOfGasToken,
                };
            },
            calculateL1GasFees,
        };
    }
    estimateGas(routeWithValidQuote, gasPriceWei, chainId, providerConfig) {
        const hops = routeWithValidQuote.route.pairs.length;
        let gasUse = BASE_SWAP_COST.add(COST_PER_EXTRA_HOP.mul(hops - 1));
        if (providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.additionalGasOverhead) {
            gasUse = gasUse.add(providerConfig.additionalGasOverhead);
        }
        const totalGasCostWei = gasPriceWei.mul(gasUse);
        const weth = WRAPPED_NATIVE_CURRENCY[chainId];
        const gasCostInEth = CurrencyAmount.fromRawAmount(weth, totalGasCostWei.toString());
        return { gasCostInEth, gasUse };
    }
    async getEthPool(chainId, token, poolProvider, providerConfig) {
        const weth = WRAPPED_NATIVE_CURRENCY[chainId];
        const poolAccessor = await poolProvider.getPools([[weth, token]], providerConfig);
        const pool = poolAccessor.getPool(weth, token);
        if (!pool || pool.reserve0.equalTo(0) || pool.reserve1.equalTo(0)) {
            log.error({
                weth,
                token,
                reserve0: pool === null || pool === void 0 ? void 0 : pool.reserve0.toExact(),
                reserve1: pool === null || pool === void 0 ? void 0 : pool.reserve1.toExact(),
            }, `Could not find a valid WETH pool with ${token.symbol} for computing gas costs.`);
            return null;
        }
        return pool;
    }
    async getHighestLiquidityUSDPool(chainId, poolProvider, providerConfig) {
        const usdTokens = usdGasTokensByChain[chainId];
        if (!usdTokens) {
            throw new Error(`Could not find a USD token for computing gas costs on ${chainId}`);
        }
        const usdPools = _.map(usdTokens, (usdToken) => [
            usdToken,
            WRAPPED_NATIVE_CURRENCY[chainId],
        ]);
        const poolAccessor = await poolProvider.getPools(usdPools, providerConfig);
        const poolsRaw = poolAccessor.getAllPools();
        const pools = _.filter(poolsRaw, (pool) => pool.reserve0.greaterThan(0) &&
            pool.reserve1.greaterThan(0) &&
            // this case should never happen in production, but when we mock the pool provider it may return non native pairs
            (pool.token0.equals(WRAPPED_NATIVE_CURRENCY[chainId]) ||
                pool.token1.equals(WRAPPED_NATIVE_CURRENCY[chainId])));
        if (pools.length == 0) {
            log.error({ pools }, `Could not find a USD/WETH pool for computing gas costs.`);
            throw new Error(`Can't find USD/WETH pool for computing gas costs.`);
        }
        const maxPool = _.maxBy(pools, (pool) => {
            if (pool.token0.equals(WRAPPED_NATIVE_CURRENCY[chainId])) {
                return parseFloat(pool.reserve0.toSignificant(2));
            }
            else {
                return parseFloat(pool.reserve1.toSignificant(2));
            }
        });
        return maxPool;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidjItaGV1cmlzdGljLWdhcy1tb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uLy4uL3NyYy9yb3V0ZXJzL2FscGhhLXJvdXRlci9nYXMtbW9kZWxzL3YyL3YyLWhldXJpc3RpYy1nYXMtbW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBR3JELE9BQU8sQ0FBQyxNQUFNLFFBQVEsQ0FBQztBQUl2QixPQUFPLEVBQUUsR0FBRyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDaEUsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBQzFELE9BQU8sRUFDTCx3QkFBd0IsRUFDeEIsZUFBZSxHQUNoQixNQUFNLHNDQUFzQyxDQUFDO0FBRTlDLE9BQU8sRUFHTCx5QkFBeUIsRUFFekIsa0JBQWtCLEVBQ2xCLG1CQUFtQixHQUNwQixNQUFNLGNBQWMsQ0FBQztBQUV0Qix3REFBd0Q7QUFDeEQsTUFBTSxDQUFDLE1BQU0sY0FBYyxHQUFHLFNBQVMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyw2Q0FBNkM7QUFFbkcsdUNBQXVDO0FBQ3ZDLE1BQU0sQ0FBQyxNQUFNLGtCQUFrQixHQUFHLFNBQVMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyw0Q0FBNEM7QUFFckc7Ozs7Ozs7Ozs7Ozs7Ozs7R0FnQkc7QUFDSCxNQUFNLE9BQU8sMEJBQTJCLFNBQVEsa0JBQWtCO0lBQ2hFO1FBQ0UsS0FBSyxFQUFFLENBQUM7SUFDVixDQUFDO0lBRU0sS0FBSyxDQUFDLGFBQWEsQ0FBQyxFQUN6QixPQUFPLEVBQ1AsV0FBVyxFQUNYLFlBQVksRUFDWixLQUFLLEVBQ0wsaUJBQWlCLEVBQ2pCLGNBQWMsR0FDYTtRQUMzQixNQUFNLFNBQVMsR0FBRyxpQkFBaUI7WUFDakMsQ0FBQyxDQUFD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