"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getQuoteThroughNativePool = exports.IOnChainGasModelFactory = exports.IV2GasModelFactory = exports.usdGasTokensByChain = void 0;
const sdk_core_1 = require("@uniswap/sdk-core");
const token_provider_1 = require("../../../providers/token-provider");
const util_1 = require("../../../util");
// When adding new usd gas tokens, ensure the tokens are ordered
// from tokens with highest decimals to lowest decimals. For example,
// DAI_AVAX has 18 decimals and comes before USDC_AVAX which has 6 decimals.
exports.usdGasTokensByChain = {
    [sdk_core_1.ChainId.MAINNET]: [token_provider_1.DAI_MAINNET, token_provider_1.USDC_MAINNET, token_provider_1.USDT_MAINNET],
    [sdk_core_1.ChainId.ARBITRUM_ONE]: [
        token_provider_1.DAI_ARBITRUM,
        token_provider_1.USDC_ARBITRUM,
        token_provider_1.USDC_NATIVE_ARBITRUM,
        token_provider_1.USDT_ARBITRUM,
    ],
    [sdk_core_1.ChainId.OPTIMISM]: [
        token_provider_1.DAI_OPTIMISM,
        token_provider_1.USDC_OPTIMISM,
        token_provider_1.USDC_NATIVE_OPTIMISM,
        token_provider_1.USDT_OPTIMISM,
    ],
    [sdk_core_1.ChainId.OPTIMISM_GOERLI]: [
        token_provider_1.DAI_OPTIMISM_GOERLI,
        token_provider_1.USDC_OPTIMISM_GOERLI,
        token_provider_1.USDT_OPTIMISM_GOERLI,
    ],
    [sdk_core_1.ChainId.OPTIMISM_SEPOLIA]: [
        token_provider_1.DAI_OPTIMISM_SEPOLIA,
        token_provider_1.USDC_OPTIMISM_SEPOLIA,
        token_provider_1.USDT_OPTIMISM_SEPOLIA,
    ],
    [sdk_core_1.ChainId.ARBITRUM_GOERLI]: [token_provider_1.USDC_ARBITRUM_GOERLI],
    [sdk_core_1.ChainId.ARBITRUM_SEPOLIA]: [token_provider_1.USDC_ARBITRUM_SEPOLIA],
    [sdk_core_1.ChainId.GOERLI]: [token_provider_1.DAI_GOERLI, token_provider_1.USDC_GOERLI, token_provider_1.USDT_GOERLI, token_provider_1.WBTC_GOERLI],
    [sdk_core_1.ChainId.SEPOLIA]: [token_provider_1.USDC_SEPOLIA, token_provider_1.DAI_SEPOLIA],
    [sdk_core_1.ChainId.POLYGON]: [token_provider_1.USDC_POLYGON, token_provider_1.USDC_NATIVE_POLYGON],
    [sdk_core_1.ChainId.POLYGON_MUMBAI]: [token_provider_1.DAI_POLYGON_MUMBAI],
    [sdk_core_1.ChainId.CELO]: [token_provider_1.CUSD_CELO, token_provider_1.USDC_CELO, token_provider_1.USDC_NATIVE_CELO, token_provider_1.USDC_WORMHOLE_CELO],
    [sdk_core_1.ChainId.CELO_ALFAJORES]: [token_provider_1.CUSD_CELO_ALFAJORES],
    [sdk_core_1.ChainId.GNOSIS]: [token_provider_1.USDC_ETHEREUM_GNOSIS],
    [sdk_core_1.ChainId.MOONBEAM]: [token_provider_1.USDC_MOONBEAM],
    [sdk_core_1.ChainId.BNB]: [token_provider_1.USDT_BNB, token_provider_1.USDC_BNB, token_provider_1.DAI_BNB],
    [sdk_core_1.ChainId.AVALANCHE]: [
        token_provider_1.DAI_AVAX,
        token_provider_1.USDC_AVAX,
        token_provider_1.USDC_NATIVE_AVAX,
        token_provider_1.USDC_BRIDGED_AVAX,
    ],
    [sdk_core_1.ChainId.BASE]: [token_provider_1.USDC_BASE, token_provider_1.USDC_NATIVE_BASE],
};
/**
 * Factory for building gas models that can be used with any route to generate
 * gas estimates.
 *
 * Factory model is used so that any supporting data can be fetched once and
 * returned as part of the model.
 *
 * @export
 * @abstract
 * @class IV2GasModelFactory
 */
class IV2GasModelFactory {
}
exports.IV2GasModelFactory = IV2GasModelFactory;
/**
 * Factory for building gas models that can be used with any route to generate
 * gas estimates.
 *
 * Factory model is used so that any supporting data can be fetched once and
 * returned as part of the model.
 *
 * @export
 * @abstract
 * @class IOnChainGasModelFactory
 */
