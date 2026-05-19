# Tilt — Risk Profiles & Strategies

Source of truth: [`lib/tilt.ts`](./lib/tilt.ts). The dial maps a risk score (0–100) to one of five discrete profiles. Each profile defines an asset-class allocation and a routing map of execution venues per asset class.

## Asset classes

| Key | Name | Category |
| --- | --- | --- |
| `LEND` | Stable Lending | Stablecoin yield |
| `SPOT` | BTC / ETH / SOL | Blue-chip spot |
| `LST` | Liquid Staking | Staked majors |
| `DEFI` | DeFi Tokens | Protocol exposure |
| `YIELD` | Yield Trading | Structured yield |
| `RESTAKE` | Restaking | Compounded yield |
| `MEME` | Memecoins | High beta |
| `PERP` | Perps | Leveraged |

## Profiles at a glance

| Risk band | Profile | Tag | LEND | SPOT | LST | DEFI | YIELD | RESTAKE | MEME | PERP |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0–20 | Stable Lender | Low | 100% | — | — | — | — | — | — | — |
| 21–40 | Conservative Yield | Cautious | 65% | 25% | 10% | — | — | — | — | — |
| 41–60 | Balanced DeFi | Moderate | 35% | 25% | 15% | 10% | 10% | 5% | — | — |
| 61–80 | Aggressive Growth | High | 15% | 20% | 10% | 20% | 10% | 20% | 5% | — |
| 81–100 | Max Speculation | Extreme | 5% | 10% | — | 10% | — | 10% | 35% | 30% |

12-month projections (interpolated linearly with risk) — at the band midpoints:

| Profile | Expected | P10 (downside) | P90 (upside) | Annualized vol |
| --- | ---: | ---: | ---: | ---: |
| Stable Lender (r=10) | +9% | −8% | +16% | 14% |
| Conservative Yield (r=30) | +14% | −17% | +24% | 24% |
| Balanced DeFi (r=50) | +19% | −26% | +35% | 35% |
| Aggressive Growth (r=70) | +24% | −35% | +47% | 46% |
| Max Speculation (r=90) | +29% | −44% | +58% | 56% |

---

## 1. Stable Lender — risk 0–20

> Capital stays in stablecoin lending only, routed across the top lending venues for depth and resilience.

**Allocation:** 100% `LEND`

**Routing:**

| Asset | Venues |
| --- | --- |
| LEND | Aave V3, Morpho Blue, SparkLend |

**Blocked:** Volatile spot · LP positions · Restaking · Memecoins · Perps

---

## 2. Conservative Yield — risk 21–40

> Stablecoin yield remains the anchor, with measured exposure to blue-chip spot and ETH liquid staking.

**Allocation:** 65% `LEND` · 25% `SPOT` · 10% `LST`

**Routing:**

| Asset | Venues |
| --- | --- |
| LEND | Aave V3, Morpho Blue, SparkLend, Compound V3 |
| SPOT | Uniswap |
| LST | Lido, Rocket Pool |

**Blocked:** Restaking · Memecoins · Perps

---

## 3. Balanced DeFi — risk 41–60

> A balanced DeFi mix across stable lending, blue-chip spot, liquid staking, and mature protocol exposure.

**Allocation:** 35% `LEND` · 25% `SPOT` · 15% `LST` · 10% `DEFI` · 10% `YIELD` · 5% `RESTAKE`

**Routing:**

| Asset | Venues |
| --- | --- |
| LEND | Aave V3, Morpho Blue, SparkLend, Compound V3 |
| SPOT | Uniswap, Jupiter |
| LST | Lido, Rocket Pool, Jito |
| DEFI | Uniswap, Curve, Balancer |
| YIELD | Pendle |
| RESTAKE | ether.fi |

**Blocked:** Memecoins · Perps

---

## 4. Aggressive Growth — risk 61–80

> Higher-beta DeFi, Solana ecosystem exposure, and restaking enter the strategy while leverage remains out of scope.

**Allocation:** 15% `LEND` · 20% `SPOT` · 10% `LST` · 20% `DEFI` · 10% `YIELD` · 20% `RESTAKE` · 5% `MEME`

**Routing:**

| Asset | Venues |
| --- | --- |
| LEND | Aave V3, Morpho Blue |
| SPOT | Uniswap, Jupiter |
| LST | Lido, Rocket Pool, Jito |
| DEFI | Uniswap, Aerodrome, Kamino, Jupiter |
| YIELD | Pendle |
| RESTAKE | ether.fi, EigenLayer, Renzo, Kelp DAO |
| MEME | Raydium, Aerodrome |

