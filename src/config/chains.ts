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
  robinhood: {
    id: "robinhood",
    label: "Robinhood",
    color: "#CCFF00",
    geckoNetwork: null,
    goPlusChainId: null,
    explorer: (a) => `https://dexscreener.com/search?q=${a}`,
    buyUrl: (a) => `https://dexscreener.com/search?q=${a}`,
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
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
};

export const CHAIN_IDS = Object.keys(CHAINS);
export const chainOf = (id: string): ChainConfig | undefined => CHAINS[id];
