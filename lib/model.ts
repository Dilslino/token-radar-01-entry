// comparables-1 — the value model for the token launch radar.
//
// A protocol that records no token yet is worth what its record says it
// is worth. The model learns that worth from the market itself: for every
// category, the median ratio of market cap to TVL among that category's
// protocols whose token already trades. A category whose live tokens
// trade rich against TVL lends a rich multiple; a thin category lends a
// thin one. No protocol is ever named, listed, or exempted by hand —
// the same four factors score every row:
//
//   implied = TVL x category multiple x growth x maturity x breadth
//
//   multiple   median mcap/TVL of live-token peers in the category
//              (global median when a category has fewer than 3 peers),
//              clamped to [0.05, 3], fallback 0.25
//   growth     1 + clamp(7d TVL change, -50%, +100%) / 100 * 0.6
//   maturity   0.65 + min(age in days, 1095) / 1095 * 0.35
//              (unknown listing date counts as 365 days)
//   breadth    1 + 0.03 * min(chains - 1, 4)
//
// The board is the snapshot's whole watchlist (the floor) plus the
// strongest pre-token protocols below the floor, by TVL. Live-token
// protocols never rank; they are shown beside the board at the market's
// own value, and they are the comparables the multiples come from.

/** One protocol record: exactly the ten fields the sealed input carries. */
export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

/** The model's tunables. The dashboard prints them so a reader can check. */
export interface Cfg {
  growthWeight: number;
  growthLow: number;
  growthHigh: number;
  maturityBase: number;
  maturitySpan: number;
  maturityDays: number;
  unknownAgeDays: number;
  breadthStep: number;
  breadthCap: number;
  multipleLow: number;
  multipleHigh: number;
  minPeers: number;
  fallbackMultiple: number;
  earlyRows: number;
  liveRows: number;
}

export const CFG: Cfg = {
  growthWeight: 0.6,
  growthLow: -50,
  growthHigh: 100,
  maturityBase: 0.65,
  maturitySpan: 0.35,
  maturityDays: 1095,
  unknownAgeDays: 365,
  breadthStep: 0.03,
  breadthCap: 4,
  multipleLow: 0.05,
  multipleHigh: 3,
  minPeers: 3,
  fallbackMultiple: 0.25,
  earlyRows: 260,
  liveRows: 24,
};

/** The model label the dashboard shows. */
export const MODEL_LABEL = 'comparables-1';

/** One farm step: the action, what it costs, how long it takes. */
export interface Step {
  action: string;
  cost: string;
  time: string;
}

/** One ranked row of board.json. */
export interface Row {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row trimmed for the dashboard's data script. */
export interface SlimRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
}

/** A protocol whose token already trades: the market's value, not a model. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  model: Cfg;
  model_version: string;
  watchlist: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: SlimRow[];
  live: LiveRow[];
}

/** The snapshot is not shaped the way this model scores it. */
export class SnapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, or `fallback` when the value is missing or not finite. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `from` to `to`, never below zero; null when a date is missing or bad. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${asOf}T00:00:00Z`);
  const seen = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(seen)) return null;
  return Math.max(0, Math.floor((start - seen) / DAY_MS));
}

/** The median of a sorted list: the middle value, or the mean of the two middle ones. */
function medianOf(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The category multiples, learned from the snapshot itself: for each
 * category, the median mcap/TVL of its protocols whose token trades.
 * A category with fewer than `minPeers` live protocols falls back to
 * the global median. Every multiple is clamped into [low, high].
 */
export function peerMultiples(snap: Snap, cfg: Cfg = CFG): Map<string, number> {
  const perCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snap.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0 || p.mcap_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const key = p.category ?? '(no category)';
    const bucket = perCat.get(key);
    if (bucket === undefined) perCat.set(key, [ratio]);
    else bucket.push(ratio);
  }
  all.sort((a, b) => a - b);
  const global = Number.isFinite(medianOf(all)) ? medianOf(all) : cfg.fallbackMultiple;
  const clamp = (v: number): number => Math.min(cfg.multipleHigh, Math.max(cfg.multipleLow, v));
  const out = new Map<string, number>();
  for (const [key, ratios] of perCat) {
    ratios.sort((a, b) => a - b);
    out.set(key, ratios.length >= cfg.minPeers ? clamp(medianOf(ratios)) : clamp(global));
  }
  out.set('__global__', clamp(global));
  return out;
}

/** A protocol records no token at all: no market cap, no Gecko id, no symbol. */
export function hasNoToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A name ending in a version marker is a pool of another protocol, not a launch of its own. */
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether the board may rank a protocol: pre-token, not an exchange, not a versioned pool. */
export function canRank(p: Proto): boolean {
  return hasNoToken(p) && p.category !== 'CEX' && !VERSION_TAIL.test(p.name);
}

/** The implied value and every factor behind it, for one protocol. */
export function scoreProto(
  p: Proto,
  asOf: string,
  multiples: Map<string, number>,
  cfg: Cfg = CFG,
): { value: number; multiple: number; growthPct: number; growth: number; maturity: number; breadth: number; age: number | null } {
  const age = ageInDays(asOf, p.listed_at);
  const key = p.category ?? '(no category)';
  const multiple = multiples.get(key) ?? multiples.get('__global__') ?? cfg.fallbackMultiple;
  const rawGrowth = num(p.change_7d, 0);
  const growthPct = Math.min(cfg.growthHigh, Math.max(cfg.growthLow, rawGrowth));
  const growth = 1 + (growthPct / 100) * cfg.growthWeight;
  const ageUsed = age ?? cfg.unknownAgeDays;
  const maturity =
    cfg.maturityBase +
    (Math.min(Math.max(ageUsed, 0), cfg.maturityDays) / cfg.maturityDays) * cfg.maturitySpan;
  const extra = Math.min(Math.max(p.chains.length - 1, 0), cfg.breadthCap);
  const breadth = 1 + extra * cfg.breadthStep;
  const value = Math.max(1, Math.round(p.tvl_usd * multiple * growth * maturity * breadth));
  return { value, multiple, growthPct, growth, maturity, breadth, age };
}

/** The snapshot's protocols keyed by slug. */
function indexBySlug(protocols: Proto[]): Map<string, Proto> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The ranked board: every watchlist slug, plus early rows below the floor, strongest first. */
export function buildBoard(snap: Snap, cfg: Cfg = CFG): Row[] {
  const multiples = peerMultiples(snap, cfg);
  const index = indexBySlug(snap.protocols);
  const picked = new Map<string, Proto>();
  // The watchlist is the floor: every slug on it ranks, whatever its TVL.
  for (const slug of snap.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) picked.set(slug, p);
  }
  // The early radar: pre-token protocols under the floor, by TVL, capped.
  // A picked protocol stays picked; the early rows only add to the board.
  const early = snap.protocols
    .filter((p) => !picked.has(p.slug) && canRank(p) && p.tvl_usd < snap.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, cfg.earlyRows);
  for (const p of early) picked.set(p.slug, p);

  const scored = [...picked.values()].map((p) => {
    const s = scoreProto(p, snap.as_of, multiples, cfg);
    return { p, ...s };
  });
  scored.sort((a, b) => b.value - a.value || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.value,
    model: {
      category_multiple: round4(s.multiple),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growth),
      maturity_multiplier: round4(s.maturity),
      breadth_multiplier: round4(s.breadth),
      age_days: s.age,
    },
    farm_steps: planSteps(s.p, s.age).map(renderStep),
  }));
}

/** One farm step rendered as a single string: action, cost, time. */
export function renderStep(step: Step): string {
  let s = `${step.action} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: Proto): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The capital one farm position needs, scaled to the protocol's own TVL. */
