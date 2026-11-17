# NFL Prop Data

Personal NFL player and opponent-defense data pipeline for the Football Project.

## Data pipeline

- Source: nflverse weekly player-stat releases
- Current season: 2026
- Prior season: 2025
- Existing season blend preference: 90% current season / 10% prior season when both seasons have data
- Earlier seasons: excluded from the default projection feed
- Refresh: daily through GitHub Actions, with manual runs available

Large CSV files are processed by GitHub Actions, not inside the Cloudflare Worker.

## Official projection formulas

These formulas follow the user's supplied Football Project documents. The formulas are the primary projection. The additional matchup/situation information is reported separately and does not change the formula result.

### Quarterback passing yards

`QB Average Completions Per Game × (Opponent Passing Yards Allowed ÷ Opponent Completions Allowed)`

The opponent term is yards per completion allowed, not yards per attempt.

### Running back rushing yards

`RB Average Rushing Attempts Per Game × [(RB YPC + Opponent RB YPC Allowed) ÷ 2]`

### Wide receiver receiving yards

`(QB Average Completions × WR Target Share) × [(WR YPR + Opponent WR YPR Allowed) ÷ 2]`

Where WR target share = receiver targets ÷ team pass attempts.

### Running back rushing + receiving yards

`(Carries × [(RB YPC + Opponent RB YPC Allowed) ÷ 2]) + (Targets × [(RB YPT + Opponent RB YPT Allowed) ÷ 2])`

The rushing and receiving portions are calculated separately, then added.

## Season weighting

When both seasons have data, player per-game averages and derived player/defense rates use 90% 2026 and 10% 2025. When only one season has data, the available season is used. This is the project's existing season weighting preference; it does not add a separate recent-form multiplier to the official formula.

## Odds formulas

The separate `/odds` endpoint implements the supplied odds calculations:
- Negative American odds: `abs(odds) / (abs(odds) + 100)`
- Positive American odds: `100 / (odds + 100)`
- Probability edge: `My Projected Probability − Sportsbook Implied Probability`
- PrizePicks break-even: `1 / Payout Multiplier`
- Expected value: `(Win Probability × Total Payout) − Entry Cost`
- Three-pick combined probability: multiply the three probabilities, assuming independence

The formula files do not specify how to create a projected probability from a point-yardage projection. Therefore, the Worker reports historical hit rates separately and does not present them as projected probabilities.

## Generated files

- `data/metadata.json`: freshness and source metadata
- `data/index.json`: player directory
- `data/name-index/{initial}.json`: small player name indexes
- `data/players/{gsisId}.json`: player weekly stats and team QB completions/pass attempts by game
- `data/defense/{TEAM}.json`: opponent production allowed by position and week
- `data/defense/index.json`: league-average defensive baselines

## Cloudflare Worker

Replacement Worker source: `cloudflare/worker.js`.

Supported formula markets:
- `passing_yards` for QBs
- `rushing_yards` for RBs
- `receiving_yards` for WRs
- `rushing_receiving_yards` for RBs

The Worker also provides player lookup, stats, game logs, and an `/odds` endpoint.

## Supporting factors and limitations

Recent 3–5 game volume and production, defensive trends, home/away, injuries, offensive-line availability, depth-chart role, and game script are supporting information. They do not change the official formula projection.

Live verified injury reports, offensive-line availability, depth charts, game script, weather, and stadium surface are not currently integrated into the data feed. nflverse is not a live in-game data source.

Source and licensing information: https://github.com/nflverse/nflverse-data
