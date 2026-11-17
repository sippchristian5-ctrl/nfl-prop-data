import json
import re
import shutil
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import pandas as pd
import requests

CURRENT_SEASON = 2026
PRIOR_SEASON = 2025
CURRENT_WEIGHT = 0.90
PRIOR_WEIGHT = 0.10
BASE = "https://github.com/nflverse/nflverse-data/releases/download"
OUT = Path("data")
PLAYER_URL = f"{BASE}/players/players.csv"

STAT_FIELDS = [
    "passing_yards", "passing_tds", "completions", "attempts",
    "rushing_yards", "carries", "rushing_tds",
    "receiving_yards", "receptions", "targets", "receiving_tds",
]
ID_COLUMNS = ["player_id", "gsis_id", "player_gsis_id"]
POSITIONS = ["QB", "RB", "WR", "TE"]


def fetch_csv(url: str) -> pd.DataFrame:
    response = requests.get(url, timeout=120)
    response.raise_for_status()
    return pd.read_csv(BytesIO(response.content), low_memory=False)


def first_existing(frame: pd.DataFrame, names: list[str]) -> str:
    for name in names:
        if name in frame.columns:
            return name
    raise ValueError(f"Missing expected columns: {names}")


def safe_text(value) -> str:
    return "" if pd.isna(value) else str(value).strip()


def safe_number(value) -> float:
    return 0.0 if pd.isna(value) else float(value)


def safe_week(value):
    return int(value) if pd.notna(value) else None


def season_rows(season: int, players: pd.DataFrame) -> pd.DataFrame:
    url = f"{BASE}/stats_player/stats_player_week_{season}.csv"
    frame = fetch_csv(url)

    id_col = first_existing(frame, ID_COLUMNS)
    if id_col != "player_id":
        frame = frame.rename(columns={id_col: "player_id"})

    frame["player_id"] = frame["player_id"].fillna("").astype(str)

    if "season_type" in frame.columns:
        frame = frame[
            frame["season_type"].astype(str).str.upper().eq("REG")
        ].copy()

    if "position" not in frame.columns:
        roster = players[["gsis_id", "position"]].dropna().copy()
        roster["gsis_id"] = roster["gsis_id"].astype(str)
        frame = frame.merge(
            roster, left_on="player_id", right_on="gsis_id", how="left"
        )

    if "team" not in frame.columns:
        raise ValueError("The weekly player-stat feed is missing the team column.")

    for field in STAT_FIELDS:
        if field not in frame.columns:
            frame[field] = 0
        frame[field] = pd.to_numeric(
            frame[field], errors="coerce"
        ).fillna(0)

    frame["team"] = frame["team"].map(safe_text)
    frame["position"] = frame["position"].map(safe_text).str.upper()
    frame["week"] = pd.to_numeric(frame["week"], errors="coerce")
    return frame


def team_week_pass_totals(frame: pd.DataFrame) -> dict:
    """Sum completions and pass attempts for every team's QB room each week."""
    quarterbacks = frame[frame["position"].eq("QB")].copy()
    grouped = quarterbacks.groupby(["team", "week"], dropna=False)[
        ["completions", "attempts"]
    ].sum()

    output = {}
    for (team, week), row in grouped.iterrows():
        if not team or pd.isna(week):
            continue
        output[(str(team), int(week))] = {
            "completions": safe_number(row["completions"]),
            "attempts": safe_number(row["attempts"]),
        }
    return output


def mean_for(games: list[dict], field: str) -> float:
    if not games:
        return 0.0
    return sum(float(game.get(field, 0)) for game in games) / len(games)


def weighted_average(current: list[dict], prior: list[dict], field: str) -> float:
    if current and prior:
        return (
            mean_for(current, field) * CURRENT_WEIGHT
            + mean_for(prior, field) * PRIOR_WEIGHT
        )
    if current:
        return mean_for(current, field)
    if prior:
        return mean_for(prior, field)
    return 0.0


def rows_for_player(
    frame: pd.DataFrame,
    player_id: str,
    season: int,
    team_totals: dict,
) -> list[dict]:
    subset = frame[frame["player_id"].eq(player_id)].copy()
    if "week" in subset.columns:
        subset = subset.sort_values("week")

    games = []
    for _, row in subset.iterrows():
        week = safe_week(row.get("week"))
        team = safe_text(row.get("team"))
        team_stats = team_totals.get((team, week), {}) if week is not None else {}

        game = {
            "season": season,
            "week": week,
            "team": team,
            "opponent": safe_text(row.get("opponent_team")),
            "homeAway": safe_text(row.get("home_away")),
            "teamQbCompletions": round(
                safe_number(team_stats.get("completions")), 2
            ),
            "teamPassAttempts": round(
                safe_number(team_stats.get("attempts")), 2
            ),
        }
        for field in STAT_FIELDS:
            game[field] = round(safe_number(row.get(field)), 2)
        games.append(game)
    return games


