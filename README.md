# NFL Prop Data

Automated compact NFL player-stat data for a personal prop projection tool.

- Source: nflverse releases
- Current season weight: 90%
- Prior season weight: 10%
- Earlier seasons: excluded from the default data feed
- Refresh: daily via GitHub Actions (and manually on demand)

The workflow builds `data/players.json` outside the Cloudflare Worker. The Worker should fetch this compact file rather than downloading and parsing the full CSV datasets on every request.

Source data is provided by nflverse. See https://github.com/nflverse/nflverse-data and its license information.
