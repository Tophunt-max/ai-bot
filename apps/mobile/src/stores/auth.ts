import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { create } from "zustand";

const KEY = "atb.session.token";

/**
 * Session JWT only. Broker secrets NEVER live on the device.
 * Native: Expo SecureStore (Keychain / Android Keystore). Web: memory only (no localStorage).
 */
const storage = {
  async get(): Promise<string | null> {
    if (Platform.OS === "web") return null;
    return SecureStore.getItemAsync(KEY);
  },
  async set(v: string): Promise<void> {
    if (Platform.OS !== "web") await SecureStore.setItemAsync(KEY, v);
  },
  async clear(): Promise<void> {
    if (Platform.OS !== "web") await SecureStore.deleteItemAsync(KEY);
  },
};

interface AuthState {
  token: string | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  token: null,
  hydrated: false,
  hydrate: async () => set({ token: await storage.get(), hydrated: true }),
  signIn: async (token) => {
    await storage.set(token);
    set({ token });
  },
  signOut: async () => {
    await storage.clear();
    set({ token: null });
  },
}));
