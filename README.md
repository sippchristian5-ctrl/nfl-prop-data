# NFL Prop Data

Automated compact NFL player and opponent-defense data for a personal prop projection tool.

## Data pipeline

- Source: nflverse release files
- Current season: 2026
- Prior season: 2025
- Default blend: 90% current season / 10% prior season when both seasons have data
- Older seasons: excluded from this default feed
- Refresh: daily through GitHub Actions, with manual runs available

The workflow processes the large source CSV files on a GitHub Actions runner, not inside the Cloudflare Worker.

Generated files:
- `data/index.json`: small player lookup index and data metadata
- `data/players/{gsisId}.json`: one player's weekly stats and weighted averages
- `data/defense/{TEAM}.json`: opponent defensive production allowed by position
- `data/metadata.json`: data freshness and source metadata

The Cloudflare Worker should fetch only the player file and relevant opponent-defense file needed for a projection. It should not download or parse the full nflverse CSVs.

## Data limitations

nflverse is not a live in-game data feed. The data is refreshed when nflverse publishes updated releases and the scheduled workflow runs. Defensive allowed-by-position figures are calculated from weekly player statistics; they are not official team defensive rankings and do not include points allowed in this initial feed.

Source and licensing information: https://github.com/nflverse/nflverse-data
