// Adding a chain = adding one entry here. Nothing else in the app may
// hardcode a chain id.
export interface ChainConfig {
  id: string;
  label: string;
  color: string;
  /** GeckoTerminal network id; null = no market-data provider coverage yet */
  geckoNetwork: string | null;
  /** GoPlus numeric chain id for EVM security scans; null = non-EVM */
  goPlusChainId: string | null;
  /** Address explorer URL for a token address */
  explorer: (address: string) => string;
  /** Buy deeplink — we never swap on-site, only deep-link out */
  buyUrl: (address: string) => string;
  /** Loose per-chain contract-address shape used for input validation */
  addressPattern: RegExp;
}

// Order here drives the chain-filter / selector order across the app:
// Solana → BSC → Ethereum → Base → Robinhood → Tron → TON.
export const CHAINS: Record<string, ChainConfig> = {
  solana: {
    id: "solana",
    label: "Solana",
    color: "#14F195",
    geckoNetwork: "solana",
    goPlusChainId: null,
    explorer: (a) => `https://solscan.io/token/${a}`,
    buyUrl: (a) => `https://jup.ag/swap/SOL-${a}`,
    addressPattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  },
  bsc: {
    id: "bsc",
    label: "BSC",
    color: "#F0B90B",
    geckoNetwork: "bsc",
    goPlusChainId: "56",
    explorer: (a) => `https://bscscan.com/token/${a}`,
    buyUrl: (a) => `https://pancakeswap.finance/swap?outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  ethereum: {
    id: "ethereum",
    label: "Ethereum",
    color: "#9AA5FF",
    geckoNetwork: "eth",
    goPlusChainId: "1",
    explorer: (a) => `https://etherscan.io/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=mainnet&outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  base: {
    id: "base",
    label: "Base",
    color: "#3B82F6",
    geckoNetwork: "base",
    goPlusChainId: "8453",
    explorer: (a) => `https://basescan.org/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=base&outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  robinhood: {
    id: "robinhood",
    label: "Robinhood",
    color: "#CCFF00",
    geckoNetwork: "robinhood", // GT indexes Robinhood Chain → live price/mcap/liq + chart embed
    goPlusChainId: null,
    explorer: (a) => `https://dexscreener.com/robinhood/${a}`,
    buyUrl: (a) => `https://dexscreener.com/robinhood/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  tron: {
    id: "tron",
    label: "Tron",
    color: "#FF060A",
    geckoNetwork: "tron",
    goPlusChainId: null, // GoPlus token_security doesn't cover Tron; scanner falls back to basic info
    explorer: (a) => `https://tronscan.org/#/token20/${a}`,
    buyUrl: (a) => `https://sunswap.com/#/home?tokenAddress=${a}`,
    addressPattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  },
  ton: {
    id: "ton",
    label: "TON",
    color: "#0098EA",
    geckoNetwork: "ton",
    goPlusChainId: null,
    explorer: (a) => `https://tonviewer.com/${a}`,
    buyUrl: (a) => `https://app.ston.fi/swap?ft=TON&tt=${a}`,
    addressPattern: /^(EQ|UQ|0:)[A-Za-z0-9_-]{40,66}$/,
  },
  sui: {
    id: "sui",
    label: "Sui",
    color: "#4DA2FF",
    geckoNetwork: "sui-network",
    goPlusChainId: null,
    explorer: (a) => `https://suivision.xyz/coin/${encodeURIComponent(a)}`,
    buyUrl: (a) => `https://app.cetus.zone/swap/?to=${encodeURIComponent(a)}`,
    // Sui coin type: 0x<hex>::module::SYMBOL (bare object addresses accepted)
    addressPattern: /^0x[a-fA-F0-9]{1,64}(::[A-Za-z0-9_]+){0,2}$/,
  },
  plasma: {
    id: "plasma",
    label: "Plasma",
    color: "#00FF9C",
    geckoNetwork: "plasma",
    goPlusChainId: null,
    explorer: (a) => `https://dexscreener.com/plasma/${a}`,
    buyUrl: (a) => `https://dexscreener.com/plasma/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  // ── More EVM chains (billed in BNB by the bot via BSC). Registered here so
  //    listings validate + render + get live market data; settlement currency
  //    for the web price display lives in src/lib/packages.ts (NATIVE map). ──
  polygon: {
    id: "polygon",
    label: "Polygon",
    color: "#8247E5",
    geckoNetwork: "polygon_pos",
    goPlusChainId: "137",
    explorer: (a) => `https://polygonscan.com/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=polygon&outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  arbitrum: {
    id: "arbitrum",
    label: "Arbitrum",
    color: "#28A0F0",
    geckoNetwork: "arbitrum",
    goPlusChainId: "42161",
    explorer: (a) => `https://arbiscan.io/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=arbitrum&outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  optimism: {
    id: "optimism",
    label: "Optimism",
    color: "#FF0420",
    geckoNetwork: "optimism",
    goPlusChainId: "10",
    explorer: (a) => `https://optimistic.etherscan.io/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=optimism&outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  avalanche: {
    id: "avalanche",
    label: "Avalanche",
    color: "#E84142",
    geckoNetwork: "avax",
    goPlusChainId: "43114",
    explorer: (a) => `https://snowtrace.io/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=avalanche&outputCurrency=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  berachain: {
    id: "berachain",
    label: "Berachain",
    color: "#B8651B",
    geckoNetwork: "berachain",
    goPlusChainId: null,
    explorer: (a) => `https://berascan.com/token/${a}`,
    buyUrl: (a) => `https://dexscreener.com/berachain/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  sonic: {
    id: "sonic",
    label: "Sonic",
    color: "#5AB8F0",
    geckoNetwork: "sonic",
    goPlusChainId: null,
    explorer: (a) => `https://sonicscan.org/token/${a}`,
    buyUrl: (a) => `https://dexscreener.com/sonic/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  hyperevm: {
    id: "hyperevm",
    label: "HyperEVM",
    color: "#4FD1C5",
    geckoNetwork: "hyperevm",
    goPlusChainId: null,
    explorer: (a) => `https://dexscreener.com/hyperevm/${a}`,
    buyUrl: (a) => `https://dexscreener.com/hyperevm/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  abstract: {
    id: "abstract",
    label: "Abstract",
    color: "#3CE68B",
    geckoNetwork: "abstract",
    goPlusChainId: null,
    explorer: (a) => `https://abscan.org/token/${a}`,
    buyUrl: (a) => `https://dexscreener.com/abstract/${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
};

export const CHAIN_IDS = Object.keys(CHAINS);
export const chainOf = (id: string): ChainConfig | undefined => CHAINS[id];