def build_players(
    players: pd.DataFrame,
    current: pd.DataFrame,
    prior: pd.DataFrame,
    current_team_totals: dict,
    prior_team_totals: dict,
):
    player_dir = OUT / "players"
    player_dir.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(player_dir)
    player_dir.mkdir(parents=True, exist_ok=True)

    search_dir = OUT / "name-index"
    search_dir.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(search_dir)
    search_dir.mkdir(parents=True, exist_ok=True)

    index = []
    search_buckets: dict[str, dict[str, dict]] = {}
    count = 0

    for _, row in players.iterrows():
        player_id = safe_text(row.get("gsis_id"))
        if not player_id or player_id.lower() == "nan":
            continue

        current_games = rows_for_player(
            current, player_id, CURRENT_SEASON, current_team_totals
        )
        prior_games = rows_for_player(
            prior, player_id, PRIOR_SEASON, prior_team_totals
        )

        if not current_games and not prior_games:
            continue

        player_name = safe_text(row.get("display_name"))
        if not player_name:
            player_name = (
                f"{safe_text(row.get('first_name'))} "
                f"{safe_text(row.get('last_name'))}"
            ).strip()

        weighted = {
            field: round(
                weighted_average(current_games, prior_games, field), 2
            )
            for field in STAT_FIELDS
        }

        payload = {
            "schemaVersion": 3,
            "gsisId": player_id,
            "name": player_name,
            "position": safe_text(row.get("position")),
            "team": safe_text(row.get("latest_team")),
            "currentSeason": CURRENT_SEASON,
            "priorSeason": PRIOR_SEASON,
            "weights": {
                "currentSeason": CURRENT_WEIGHT,
                "priorSeason": PRIOR_WEIGHT,
                "note": (
                    "90/10 blend when both seasons have data; "
                    "uses the available season when only one has data."
                ),
            },
            "currentGames": current_games,
            "priorGames": prior_games,
            "currentGamesPlayed": len(current_games),
            "priorGamesPlayed": len(prior_games),
            "weightedAverages": weighted,
        }

        (player_dir / f"{player_id}.json").write_text(
            json.dumps(payload, separators=(",", ":"))
        )

        entry = {
            "gsisId": player_id,
            "name": player_name,
            "position": payload["position"],
            "team": payload["team"],
        }
        index.append(entry)

        initials = {
            token[0]
            for token in re.findall(r"[a-z0-9]+", player_name.lower())
            if token
        }
        for initial in initials:
            search_buckets.setdefault(initial, {})[player_id] = entry

        count += 1

    index.sort(key=lambda player: player["name"].lower())
    for initial, players_for_initial in search_buckets.items():
        entries = sorted(
            players_for_initial.values(),
            key=lambda player: player["name"].lower()
        )
        (search_dir / f"{initial}.json").write_text(
            json.dumps(entries, separators=(",", ":"))
        )

    return index, count, len(search_buckets)


