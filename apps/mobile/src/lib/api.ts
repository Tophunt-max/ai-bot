import { createApiClient } from "@atb/api-client";
import Constants from "expo-constants";
import { useAccount } from "../stores/account";
import { useAuth } from "../stores/auth";

const baseUrl =
  process.env.EXPO_PUBLIC_API_BASE_URL ??
  (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl ??
  "http://localhost:8787";

export const api = createApiClient({
  baseUrl,
  getToken: () => useAuth.getState().token,
  getAccount: () => useAccount.getState().account,
  onUnauthorized: () => void useAuth.getState().signOut(),
});

export const qk = {
  portfolio: ["portfolio"] as const,
  account: ["account"] as const,
  positions: ["positions"] as const,
  orders: ["orders"] as const,
  trades: ["trades"] as const,
  signals: ["signals"] as const,
  strategies: ["strategies"] as const,
  risk: ["risk"] as const,
  brokers: ["brokers"] as const,
  session: ["session"] as const,
  audit: ["audit"] as const,
};