class IOnChainGasModelFactory {
}
exports.IOnChainGasModelFactory = IOnChainGasModelFactory;
// Determines if native currency is token0
// Gets the native price of the pool, dependent on 0 or 1
// quotes across the pool
const getQuoteThroughNativePool = (chainId, nativeTokenAmount, nativeTokenPool) => {
    const nativeCurrency = util_1.WRAPPED_NATIVE_CURRENCY[chainId];
    const isToken0 = nativeTokenPool.token0.equals(nativeCurrency);
    // returns mid price in terms of the native currency (the ratio of token/nativeToken)
    const nativeTokenPrice = isToken0
        ? nativeTokenPool.token0Price
        : nativeTokenPool.token1Price;
    // return gas cost in terms of the non native currency
    return nativeTokenPrice.quote(nativeTokenAmount);
};
exports.getQuoteThroughNativePool = getQuoteThroughNativePool;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2FzLW1vZGVsLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL3JvdXRlcnMvYWxwaGEtcm91dGVyL2dhcy1tb2RlbHMvZ2FzLW1vZGVsLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUNBLGdEQUkyQjtBQUszQixzRUE2QzJDO0FBTzNDLHdDQUF3RDtBQVN4RCxnRUFBZ0U7QUFDaEUscUVBQXFFO0FBQ3JFLDRFQUE0RTtBQUMvRCxRQUFBLG1CQUFtQixHQUF1QztJQUNyRSxDQUFDLGtCQUFPLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyw0QkFBVyxFQUFFLDZCQUFZLEVBQUUsNkJBQVksQ0FBQztJQUM1RCxDQUFDLGtCQUFPLENBQUMsWUFBWSxDQUFDLEVBQUU7UUFDdEIsNkJBQVk7UUFDWiw4QkFBYTtRQUNiLHFDQUFvQjtRQUNwQiw4QkFBYTtLQUNkO0lBQ0QsQ0FBQyxrQkFBTyxDQUFDLFFBQVEsQ0FBQyxFQUFFO1FBQ2xCLDZCQUFZO1FBQ1osOEJBQWE7UUFDYixxQ0FBb0I7UUFDcEIsOEJBQWE7S0FDZDtJQUNELENBQUMsa0JBQU8sQ0FBQyxlQUFlLENBQUMsRUFBRTtRQUN6QixvQ0FBbUI7UUFDbkIscUNBQW9CO1FBQ3BCLHFDQUFvQjtLQUNyQjtJQUNELENBQUMsa0JBQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxFQUFFO1FBQzFCLHFDQUFvQjtRQUNwQixzQ0FBcUI7UUFDckIsc0NBQXFCO0tBQ3RCO0lBQ0QsQ0FBQyxrQkFBTyxDQUFDLGVBQWUsQ0FBQyxFQUFFLENBQUMscUNBQW9CLENBQUM7SUFDakQsQ0FBQyxrQkFBTyxDQUFDLGdCQUFnQixDQUFDLEVBQUUsQ0FBQyxzQ0FBcUIsQ0FBQztJQUNuRCxDQUFDLGtCQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQywyQkFBVSxFQUFFLDRCQUFXLEVBQUUsNEJBQVcsRUFBRSw0QkFBVyxDQUFDO0lBQ3JFLENBQUMsa0JBQU8sQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLDZCQUFZLEVBQUUsNEJBQVcsQ0FBQztJQUM5QyxDQUFDLGtCQUFPLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyw2QkFBWSxFQUFFLG9DQUFtQixDQUFDO0lBQ3RELENBQUMsa0JBQU8sQ0FBQyxjQUFjLENBQUMsRUFBRSxDQUFDLG1DQUFrQixDQUFDO0lBQzlDLENBQUMsa0JBQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLDBCQUFTLEVBQUUsMEJBQVMsRUFBRSxpQ0FBZ0IsRUFBRSxtQ0FBa0IsQ0FBQztJQUM1RSxDQUFDLGtCQUFPLENBQUMsY0FBYyxDQUFDLEVBQUUsQ0FBQyxvQ0FBbUIsQ0FBQztJQUMvQyxDQUFDLGtCQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxxQ0FBb0IsQ0FBQztJQUN4QyxDQUFDLGtCQUFPLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyw4QkFBYSxDQUFDO0lBQ25DLENBQUMsa0JBQU8sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLHlCQUFRLEVBQUUseUJBQVEsRUFBRSx3QkFBTyxDQUFDO0lBQzVDLENBQUMsa0JBQU8sQ0FBQyxTQUFTLENBQUMsRUFBRTtRQUNuQix5QkFBUTtRQUNSLDBCQUFTO1FBQ1QsaUNBQWdCO1FBQ2hCLGtDQUFpQjtLQUNsQjtJQUNELENBQUMsa0JBQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLDBCQUFTLEVBQUUsaUNBQWdCLENBQUM7Q0FDOUMsQ0FBQztBQWlGRjs7Ozs7Ozs7OztHQVVHO0FBQ0gsTUFBc0Isa0JBQWtCO0NBUXZDO0FBUkQsZ0RBUUM7QUFFRDs7Ozs7Ozs7OztHQVVHO0FBQ0gsTUFBc0IsdUJBQXVCO0NBYTVDO0FBYkQsMERBYUM7QUFFRCwwQ0FBMEM7QUFDMUMseURBQXlEO0FBQ3pELHlCQUF5QjtBQUNsQixNQUFNLHlCQUF5QixHQUFHLENBQ3ZDLE9BQWdCLEVBQ2hCLGlCQUEyQyxFQUMzQyxlQUE0QixFQUNaLEVBQUU7SUFDbEIsTUFBTSxjQUFjLEdBQUcsOEJBQXVCLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDeEQsTUFBTSxRQUFRLEdBQUcsZUFBZSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsY0FBYyxDQUFDLENBQUM7SUFDL0QscUZBQXFGO0lBQ3JGLE1BQU0sZ0JBQWdCLEdBQUcsUUFBUTtRQUMvQixDQUFDLENBQUMsZUFBZSxDQUFDLFdBQVc7UUFDN0IsQ0FBQyxDQUFDLGVBQWUsQ0FBQyxXQUFXLENBQUM7SUFDaEMsc0RBQXNEO0lBQ3RELE9BQU8sZ0JBQWdCLENBQUMsS0FBSyxDQUFDLGlCQUFpQixDQUFtQixDQUFDO0FBQ3JFLENBQUMsQ0FBQztBQWJXLFFBQUEseUJBQXlCLDZCQWFwQyJ9