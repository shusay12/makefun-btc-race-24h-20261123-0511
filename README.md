# Patient Dip Buyer — btc-race-24h-20261123-0511

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/shusay12/makefun-btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/shusay12/makefun-btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A paper-money trading bot for make.fun's 24-hour cbBTC race
(`btc-race-24h-20261123-0511`), speaking the `agent-fun/bars-replay/v1`
protocol: one JSON line in per 1-minute bar of Coinbase Wrapped BTC
(cbBTC) in USDC from its Orca Whirlpool on Solana, one reply with
orders out. It starts with $1,000 of paper money, long only, at most
one open position.

## Strategy

Mean reversion against the trailing 120-bar (2-hour) mean of closes.
A full-size round trip pays about 26 bps in fee, slippage and price
impact, so the bot waits for a real dislocation and then lets the
recovery run:

- Flat and the latest close is at least **60 bps below** the 120-bar
  mean → buy with all cash on hand.
- Holding and the close has recovered to at least **55 bps above** the
  120-bar mean → sell the whole position.
- Holding and the close has fallen at least **150 bps below** the price
  the buy filled at → sell the whole position (stop-loss).

Every decision is exact integer arithmetic on the closes the harness
has sent — no floats, no clock, no network, no files, no randomness —
so two runs on the same data answer byte for byte alike.

## Tuning

Tuned on the frozen 24-hour dev window, split into six 4-hour folds.
The plateau with n in {100, 120, 140} bars, entry in {55, 60, 65, 70}
bps and exit in {50, 55, 60} bps is positive throughout (+$13 to +$25
net, 3–5 of 6 folds positive, max drawdown under 1%); the shipped
cell (120, 60, 55) sits in its centre. A simple EMA-cross momentum
variant was tested on the same folds and lost about $35 — this window
whipsaws a cross badly — so it was dropped.

Local grade on the dev window (`grade-local --driver process`):

- Net PnL: **+$25.03** (dev gate: above $0, so it races)
- Trades: 6 (3 round trips, all winners)
- Max drawdown: 0.6%
- Determinism: two runs produce byte-identical action logs

## Run it

Node 22, standard library only — the grader runs `node main.ts`
(TypeScript through type stripping, erasable syntax only):

```sh
node main.ts
```

It reads `hello`, then one `batch` per minute, from stdin, and writes
exactly one `reply` per batch to stdout.

## License

MIT — see [LICENSE](LICENSE).
