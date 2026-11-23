#!/usr/bin/env node
/**
 * Patient dip buyer for make.fun btc-race-24h-20261123-0511.
 *
 * Trades Coinbase Wrapped BTC (cbBTC) against USDC, one 1-minute bar at a
 * time, speaking agent-fun/bars-replay/v1: one JSON line in per batch, one
 * reply with orders out. Standard library only (node:readline), no network,
 * no wall clock, no files, no randomness: every decision is exact bigint
 * arithmetic on the closes the harness has sent, so two runs on the same
 * data answer byte for byte alike. A batch with no CBBTC bar is a gap
 * minute: the close is stale, so no new decision is taken on it.
 *
 * Strategy: mean reversion against the trailing 120-bar (2-hour) mean of
 * closes. A full-size round trip pays about 26 bps in fee, slippage and
 * price impact, so the bot waits for a real dislocation and then lets the
 * recovery run:
 *
 * - Flat and the latest close is at least 60 bps below the 120-bar mean
 *   -> buy with all cash on hand.
 * - Holding and the close has recovered to at least 55 bps above the
 *   120-bar mean -> sell the whole position.
 * - Holding and the close has fallen at least 150 bps below the price
 *   the buy filled at -> sell the whole position (stop-loss).
 *
 * Tuned on the frozen 24-hour dev window, split into six 4-hour folds:
 * the plateau n in {100, 120, 140}, entry in {55, 60, 65, 70} bps,
 * exit in {50, 55, 60} bps is positive throughout (+$13 to +$25 net,
 * 3-5 of 6 folds positive, max drawdown under 1%); the shipped cell
 * (120, 60, 55) sits in its centre. The simple EMA-cross momentum
 * variant was tested on the same folds and lost about $35, so it was
 * dropped: this window whipsaws a cross badly.
 */

import { createInterface } from "node:readline";

const SYMBOL = "CBBTC";

// Strategy parameters (basis points; 10_000 bps = 100%).
const MEAN_BARS = 120; // bars in the trailing mean of closes
const ENTRY_BPS = 60n; // buy when the close is this far below the mean
const EXIT_BPS = 55n; // sell when the close is this far above the mean
const STOP_BPS = 150n; // sell when the close is this far below the fill
const MAX_SLIPPAGE_BPS = 150; // bound on the move from the latest close

// One USDC in the harness's quote units (micro-USDC, quote_scale 6).
const MIN_NOTIONAL = 1_000_000n;

const BPS = 10_000n;

interface Bar {
  symbol: string;
  c: string;
}

interface Fill {
  symbol: string;
  side: string;
  status: string;
  price: string;
}

interface Position {
  symbol: string;
  qty: string;
  cost_quote_units: string;
}

async function main(): Promise<void> {
  const closes: bigint[] = []; // every CBBTC close seen, raw price units
  let windowSum = 0n; // sum of the closes inside the mean window
  let cash = 0n; // micro-USDC on hand, from the account
  let positionQty = 0n; // CBBTC held, raw qty units (qty_scale 8)
  let entryPrice: bigint | null = null; // raw price the open buy filled at
  let warmupBars = 0; // hello's warm-up batches, if it has any
  let nextClientId = 1;

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const msg = JSON.parse(line) as Record<string, unknown>;
    const kind = msg.type as string;

    if (kind === "hello") {
      const capital = msg.capital as { quote_units: string };
      cash = BigInt(capital.quote_units);
      warmupBars = Number(msg.warmup_bars ?? 0);
      continue;
    }

    if (kind === "done") break;

    if (kind !== "batch") {
      // Unknown message: the protocol has only hello, batch, done.
      throw new Error(`unexpected message type: ${kind}`);
    }

    const seq = msg.seq as number;

    // Fills first: they report what the orders of the previous batch
    // did, and the account in this batch already reflects them.
    for (const fill of (msg.fills as Fill[] | undefined) ?? []) {
      if (fill.symbol !== SYMBOL || fill.status !== "filled") continue;
      if (fill.side === "buy") entryPrice = BigInt(fill.price);
      else if (fill.side === "sell") entryPrice = null;
    }

    // Fold this batch's bar into the close history. A batch with no
    // CBBTC bar is a gap minute: the close is stale, so no new decision
    // is taken on it (the bot still answers with an empty reply).
    let sawBar = false;
    for (const bar of (msg.bars as Bar[] | undefined) ?? []) {
      if (bar.symbol !== SYMBOL) continue;
      sawBar = true;
      const close = BigInt(bar.c);
      closes.push(close);
      windowSum += close;
      if (closes.length > MEAN_BARS) {
        windowSum -= closes[closes.length - MEAN_BARS - 1] as bigint;
      }
    }

    // The account is authoritative for cash and position.
    const account = msg.account as {
      cash_quote_units: string;
      positions: Position[];
    };
    cash = BigInt(account.cash_quote_units);
    positionQty = 0n;
    let positionCost = 0n;
    for (const pos of account.positions ?? []) {
      if (pos.symbol === SYMBOL) {
        positionQty = BigInt(pos.qty);
        positionCost = BigInt(pos.cost_quote_units);
      }
    }
    if (positionQty === 0n) {
      entryPrice = null;
    } else if (entryPrice === null && positionCost > 0n) {
      // No fill seen for this position (defensive): infer the entry
      // from its cost, value = qty * price / 10**7.
      entryPrice = (positionCost * 10_000_000n) / positionQty;
    }

    const orders: Record<string, unknown>[] = [];
    const warmingUp = seq < warmupBars;
    if (!warmingUp && sawBar && closes.length >= MEAN_BARS) {
      const close = closes[closes.length - 1] as bigint;
      const meanX = windowSum; // mean * MEAN_BARS, exact integers
      const n = BigInt(MEAN_BARS);
      // Dip in bps: (mean - close) / mean * 10000 >= ENTRY_BPS
      //   <=> 10000 * (meanX - n * close) >= ENTRY_BPS * meanX
      const dip = BPS * (meanX - n * close) >= ENTRY_BPS * meanX;
      // Recovery in bps: close / mean - 1 >= EXIT_BPS / 10000
      //   <=> n * close * 10000 >= meanX * (10000 + EXIT_BPS)
      const recovered = n * close * BPS >= meanX * (BPS + EXIT_BPS);

      if (positionQty === 0n) {
        if (dip && cash >= MIN_NOTIONAL) {
          orders.push({
            side: "buy",
            client_id: `o${nextClientId++}`,
            symbol: SYMBOL,
            notional_quote_units: cash.toString(),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
        }
      } else {
        // Stop-loss in bps: close <= entry * (1 - STOP_BPS / 10000)
        const stopped =
          entryPrice !== null &&
          close * BPS <= entryPrice * (BPS - STOP_BPS);
        if (recovered || stopped) {
          orders.push({
            side: "sell",
            client_id: `o${nextClientId++}`,
            symbol: SYMBOL,
            qty: positionQty.toString(),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
        }
      }
    }

    process.stdout.write(
      JSON.stringify({ type: "reply", seq, orders }) + "\n",
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