function stakeFor(p: Proto): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** The hold window, from the protocol's age: younger protocols get longer. */
function holdFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core action, written so a farmer can follow it. */
function coreAction(p: Proto, stake: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${stake} of USDC on ${name} (${chain}) and leave the loan open.`;
  if (c.includes('dex')) return `Add $${stake} of liquidity to ${name}'s deepest pool on ${chain} and leave it in.`;
  if (c.includes('yield') || c.includes('leveraged farm')) return `Put $${stake} into ${name}'s main yield position on ${chain} and keep it running.`;
  if (c.includes('bridge')) return `Bridge $${stake} of USDC onto ${chain} through ${name}, then use the bridged funds inside its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${stake} of the chain asset through ${name} on ${chain} and hold the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Post $${stake} of USDC as margin on ${name} and open one small hedged trade.`;
  if (c.includes('prediction')) return `Fund $${stake} on ${name} and take one market position.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) return `Deposit $${stake} into a ${name} vault on ${chain} and hold the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${stake} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${stake} of the yield-bearing asset ${name} issues on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${stake} of cover from ${name} on ${chain} and keep the policy live.`;
  if (c.includes('nft') || c.includes('gaming')) return `Use $${stake} inside ${name} on ${chain}: play, mint or trade through its own app, not a marketplace.`;
  return `Deposit $${stake} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each with a cost and a time. Every
 * step is derived from the protocol's own record (category, chains, TVL,
 * age) — never from a hand-written list of names.
 */
export function planSteps(p: Proto, age: number | null): Step[] {
  const chain = firstChain(p);
  const stake = stakeFor(p);
  const hold = holdFor(age);
  const action = coreAction(p, stake, chain);
  const gas = stake >= 150 ? 8 : 4;
  return [
    {
      action: `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      action,
      cost: `$${stake} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      action: `Do one qualifying action every week — a deposit, a borrow, a swap or a vote — so the wallet reads as active.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      action: `Hold the position for at least ${hold} days, so the activity lands in more than one snapshot.`,
      cost: `the $${stake} stays in the position`,
      time: `${hold} days`,
    },
    {
      action: `Before withdrawing, open the protocol's own points or rewards page and claim only through the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      action: `Log the wallet, the dates and every transaction, so you can repeat the position or unwind it cleanly.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's live view. */
export function liveTable(snap: Snap, cfg: Cfg = CFG): LiveRow[] {
  return snap.protocols
    .filter((p) => !hasNoToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, cfg.liveRows)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row trimmed for data.js. */
export function slimRow(row: Row): SlimRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snap: Snap, cfg: Cfg = CFG): { board: Row[]; radar: RadarPayload } {
  const board = buildBoard(snap, cfg);
  const live = liveTable(snap, cfg);
  const early = board.filter((r) => !snap.watchlist.includes(r.slug)).length;
  const radar: RadarPayload = {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    model: cfg,
    model_version: MODEL_LABEL,
    watchlist: snap.watchlist,
    watchlist_size: snap.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(slimRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text; refused unless it has the shape the model scores. */
export function parseSnap(text: string): Snap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null when it is clean. */
export function boardProblem(board: Row[], snap: Snap): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** The dashboard's whole dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarPayload): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
