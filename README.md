# NFL Prop Data

Automated compact NFL player and opponent-defense data for a personal prop projection tool.

## Data pipeline

- Source: nflverse release files
- Current season: 2026
- Prior season: 2025
- Default season blend: 90% current season / 10% prior season when both seasons have data
- Older seasons: excluded from the default data feed
- Refresh: daily through GitHub Actions, with manual runs available

Large source CSV files are processed on a GitHub Actions runner, not inside the Cloudflare Worker.

## Generated files

- `data/metadata.json`: data freshness and source metadata
- `data/index.json`: full player directory
- `data/name-index/{initial}.json`: small search indexes, one per first letter found in player-name tokens
- `data/players/{gsisId}.json`: one player's weekly stats and weighted averages
- `data/defense/{TEAM}.json`: opponent production allowed by position
- `data/defense/index.json`: league-average defensive baselines by position and stat

## Cloudflare Worker

The replacement Worker source is in `cloudflare/worker.js`.

The Worker reads only the small files needed for a request. It does not download or parse the full nflverse CSV files.

## Projection notes

- Uses recent 2026 game form plus the 90/10 season blend.
- Opponent adjustments compare the defense's allowed production with the league average for the player's position and market.
- The opponent adjustment is capped at +/-15%.
- Estimated probabilities use a normal-distribution approximation based on recent game-to-game variation; they are not sportsbook odds.
- Injury status, confirmed starting status, weather, game pace, and live in-game data are not included in this version.
- nflverse is not a live in-game feed; freshness depends on nflverse publishing updated data and the daily build completing.

Source and licensing information: https://github.com/nflverse/nflverse-data
