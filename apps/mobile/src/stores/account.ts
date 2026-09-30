import {
  ACCOUNT_INFO,
  accountFor,
  isAccountId,
  type AccountId,
  type AccountKind,
  type Market,
} from "@atb/shared-types";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { create } from "zustand";

const KEY = "atb.selected.account";

interface AccountStore {
  account: AccountId;
  market: Market;
  kind: AccountKind;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setAccount: (a: AccountId) => Promise<void>;
}

/**
 * Selected book = market (Stocks | Crypto) × kind (Demo | Real). Fresh installs always open on
 * Stocks DEMO so the app never lands on real money by surprise. SecureStore on native, memory on web.
 */
export const useAccount = create<AccountStore>((set) => ({
  account: "demo",
  market: "STOCKS",
  kind: "DEMO",
  hydrated: false,
  hydrate: async () => {
    const v = Platform.OS === "web" ? null : await SecureStore.getItemAsync(KEY);
    const account: AccountId = isAccountId(v) ? v : "demo";
    set({ account, ...ACCOUNT_INFO[account], hydrated: true });
  },
  setAccount: async (a) => {
    if (Platform.OS !== "web") await SecureStore.setItemAsync(KEY, a);
    set({ account: a, ...ACCOUNT_INFO[a] });
  },
}));

export const selectAccount = (market: Market, kind: AccountKind) => accountFor(market, kind);

export const ACCOUNT_THEME: Record<
  AccountId,
  { color: string; label: string; sub: string; emoji: string; currency: string }
> = {
  demo: {
    color: "#2d7ff9",
    label: "STOCKS · DEMO",
    sub: "Virtual ₹ · real live NSE/BSE data",
    emoji: "🧪",
    currency: "INR",
  },
  real: {
    color: "#e5484d",
    label: "STOCKS · REAL MONEY",
    sub: "Orders go to your stock broker",
    emoji: "💰",
    currency: "INR",
  },
  crypto_demo: {
    color: "#8e4ec6",
    label: "CRYPTO · DEMO",
    sub: "Virtual USDT · real live exchange data · 24x7",
    emoji: "🧪",
    currency: "USDT",
  },
  crypto_real: {
    color: "#f76b15",
    label: "CRYPTO · REAL MONEY",
    sub: "Orders go to your crypto exchange · 24x7",
    emoji: "🪙",
    currency: "USDT",
  },
};
