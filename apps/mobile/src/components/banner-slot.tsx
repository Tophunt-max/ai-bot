import { useAuth } from "../stores/auth";
import { AccountBanner } from "./account";

/** Renders the DEMO/REAL banner only for signed-in screens (avoids a circular import in ui.tsx). */
export function BannerSlot() {
  const token = useAuth((s) => s.token);
  return token ? <AccountBanner /> : null;
}
