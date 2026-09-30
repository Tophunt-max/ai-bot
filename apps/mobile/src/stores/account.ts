import type { AccountId } from "@atb/shared-types";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { create } from "zustand";

const KEY = "atb.selected.account";

interface AccountStore {
  account: AccountId;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setAccount: (a: AccountId) => Promise<void>;
}

/**
 * Selected book. Defaults to DEMO on every fresh install so the app never opens on REAL money
 * by surprise. Persisted with SecureStore on native (memory only on web).
 */
export const useAccount = create<AccountStore>((set) => ({
  account: "demo",
  hydrated: false,
  hydrate: async () => {
    const v = Platform.OS === "web" ? null : await SecureStore.getItemAsync(KEY);
    set({ account: v === "real" ? "real" : "demo", hydrated: true });
  },
  setAccount: async (a) => {
    if (Platform.OS !== "web") await SecureStore.setItemAsync(KEY, a);
    set({ account: a });
  },
}));

export const ACCOUNT_THEME: Record<AccountId, { color: string; label: string; sub: string; emoji: string }> =
  {
    demo: { color: "#2d7ff9", label: "DEMO", sub: "Virtual money · real live market data", emoji: "🧪" },
    real: { color: "#e5484d", label: "REAL MONEY", sub: "Orders go to your broker", emoji: "💰" },
  };
