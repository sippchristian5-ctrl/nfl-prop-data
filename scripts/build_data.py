import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

CURRENT_SEASON = 2026
PRIOR_SEASON = 2025
BASE = "https://github.com/nflverse/nflverse-data/releases/download"
OUT = Path("data")
PLAYER_URL = f"{BASE}/players/players.csv"

STAT_FIELDS = [
    "passing_yards", "passing_tds", "completions", "attempts",
    "rushing_yards", "carries", "rushing_tds",
    "receiving_yards", "receptions", "targets", "receiving_tds",
]
ID_COLUMNS = ["player_id", "gsis_id", "player_gsis_id"]


def fetch_csv(url: str) -> pd.DataFrame:
    response = requests.get(url, timeout=90)
    response.raise_for_status()
    from io import BytesIO
    return pd.read_csv(BytesIO(response.content), low_memory=False)


def first_existing(frame: pd.DataFrame, names: list[str]) -> str:
    for name in names:
        if name in frame.columns:
            return name
    raise ValueError(f"Missing expected columns: {names}")


def clean_num(value):
    if pd.isna(value):
        return 0
    return float(value)


def season_rows(season: int) -> pd.DataFrame:
    url = f"{BASE}/stats_player/stats_player_week_{season}.csv"
    frame = fetch_csv(url)
    id_col = first_existing(frame, ID_COLUMNS)
    if id_col != "player_id":
        frame = frame.rename(columns={id_col: "player_id"})
    frame["player_id"] = frame["player_id"].fillna("").astype(str)
    return frame


def summarize_player(player: dict, current: pd.DataFrame, prior: pd.DataFrame):
    pid = str(player.get("gsis_id") or "")
    if not pid:
        return None

    current_games = current[current["player_id"] == pid].copy()
    prior_games = prior[prior["player_id"] == pid].copy() if not prior.empty else pd.DataFrame()

    if "week" in current_games.columns:
        current_games["week"] = pd.to_numeric(current_games["week"], errors="coerce")
        current_games = current_games.sort_values("week")
    if "week" in prior_games.columns:
        prior_games["week"] = pd.to_numeric(prior_games["week"], errors="coerce")
        prior_games = prior_games.sort_values("week")

    def game_rows(frame):
        rows = []
        for _, row in frame.iterrows():
            item = {
                "season": int(row.get("season", CURRENT_SEASON)),
                "week": int(row["week"]) if pd.notna(row.get("week")) else None,
                "opponent": str(row.get("opponent_team") or ""),
            }
            for field in STAT_FIELDS:
                if field in frame.columns:
                    item[field] = clean_num(row.get(field))
            rows.append(item)
        return rows

    games = game_rows(current_games)
    prior_games_out = game_rows(prior_games)

    if not games and not prior_games_out:
        return None

    totals = {}
    averages = {}
    for field in STAT_FIELDS:
        vals = [g.get(field, 0) for g in games]
        totals[field] = round(sum(vals), 2)
        averages[field] = round(sum(vals) / len(vals), 2) if vals else 0

    return {
        "gsisId": pid,
        "name": player.get("display_name") or f"{player.get('first_name','')} {player.get('last_name','')}".strip(),
        "position": player.get("position"),
        "team": player.get("latest_team"),
        "currentSeason": CURRENT_SEASON,
        "priorSeason": PRIOR_SEASON,
        "currentGames": games,
        "priorGames": prior_games_out,
        "currentTotals": totals,
        "currentAverages": averages,
        "gamesPlayed": len(games),
    }


def main():
    OUT.mkdir(exist_ok=True)
    players = fetch_csv(PLAYER_URL)
    current = season_rows(CURRENT_SEASON)
    try:
        prior = season_rows(PRIOR_SEASON)
    except Exception as exc:
        print(f"Prior-season data unavailable; continuing without it: {exc}")
        prior = pd.DataFrame()

    players_out = {}
    for _, row in players.iterrows():
        player = row.to_dict()
        summary = summarize_player(player, current, prior)
        if summary:
            players_out[summary["gsisId"]] = summary

    payload = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "currentSeason": CURRENT_SEASON,
        "priorSeason": PRIOR_SEASON,
        "weights": {"currentSeason": 0.90, "priorSeason": 0.10},
        "source": "nflverse",
        "playerCount": len(players_out),
        "players": players_out,
    }
    (OUT / "players.json").write_text(json.dumps(payload, separators=(",", ":")))

    print(f"Generated data for {len(players_out)} players.")


if __name__ == "__main__":
    main()
