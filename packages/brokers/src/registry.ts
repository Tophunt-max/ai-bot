import type { BrokerId } from "@atb/shared-types";

export type AuthFlow = "NONE" | "OAUTH_REDIRECT" | "TOTP_LOGIN" | "STATIC_TOKEN" | "SESSION_KEY";
export type AdapterStatus = "implemented" | "planned";

export interface BrokerInfo {
  id: BrokerId;
  name: string;
  auth: AuthFlow;
  /** Daily re-login required (token expires every trading day). */
  dailyLogin: boolean;
  /** Broker binds API session to the IP it was created from (create session on the gateway!). */
  sessionBoundToIp: boolean | "unknown";
  /** Underlying OMS family — brokers sharing an OMS can share one adapter. */
  family?: "NOREN" | "XTS";
  docsUrl?: string;
  /** docsUrl confirmed by the maintainers; others must be confirmed with the broker. */
  docsVerified: boolean;
  adapter: AdapterStatus;
  notes?: string;
}

/**
 * All mainstream Indian retail brokers with public trading APIs.
 * Common rules (SEBI retail-algo framework, from 1 Apr 2026): order APIs only from a
 * whitelisted static IP (max 2: primary + secondary, change ~once a week), no MARKET
 * orders from algos (use protected LIMIT), and stay below the ~10 orders/sec threshold.
 * Always re-check each broker's current terms before going LIVE.
 */
export const BROKERS: Record<BrokerId, BrokerInfo> = {
  paper: {
    id: "paper",
    name: "Paper Broker (simulated)",
    auth: "NONE",
    dailyLogin: false,
    sessionBoundToIp: false,
    docsVerified: true,
    adapter: "implemented",
  },
  crypto: {
    id: "crypto",
    name: "Crypto exchanges via CCXT (100+ venues)",
    auth: "STATIC_TOKEN",
    dailyLogin: false,
    sessionBoundToIp: false,
    docsUrl: "https://docs.ccxt.com/",
    docsVerified: true,
    adapter: "implemented",
    notes: "Venue per instrument (binance, kucoin, delta, zebpay…). Not SEBI-regulated; see docs/crypto.md.",
  },
  zerodha: {
    id: "zerodha",
    name: "Zerodha Kite Connect",
    auth: "OAUTH_REDIRECT",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsUrl: "https://kite.trade/docs/connect/v3/",
    docsVerified: true,
    adapter: "implemented",
    notes: "Paid API subscription. IP whitelist in developer console Profile > IP Whitelist.",
  },
  upstox: {
    id: "upstox",
    name: "Upstox API v2",
    auth: "OAUTH_REDIRECT",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsUrl: "https://upstox.com/developer/api-documentation/",
    docsVerified: true,
    adapter: "implemented",
  },
  dhan: {
    id: "dhan",
    name: "DhanHQ v2",
    auth: "STATIC_TOKEN",
    dailyLogin: false,
    sessionBoundToIp: "unknown",
    docsUrl: "https://dhanhq.co/docs/v2/",
    docsVerified: true,
    adapter: "implemented",
    notes: "Access token generated from web portal with a validity period; correlationId gives idempotency.",
  },
  angelone: {
    id: "angelone",
    name: "Angel One SmartAPI",
    auth: "TOTP_LOGIN",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsUrl: "https://smartapi.angelbroking.com/docs",
    docsVerified: true,
    adapter: "planned",
  },
  fyers: {
    id: "fyers",
    name: "Fyers API v3",
    auth: "OAUTH_REDIRECT",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsUrl: "https://myapi.fyers.in/docsv3",
    docsVerified: true,
    adapter: "planned",
  },
  kotakneo: {
    id: "kotakneo",
    name: "Kotak Neo Trade API",
    auth: "TOTP_LOGIN",
    dailyLogin: true,
    sessionBoundToIp: true,
    docsUrl: "https://github.com/Kotak-Neo/Kotak-Neo",
    docsVerified: true,
    adapter: "planned",
    notes: "Session must be created from the same whitelisted IP that sends orders.",
  },
  icicidirect: {
    id: "icicidirect",
    name: "ICICI Direct Breeze",
    auth: "SESSION_KEY",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsUrl: "https://api.icicidirect.com/breezeapi/documents/index.html",
    docsVerified: true,
    adapter: "planned",
  },
  fivepaisa: {
    id: "fivepaisa",
    name: "5paisa Xtream API",
    auth: "TOTP_LOGIN",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsUrl: "https://www.5paisa.com/developerapi",
    docsVerified: false,
    adapter: "planned",
  },
  shoonya: {
    id: "shoonya",
    name: "Shoonya (Finvasia) NorenAPI",
    auth: "OAUTH_REDIRECT",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    family: "NOREN",
    docsUrl: "https://www.shoonya.com/api-documentation",
    docsVerified: true,
    adapter: "planned",
  },
  flattrade: {
    id: "flattrade",
    name: "Flattrade (Noren)",
    auth: "OAUTH_REDIRECT",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    family: "NOREN",
    docsVerified: false,
    adapter: "planned",
  },
  zebu: {
    id: "zebu",
    name: "Zebu (Noren)",
    auth: "TOTP_LOGIN",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    family: "NOREN",
    docsVerified: false,
    adapter: "planned",
  },
  tradejini: {
    id: "tradejini",
    name: "Tradejini CubePlus",
    auth: "TOTP_LOGIN",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsVerified: false,
    adapter: "planned",
  },
  aliceblue: {
    id: "aliceblue",
    name: "Alice Blue ANT API",
    auth: "TOTP_LOGIN",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsVerified: false,
    adapter: "planned",
  },
  iifl: {
    id: "iifl",
    name: "IIFL Securities (XTS)",
    auth: "SESSION_KEY",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    family: "XTS",
    docsVerified: false,
    adapter: "planned",
  },
  groww: {
    id: "groww",
    name: "Groww Trade API",
    auth: "STATIC_TOKEN",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsVerified: false,
    adapter: "planned",
  },
  motilaloswal: {
    id: "motilaloswal",
    name: "Motilal Oswal Open API",
    auth: "TOTP_LOGIN",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsVerified: false,
    adapter: "planned",
  },
  paytmmoney: {
    id: "paytmmoney",
    name: "Paytm Money Open API",
    auth: "OAUTH_REDIRECT",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsVerified: false,
    adapter: "planned",
  },
  nuvama: {
    id: "nuvama",
    name: "Nuvama API Connect",
    auth: "OAUTH_REDIRECT",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsVerified: false,
    adapter: "planned",
  },
  samco: {
    id: "samco",
    name: "SAMCO Trade API",
    auth: "TOTP_LOGIN",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsVerified: false,
    adapter: "planned",
  },
  mstock: {
    id: "mstock",
    name: "m.Stock (Mirae Asset) Trading API",
    auth: "TOTP_LOGIN",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsVerified: false,
    adapter: "planned",
  },
  definedge: {
    id: "definedge",
    name: "Definedge Integrate API",
    auth: "TOTP_LOGIN",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsVerified: false,
    adapter: "planned",
  },
  sharekhan: {
    id: "sharekhan",
    name: "Sharekhan TradeSmart API",
    auth: "OAUTH_REDIRECT",
    dailyLogin: true,
    sessionBoundToIp: "unknown",
    docsVerified: false,
    adapter: "planned",
  },
};

export function listBrokers(): BrokerInfo[] {
  return Object.values(BROKERS);
}
