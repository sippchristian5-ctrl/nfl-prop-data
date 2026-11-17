const DATA_BASE =
  "https://raw.githubusercontent.com/sippchristian5-ctrl/nfl-prop-data/main/data";

const PLAYER_MARKETS = {
  passing_yards: "passing_yards",
  passing_tds: "passing_tds",
  completions: "completions",
  attempts: "attempts",
  rushing_yards: "rushing_yards",
  carries: "carries",
  rushing_tds: "rushing_tds",
  receiving_yards: "receiving_yards",
  receptions: "receptions",
  targets: "targets",
  receiving_tds: "receiving_tds",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return json({ error: "Only GET requests are supported." }, 405);
    }

    try {
      if (path === "/" || path === "/health") {
        const metadata = await loadJson("metadata.json");
        return json({
          status: "online",
          server: "NFL Prop Analyzer",
          dataSource: "nflverse",
          generatedAt: metadata.generatedAt,
          currentSeason: metadata.currentSeason,
          priorSeason: metadata.priorSeason,
          weights: metadata.weights,
          playerCount: metadata.playerCount,
          defenseTeamCount: metadata.defenseTeamCount,
          endpoints: [
            "/player?name=PLAYER_NAME",
            "/player/stats?id=GSIS_ID&season=2026",
            "/player/gamelog?id=GSIS_ID&season=2026",
            "/prop?player=PLAYER_NAME&opponent=TEAM&market=passing_yards&line=200.5&last=10",
          ],
          note: "nflverse is not a live in-game feed.",
        });
      }

      if (path === "/player" && url.searchParams.has("name")) {
        const name = url.searchParams.get("name");
        const results = await findPlayers(name);
        return json({
          search: name,
          count: results.length,
          results: results.slice(0, 25),
        });
      }

      if (path === "/player/stats" || path === "/player/gamelog") {
        const id = url.searchParams.get("id");
        if (!id || !/^00-\d{6,7}$/.test(id)) {
          return json({ error: "Provide a valid GSIS player ID." }, 400);
        }

        const player = await loadJson(`players/${id}.json`);
        const season = Number(
          url.searchParams.get("season") || player.currentSeason
        );

        let games;
        if (season === player.currentSeason) {
          games = player.currentGames || [];
        } else if (season === player.priorSeason) {
          games = player.priorGames || [];
        } else {
          return json({
            error: "Only the current and prior season are available.",
            currentSeason: player.currentSeason,
            priorSeason: player.priorSeason,
          }, 400);
        }

        if (path.endsWith("/gamelog")) {
          return json({
            player: player.name,
            playerId: id,
            season,
            games: [...games].sort((a, b) => Number(b.week) - Number(a.week)),
          });
        }

        return json({
          player: player.name,
          playerId: id,
          position: player.position,
          team: player.team,
          season,
          gamesPlayed: games.length,
          totals: aggregate(games),
          averages: averages(games),
        });
      }

      if (path === "/prop") {
        return await handleProp(url);
      }

      return json({ error: "Endpoint not found." }, 404);
    } catch (error) {
      return json({
        error: "Request failed.",
        details: error instanceof Error ? error.message : String(error),
      }, 502);
    }
  },
};