**Blocked:** Leveraged perps · Pre-migration memecoin launches

---

## 5. Max Speculation — risk 81–100

> Capital targets liquid memecoins, high-beta spot, and perpetual futures with a small cash buffer for execution.

**Allocation:** 5% `LEND` · 10% `SPOT` · 10% `DEFI` · 10% `RESTAKE` · 35% `MEME` · 30% `PERP`

**Routing:**

| Asset | Venues |
| --- | --- |
| LEND | Aave V3 |
| SPOT | Uniswap, Jupiter |
| DEFI | Uniswap, Jupiter, Aerodrome |
| RESTAKE | ether.fi, EigenLayer |
| MEME | Uniswap, Raydium, Jupiter, Aerodrome, Pump.fun, Meteora |
| PERP | Hyperliquid, Jupiter Perps, GMX v2, dYdX v4, Lighter |

**Blocked:** _none_

---

## Platform reference

| Platform | Category | Networks | Instruments | Role |
| --- | --- | --- | --- | --- |
| Aave V3 | Stablecoin lending | Ethereum, Base, Arbitrum | USDC, USDT, DAI | Primary stablecoin lending market. |
| Morpho Blue | Stablecoin lending | Ethereum, Base | Curated USDC / USDT vaults | Isolated stablecoin lending through curated vaults. |
| SparkLend | Stablecoin lending | Ethereum | USDC, DAI, USDS | Sky-aligned stablecoin lending and reserve yield. |
| Compound V3 | Stablecoin lending | Ethereum, Base, Arbitrum | USDC, USDT | Secondary stablecoin lending venue. |
| Lido | Liquid staking | Ethereum | stETH, wstETH | Core ETH liquid staking exposure. |
| Rocket Pool | Liquid staking | Ethereum | rETH | Decentralized ETH liquid staking exposure. |
| Jito | Solana DeFi | Solana | JitoSOL | Solana liquid staking exposure. |
| ether.fi | Restaking | Ethereum | eETH, weETH | Liquid restaking and higher-yield ETH exposure. |
| EigenLayer | Restaking | Ethereum | Restaked ETH, AVS exposure | Native restaking exposure. |
| Renzo | Restaking | Ethereum, Arbitrum | ezETH | Liquid restaking diversification. |
| Kelp DAO | Restaking | Ethereum | rsETH | Liquid restaking diversification. |
| Uniswap | DeFi liquidity | Ethereum, Base, Arbitrum | ETH, WBTC, DeFi majors, Memecoins | Primary EVM spot and liquidity venue. |
| Curve | DeFi liquidity | Ethereum, Arbitrum, Base | Stablecoins, LST pairs | Stablecoin and LST liquidity routing. |
| Balancer | DeFi liquidity | Ethereum, Arbitrum, Base | Weighted DeFi pools, LST pools | Diversified liquidity and index-style DeFi exposure. |
| Pendle | Yield trading | Ethereum, Arbitrum | Fixed yield, LST yield, LRT yield | Structured yield and rate exposure. |
| Kamino | Solana DeFi | Solana | SOL, JitoSOL, USDC | Solana lending and automated vault exposure. |
| Jupiter | Solana DeFi | Solana | SOL, JUP, Solana majors, Memecoins | Primary Solana spot routing and aggregation. |
| Aerodrome | Memecoin execution | Base | Base majors, Base memecoins | Base ecosystem liquidity and memecoin execution. |
| Raydium | Memecoin execution | Solana | BONK, WIF, Solana memecoins | Liquid Solana memecoin execution venue. |
| Pump.fun | Memecoin execution | Solana | New Solana memecoins | Highest-risk launch venue; only for max speculation. |
| Meteora | Memecoin execution | Solana | Solana memecoin pools | Solana dynamic liquidity pools for high-beta tokens. |
| Hyperliquid | Perpetuals | Hyperliquid L1 | BTC-PERP, ETH-PERP, SOL-PERP, Majors | Primary on-chain perpetual futures venue. |
| Jupiter Perps | Perpetuals | Solana | SOL-PERP, ETH-PERP, BTC-PERP | Solana-native perpetual futures venue. |
| GMX v2 | Perpetuals | Arbitrum, Avalanche | BTC-PERP, ETH-PERP, SOL-PERP | Mature peer-to-pool perpetual futures venue. |
| dYdX v4 | Perpetuals | dYdX Chain | BTC-PERP, ETH-PERP, SOL-PERP, Majors | Orderbook perpetual futures diversification. |
| Lighter | Perpetuals | Ethereum L2 | BTC-PERP, ETH-PERP, Majors | High-liquidity perp venue with zk-based execution. |
