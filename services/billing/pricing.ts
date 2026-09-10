// Single source of truth for what things cost. Imported by the browser (to price actions in
// the UI) and by the server (to charge for them), so nothing in here may import
// firebase-admin, Stripe, or anything else node-only.

/** What a user is charged for one complete action, as advertised in the UI. */
export const ACTION_PRICES = {
  /** Describe a plan in words: the AI draws it, then digitises it into CAD geometry. */
  generateAndConvert: 50,
  /** Upload a floorplan that already exists: digitisation only. */
  convertOnly: 25,
  /** One AI render. */
  render: 50,
  /** A Revit export or an APS Revit import. */
  revitJob: 25,
} as const;

// Those advertised prices are collected in two halves, because a generation and a
// conversion are two separate server calls and an upload only ever makes the second one.
// 25 + 25 gives the 50 for "generate and convert"; the conversion alone gives the 25 for
// "convert an existing floorplan". Charging this way means the price falls out of which
// work was actually done, with nothing for the client to declare or misreport.
export const STEP_COSTS = {
  /** Producing the floorplan image with the AI model. */
  floorplanGeneration: 25,
  /** Turning a floorplan image into CAD geometry. */
  floorplanConversion: 25,
  /** One AI render job (charged once, again on an explicit retry). */
  aiRender: 50,
  /** One Revit export or APS Revit import job. */
  revitJob: 25,
} as const;

export type SpendReason =
  | 'floorplan-generation'
  | 'floorplan-conversion'
  | 'ai-render'
  | 'revit-job';

/** Free tokens every account receives once. */
export const SIGNUP_GRANT_TOKENS = 100;

export interface TokenPack {
  id: string;
  tokens: number;
  priceUsd: number;
  /** Cents, for Stripe. Kept alongside priceUsd so the two can never drift. */
  priceCents: number;
}

export const TOKEN_PACKS: TokenPack[] = [
  { id: 'pack-100', tokens: 100, priceUsd: 9.99, priceCents: 999 },
  { id: 'pack-500', tokens: 500, priceUsd: 25.99, priceCents: 2599 },
  { id: 'pack-1000', tokens: 1000, priceUsd: 49.99, priceCents: 4999 },
];

export const getTokenPack = (packId: string): TokenPack | undefined =>
  TOKEN_PACKS.find(pack => pack.id === packId);

/** Free Cloud Storage per account. Beyond this, saves that need Storage are refused. */
export const FREE_STORAGE_BYTES = 5 * 1024 * 1024 * 1024;

export const formatTokens = (count: number): string =>
  `${count.toLocaleString()} token${count === 1 ? '' : 's'}`;

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

/** Status code used for "you are out of tokens" so the client can tell it from a 401. */
export const INSUFFICIENT_TOKENS_STATUS = 402;