async function handleProp(url) {
  const name = url.searchParams.get("player");
  const opponent = (url.searchParams.get("opponent") || "")
    .trim()
    .toUpperCase();
  const market = url.searchParams.get("market");
  const lineText = url.searchParams.get("line");
  const line = Number(lineText);
  const last = Math.min(
    18,
    Math.max(1, Number(url.searchParams.get("last") || 10))
  );

  if (!name || !PLAYER_MARKETS[market] || lineText === null ||
      !Number.isFinite(line)) {
    return json({
      error: "Provide player, valid market, and numeric line.",
      validMarkets: Object.keys(PLAYER_MARKETS),
    }, 400);
  }

  const matches = await findPlayers(name);
  if (!matches.length) {
    return json({ error: "Player not found.", search: name }, 404);
  }

  const normalized = normalizeName(name);
  const exact = matches.filter(
    player => normalizeName(player.name) === normalized
  );

  const chosen = exact.length === 1 ? exact[0] :
    matches.length === 1 ? matches[0] : null;

  if (!chosen) {
    return json({
      error: "More than one player matched. Use a more complete name.",
      matches: matches.slice(0, 10),
    }, 409);
  }

  const player = await loadJson(`players/${chosen.gsisId}.json`);
  const currentGames = [...(player.currentGames || [])]
    .sort((a, b) => Number(a.week) - Number(b.week));
  const allValues = currentGames.map(game =>
    Number(game[PLAYER_MARKETS[market]] || 0)
  );

  const recentGames = currentGames.slice(-last).reverse();
  const recentValues = recentGames.map(game =>
    Number(game[PLAYER_MARKETS[market]] || 0)
  );
  const last5 = allValues.slice(-5);
  const last10 = allValues.slice(-10);

  const weightedAverage = Number(
    player.weightedAverages?.[PLAYER_MARKETS[market]] || 0
  );
  const recent5Average = mean(last5);
  const recent10Average = mean(last10);

  let baseProjection = weightedAverage;
  let projectionMethod = "90/10 weighted season average";

  if (allValues.length >= 3) {
    const recentForm = 0.60 * recent5Average + 0.40 * recent10Average;
    baseProjection = 0.70 * recentForm + 0.30 * weightedAverage;
    projectionMethod =
      "70% recent 2026 form and 30% 90/10 weighted season average";
  } else if (allValues.length > 0 && weightedAverage === 0) {
    baseProjection = mean(allValues);
    projectionMethod = "Available 2026 game average; limited sample";
  }

  let matchupFactor = 1;
  let opponentAllowed = null;
  let leagueAllowed = null;
  let matchupNote = "No opponent adjustment applied.";

  if (opponent) {
    if (!/^[A-Z0-9]{2,4}$/.test(opponent)) {
      return json({ error: "Opponent must be an NFL team abbreviation." }, 400);
    }

    const [defense, defenseIndex] = await Promise.all([
      loadJson(`defense/${opponent}.json`),
      loadJson("defense/index.json"),
    ]);

    const position = player.position;
    const field = PLAYER_MARKETS[market];
    opponentAllowed = Number(
      defense.weightedAverageAllowed?.[position]?.[field]
    );
    leagueAllowed = Number(
      defenseIndex.leagueAveragesAllowed?.[position]?.[field]
    );

    if (
      Number.isFinite(opponentAllowed) &&
      Number.isFinite(leagueAllowed) &&
      leagueAllowed > 0
    ) {
      matchupFactor = clamp(opponentAllowed / leagueAllowed, 0.85, 1.15);
      matchupNote =
        "Opponent adjustment is capped at +/-15% versus the league average for this position and stat.";
    } else {
      opponentAllowed = null;
      leagueAllowed = null;
      matchupNote =
        "Opponent data was unavailable for this position and market; no adjustment applied.";
    }
  }

  const projection = round(baseProjection * matchupFactor);
  const hits = recentValues.filter(value => value > line).length;
  const pushes = recentValues.filter(value => value === line).length;
  const underHits = recentValues.length - hits - pushes;
  const standardDeviation = stdev(recentValues);
  const estimatedOverProbability = recentValues.length >= 3
    ? round(normalSurvival((line - projection) / Math.max(standardDeviation, 0.01)) * 100, 1)
    : null;

  let lean = "No clear lean";
  if (estimatedOverProbability !== null) {
    if (estimatedOverProbability >= 55) lean = "Lean Over";
    if (estimatedOverProbability <= 45) lean = "Lean Under";
  }

  const metadata = await loadJson("metadata.json");

  return json({
    player: player.name,
    team: player.team,
    position: player.position,
    gsisId: player.gsisId,
    opponent: opponent || null,
    season: player.currentSeason,
    market,
    propLine: line,
    projection,
    projectionMethod,
    matchupAdjustment: round((matchupFactor - 1) * 100, 1) + "%",
    opponentAverageAllowed: opponentAllowed,
    leagueAverageAllowed: leagueAllowed,
    gamesPlayed: allValues.length,
    last5Average: round(recent5Average),
    last10Average: round(recent10Average),
    weightedSeasonAverage: round(weightedAverage),
    recentAverage: round(mean(recentValues)),
    recentMedian: median(recentValues),
    overHits: hits,
    underHits,
    pushes,
    recentOverHitRate: recentValues.length
      ? round(hits / recentValues.length * 100, 1) + "%"
      : "No data",
    estimatedOverProbability,
    estimatedUnderProbability: estimatedOverProbability === null
      ? null
      : round(100 - estimatedOverProbability, 1),
    lean,
    sampleSize: recentValues.length,
    gameResults: recentGames.map((game) => ({
      week: game.week,
      opponent: game.opponent,
      value: Number(game[PLAYER_MARKETS[market]] || 0),
    })),
    dataUpdatedAt: metadata.generatedAt,
    dataSource: "nflverse",
    notes: [
      "Estimated probabilities use a normal-distribution approximation and recent game-to-game variation; they are not sportsbook odds.",
      "Historical hit rates are descriptive and do not guarantee future results.",
      "Injury status, confirmed starting status, weather, game pace, and live in-game data are not included in this version.",
      matchupNote,
    ],
  });
}