def build_defense(current: pd.DataFrame, prior: pd.DataFrame):
    defense_dir = OUT / "defense"
    defense_dir.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(defense_dir)
    defense_dir.mkdir(parents=True, exist_ok=True)

    team_data = {}

    for season, frame in [
        (CURRENT_SEASON, current),
        (PRIOR_SEASON, prior),
    ]:
        if (
            frame.empty
            or "opponent_team" not in frame.columns
            or "position" not in frame.columns
        ):
            continue

        usable = frame.copy()
        usable["opponent_team"] = usable["opponent_team"].map(safe_text)
        usable["position"] = usable["position"].map(safe_text).str.upper()
        usable = usable[
            usable["opponent_team"].ne("")
            & usable["position"].isin(POSITIONS)
        ]

        grouped = (
            usable.groupby(
                ["opponent_team", "position", "week"], dropna=False
            )[STAT_FIELDS]
            .sum()
            .reset_index()
        )

        for (team, position), rows in grouped.groupby(
            ["opponent_team", "position"]
        ):
            if team not in team_data:
                team_data[team] = {
                    "team": team,
                    "source": "nflverse player weekly stats",
                    "seasons": {},
                }

            rows = rows.sort_values("week")
            weekly = []
            for _, row in rows.iterrows():
                stats = {
                    field: round(safe_number(row.get(field)), 2)
                    for field in STAT_FIELDS
                }
                weekly.append({
                    "week": safe_week(row.get("week")),
                    "statsAllowed": stats,
                })

            averages = {
                field: round(
                    sum(item["statsAllowed"][field] for item in weekly)
                    / len(weekly), 2
                ) if weekly else 0
                for field in STAT_FIELDS
            }

            team_data[team]["seasons"].setdefault(
                str(season), {}
            )[position] = {
                "games": len(weekly),
                "perGameAverageAllowed": averages,
                "weekly": weekly,
            }

    for team, payload in team_data.items():
        current_positions = payload["seasons"].get(
            str(CURRENT_SEASON), {}
        )
        prior_positions = payload["seasons"].get(
            str(PRIOR_SEASON), {}
        )
        weighted_positions = {}

        for position in POSITIONS:
            current_stats = current_positions.get(
                position, {}
            ).get("perGameAverageAllowed", {})
            prior_stats = prior_positions.get(
                position, {}
            ).get("perGameAverageAllowed", {})

            if not current_stats and not prior_stats:
                continue

            weighted_positions[position] = {}
            for field in STAT_FIELDS:
                if current_stats and prior_stats:
                    value = (
                        current_stats.get(field, 0) * CURRENT_WEIGHT
                        + prior_stats.get(field, 0) * PRIOR_WEIGHT
                    )
                elif current_stats:
                    value = current_stats.get(field, 0)
                else:
                    value = prior_stats.get(field, 0)
                weighted_positions[position][field] = round(value, 2)

        payload["weightedAverageAllowed"] = weighted_positions
        (defense_dir / f"{team}.json").write_text(
            json.dumps(payload, separators=(",", ":"))
        )

    league_seasons = {}
    for season in [CURRENT_SEASON, PRIOR_SEASON]:
        season_key = str(season)
        league_seasons[season_key] = {}

        for position in POSITIONS:
            teams = []
            for payload in team_data.values():
                stats = payload["seasons"].get(
                    season_key, {}
                ).get(position, {}).get("perGameAverageAllowed")
                if stats:
                    teams.append(stats)

            if not teams:
                continue

            league_seasons[season_key][position] = {
                field: round(
                    sum(team_stats.get(field, 0) for team_stats in teams)
                    / len(teams), 2
                )
                for field in STAT_FIELDS
            }

    weighted_league = {}
    for position in POSITIONS:
        current_stats = league_seasons.get(
            str(CURRENT_SEASON), {}
        ).get(position, {})
        prior_stats = league_seasons.get(
            str(PRIOR_SEASON), {}
        ).get(position, {})

        if not current_stats and not prior_stats:
            continue

        weighted_league[position] = {}
        for field in STAT_FIELDS:
            if current_stats and prior_stats:
                value = (
                    current_stats.get(field, 0) * CURRENT_WEIGHT
                    + prior_stats.get(field, 0) * PRIOR_WEIGHT
                )
            elif current_stats:
                value = current_stats.get(field, 0)
            else:
                value = prior_stats.get(field, 0)
            weighted_league[position][field] = round(value, 2)

    defense_index = {
        "currentSeason": CURRENT_SEASON,
        "priorSeason": PRIOR_SEASON,
        "weights": {
            "currentSeason": CURRENT_WEIGHT,
            "priorSeason": PRIOR_WEIGHT,
        },
        "leagueAveragesAllowed": weighted_league,
        "leagueAveragesBySeason": league_seasons,
        "teamCount": len(team_data),
        "note": (
            "Team defensive averages are calculated from opposing player "
            "weekly statistics by position."
        ),
    }
    (defense_dir / "index.json").write_text(
        json.dumps(defense_index, separators=(",", ":"))
    )

    return len(team_data)


def main():
    OUT.mkdir(exist_ok=True)

    players = fetch_csv(PLAYER_URL)
    players["gsis_id"] = players["gsis_id"].fillna("").astype(str)

    current = season_rows(CURRENT_SEASON, players)
    prior = season_rows(PRIOR_SEASON, players)

    current_team_totals = team_week_pass_totals(current)
    prior_team_totals = team_week_pass_totals(prior)

    index, player_count, search_index_count = build_players(
        players,
        current,
        prior,
        current_team_totals,
        prior_team_totals,
    )
    defense_count = build_defense(current, prior)

    generated_at = datetime.now(timezone.utc).isoformat()
    metadata = {
        "schemaVersion": 4,
        "generatedAt": generated_at,
        "currentSeason": CURRENT_SEASON,
        "priorSeason": PRIOR_SEASON,
        "weights": {
            "currentSeason": CURRENT_WEIGHT,
            "priorSeason": PRIOR_WEIGHT,
        },
        "source": "nflverse",
        "playerCount": player_count,
        "nameIndexFiles": search_index_count,
        "defenseTeamCount": defense_count,
        "teamPassTotalsIncluded": True,
        "regularSeasonOnly": True,
        "dataNote": "nflverse updates are not a live in-game feed.",
    }

    (OUT / "index.json").write_text(
        json.dumps({**metadata, "players": index}, separators=(",", ":"))
    )
    (OUT / "metadata.json").write_text(
        json.dumps(metadata, separators=(",", ":"))
    )

    print(
        f"Generated {player_count} player files, "
        f"{search_index_count} name indexes, "
        f"{defense_count} opponent-defense files, and "
        f"{len(current_team_totals) + len(prior_team_totals)} team-week QB passing totals."
    )


if __name__ == "__main__":
    main()
