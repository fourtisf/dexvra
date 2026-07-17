"use client";

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
  wallet: string | null;
  toggleWallet: () => void;
  toastMsg: string | null;
  toast: (msg: string) => void;
  detailToken: BoardToken | null;
  openDetail: (t: BoardToken) => void;
  closeDetail: () => void;
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
  const [data, setData] = useState<TokensPayload | null>(null);
  const [fng, setFng] = useState<FearGreed | null>(null);
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [myListings, setMyListings] = useState<MyListing[]>([]);
  const [wallet, setWallet] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [detailToken, setDetailToken] = useState<BoardToken | null>(null);
  const [listingOpen, setListingOpen] = useState(false);
  const [homeQuery, setHomeQuery] = useState("");
  const [reducedMotion, setReducedMotion] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // hydrate persisted client state (watchlist persistence moves to DB in Phase 2)
  useEffect(() => {
    setWatchlist(new Set(loadLocal<string[]>("watchlist", [])));
    setAlerts(loadLocal<AlertItem[]>("alerts", []));
    setMyListings(loadLocal<MyListing[]>("myListings", []));
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

  const toggleWallet = useCallback(() => {
    // Demo connect only — real SIWS wallet auth lands in Phase 2.
    setWallet((prev) => {
      const next = prev ? null : "FxK3…9dQ2";
      toast(next ? "Wallet connected ✓ (demo)" : "Wallet disconnected");
      return next;
    });
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
        toggleWallet,
        toastMsg,
        toast,
        detailToken,
        openDetail: setDetailToken,
        closeDetail: () => setDetailToken(null),
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