async function findPlayers(name) {
  const query = normalizeName(name);
  if (query.length < 2) {
    throw new Error("Enter at least two characters of the player's name.");
  }

  const tokens = query.split(/\s+/).filter(Boolean);
  const initials = [...new Set(tokens.map(token => token[0]))];

  const lists = await Promise.all(initials.map(async initial => {
    try {
      return await loadJson(`name-index/${initial}.json`);
    } catch {
      return [];
    }
  }));

  const candidates = new Map();
  for (const list of lists) {
    for (const player of list) {
      candidates.set(player.gsisId, player);
    }
  }

  return [...candidates.values()].filter(player => {
    const playerName = normalizeName(player.name);
    const playerTokens = playerName.split(/\s+/).filter(Boolean);

    return playerName.includes(query) ||
      tokens.every(token =>
        playerTokens.some(playerToken => playerToken.startsWith(token))
      );
  }).slice(0, 25);
}

async function loadJson(path) {
  const safePath = path.split("/").map(encodeURIComponent).join("/");
  const source = `${DATA_BASE}/${safePath}`;
  const cache = caches.default;
  const key = new Request(source, { method: "GET" });

  const cached = await cache.match(key);
  if (cached) return cached.json();

  const response = await fetch(source, {
    headers: { "Accept": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Data file ${path} returned HTTP ${response.status}.`);
  }

  const body = await response.text();
  const data = JSON.parse(body);

  await cache.put(key, new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=900",
    },
  }));

  return data;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.'’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? round(sorted[middle])
    : round((sorted[middle - 1] + sorted[middle]) / 2);
}

function stdev(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = mean(values.map(value => (value - average) ** 2));
  return Math.sqrt(variance);
}

function aggregate(games) {
  const totals = {};
  for (const field of Object.values(PLAYER_MARKETS)) {
    totals[field] = games.reduce(
      (sum, game) => sum + Number(game[field] || 0), 0
    );
  }
  return totals;
}

function averages(games) {
  const totals = aggregate(games);
  const output = {};
  for (const [field, total] of Object.entries(totals)) {
    output[field] = round(games.length ? total / games.length : 0);
  }
  return output;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Error-function approximation used for a transparent normal-CDF estimate.
function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial =
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - polynomial * Math.exp(-x * x));
}

function normalSurvival(z) {
  const cdf = 0.5 * (1 + erf(z / Math.SQRT2));
  return 1 - cdf;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
