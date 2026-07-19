"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { BoardToken, FearGreed, TokensPayload } from "@/lib/types";
import type { ConnectedWallet } from "@/lib/walletConnect";

export const tokenHref = (t: Pick<BoardToken, "chain" | "address">) =>
  `/token/${t.chain}/${encodeURIComponent(t.address)}`;

export interface AlertItem {
  key: string;
  symbol: string;
  cond: "pump" | "dump";
  pct: number;
}

export interface MyListing {
  symbol: string;
  name: string;
  emoji: string;
  chain: string;
  tier: string;
  status: "IN REVIEW";
}

interface AppState {
  data: TokensPayload | null;
  fng: FearGreed | null;
  watchlist: ReadonlySet<string>;
  toggleWatch: (key: string, symbol: string) => void;
  alerts: AlertItem[];
  addAlert: (a: AlertItem) => void;
  removeAlert: (i: number) => void;
  myListings: MyListing[];
  addListing: (l: MyListing) => void;
  wallet: ConnectedWallet | null;
  walletModalOpen: boolean;
  openWalletModal: () => void;
  closeWalletModal: () => void;
  setWalletConnected: (w: ConnectedWallet) => void;
  disconnectWallet: () => void;
  toastMsg: string | null;
  toast: (msg: string) => void;
  openDetail: (t: BoardToken) => void;
  tokenHref: (t: Pick<BoardToken, "chain" | "address">) => string;
  listingOpen: boolean;
  openListing: () => void;
  closeListing: () => void;
  homeQuery: string;
  setHomeQuery: (q: string) => void;
  reducedMotion: boolean;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / private mode — non-fatal */
  }
}

const POLL_TOKENS_MS = 30_000;
const POLL_FNG_MS = 5 * 60_000;

export function AppProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [data, setData] = useState<TokensPayload | null>(null);
  const [fng, setFng] = useState<FearGreed | null>(null);
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [myListings, setMyListings] = useState<MyListing[]>([]);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [listingOpen, setListingOpen] = useState(false);
  const [homeQuery, setHomeQuery] = useState("");
  const [reducedMotion, setReducedMotion] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // hydrate persisted client state (watchlist persistence moves to DB in Phase 2)
  useEffect(() => {
    setWatchlist(new Set(loadLocal<string[]>("watchlist", [])));
    setAlerts(loadLocal<AlertItem[]>("alerts", []));
    setMyListings(loadLocal<MyListing[]>("myListings", []));
    setWallet(loadLocal<ConnectedWallet | null>("wallet", null));
    setReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch("/api/tokens");
        if (res.ok && !stop) setData((await res.json()) as TokensPayload);
      } catch {
        /* keep last data */
      }
    };
    load();
    const id = setInterval(load, POLL_TOKENS_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch("/api/feargreed");
        if (res.ok && !stop) setFng((await res.json()) as FearGreed);
      } catch {
        /* keep last value */
      }
    };
    load();
    const id = setInterval(load, POLL_FNG_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2400);
  }, []);

  const toggleWatch = useCallback(
    (key: string, symbol: string) => {
      setWatchlist((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
          toast(`${symbol} removed from watchlist`);
        } else {
          next.add(key);
          toast(`${symbol} added to watchlist ⭐`);
        }
        saveLocal("watchlist", [...next]);
        return next;
      });
    },
    [toast],
  );

  const addAlert = useCallback((a: AlertItem) => {
    setAlerts((prev) => {
      const next = [...prev, a];
      saveLocal("alerts", next);
      return next;
    });
  }, []);

  const removeAlert = useCallback((i: number) => {
    setAlerts((prev) => {
      const next = prev.filter((_, k) => k !== i);
      saveLocal("alerts", next);
      return next;
    });
  }, []);

  const addListing = useCallback((l: MyListing) => {
    setMyListings((prev) => {
      const next = [...prev, l];
      saveLocal("myListings", next);
      return next;
    });
  }, []);

  const openWalletModal = useCallback(() => setWalletModalOpen(true), []);
  const closeWalletModal = useCallback(() => setWalletModalOpen(false), []);
  const setWalletConnected = useCallback(
    (w: ConnectedWallet) => {
      setWallet(w);
      saveLocal("wallet", w);
      setWalletModalOpen(false);
      toast(`${w.name} connected ✓`);
    },
    [toast],
  );
  const disconnectWallet = useCallback(() => {
    setWallet(null);
    saveLocal("wallet", null);
    toast("Wallet disconnected");
  }, [toast]);

  return (
    <Ctx.Provider
      value={{
        data,
        fng,
        watchlist,
        toggleWatch,
        alerts,
        addAlert,
        removeAlert,
        myListings,
        addListing,
        wallet,
        walletModalOpen,
        openWalletModal,
        closeWalletModal,
        setWalletConnected,
        disconnectWallet,
        toastMsg,
        toast,
        openDetail: (t) => router.push(tokenHref(t)),
        tokenHref,
        listingOpen,
        openListing: () => setListingOpen(true),
        closeListing: () => setListingOpen(false),
        homeQuery,
        setHomeQuery,
        reducedMotion,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
