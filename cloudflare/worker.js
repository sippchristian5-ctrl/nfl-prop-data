const DATA_BASE =
  "https://raw.githubusercontent.com/sippchristian5-ctrl/nfl-prop-data/main/data";

const PLAYER_MARKETS = {
  passing_yards: "passing_yards",
  rushing_yards: "rushing_yards",
  receiving_yards: "receiving_yards",
  rushing_receiving_yards: "rushing_receiving_yards",
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
          formulaVersion: "user-project-official-formulas-v1",
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
            "/prop?player=PLAYER_NAME&opponent=TEAM&market=passing_yards&line=210&last=10",
            "/odds?american_odds=-110&my_probability=0.60",
          ],
          note: "Formula projections are separate from supporting matchup factors. nflverse is not a live in-game feed.",
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

      if (path === "/prop") return await handleProp(url);
      if (path === "/odds") return handleOdds(url);

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
  const hasLine = lineText !== null && lineText.trim() !== "";
  const line = hasLine ? Number(lineText) : null;
  const last = Math.min(
    18,
    Math.max(1, Number(url.searchParams.get("last") || 10))
  );

  const supportedMarkets = [
    "passing_yards (QB)",
    "rushing_yards (RB)",
    "receiving_yards (WR)",
    "rushing_receiving_yards (RB)",
  ];

  if (
    !name ||
    !Object.prototype.hasOwnProperty.call(PLAYER_MARKETS, market) ||
    (hasLine && !Number.isFinite(line))
  ) {
    return json({
      error: "Provide player, a supported official formula market, and an optional numeric line.",
      supportedMarkets,
    }, 400);
  }
  if (!opponent || !/^[A-Z0-9]{2,4}$/.test(opponent)) {
    return json({
      error: "Provide the opponent's NFL abbreviation, such as IND.",
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
  const chosen = exact.length === 1
    ? exact[0]
    : matches.length === 1
      ? matches[0]
      : null;

  if (!chosen) {
    return json({
      error: "More than one player matched. Use a more complete name.",
      matches: matches.slice(0, 10),
    }, 409);
  }

  const player = await loadJson(`players/${chosen.gsisId}.json`);
  const position = String(player.position || "").toUpperCase();
  const allowedPosition = {
    passing_yards: "QB",
    rushing_yards: "RB",
    receiving_yards: "WR",
    rushing_receiving_yards: "RB",
  }[market];

  if (position !== allowedPosition) {
    return json({
      error: `The uploaded formula for ${market} applies to ${allowedPosition} players; this player is listed as ${position}.`,
      player: player.name,
      position,
      requiredPosition: allowedPosition,
    }, 400);
  }

  const [defense, metadata] = await Promise.all([
    loadJson(`defense/${opponent}.json`),
    loadJson("metadata.json"),
  ]);

  const currentGames = sortGames(player.currentGames || []);
  const priorGames = sortGames(player.priorGames || []);
  const weightedAverages = player.weightedAverages || {};

  let formulaResult;
  if (market === "passing_yards") {
    formulaResult = projectQuarterback(player, defense, currentGames, priorGames, weightedAverages);
  } else if (market === "rushing_yards") {
    formulaResult = projectRunningBackRushing(player, defense, currentGames, priorGames, weightedAverages);
  } else if (market === "receiving_yards") {
    formulaResult = projectWideReceiverReceiving(player, defense, currentGames, priorGames);
  } else {
    formulaResult = projectRunningBackCombined(player, defense, currentGames, priorGames, weightedAverages);
  }

  if (formulaResult.error) {
    return json({
      error: formulaResult.error,
      player: player.name,
      opponent,
      market,
      missingInputs: formulaResult.missingInputs || [],
    }, 422);
  }

  const historical = historyResults(currentGames, market, line, last);
  const formulaProjection = round(formulaResult.projection);
  const projectionGap = hasLine ? round(formulaProjection - line) : null;

  return json({
    player: player.name,
    team: player.team,
    position,
    gsisId: player.gsisId,
    opponent,
    season: player.currentSeason,
    market,
    propLine: line,
    projection: formulaProjection,
    formulaName: formulaResult.formulaName,
    officialFormula: formulaResult.officialFormula,
    formulaInputs: formulaResult.inputs,
    calculation: formulaResult.calculation,
    seasonWeights: player.weights,
    projectionGap,
    lineLean: !hasLine
      ? "No line supplied"
      : projectionGap > 0
        ? "Formula projection is above the line"
        : projectionGap < 0
          ? "Formula projection is below the line"
          : "Formula projection equals the line",
    historicalResults: historical,
    supportingFactors: buildSupportingFactors(
      player, currentGames, defense, position, market
    ),
    supportingFactorsAffectProjection: false,
    dataUpdatedAt: metadata.generatedAt,
    dataSource: "nflverse",
    limitations: [
      "The official mathematical formula is shown separately and is not changed by supporting factors.",
      "Only the statistics present in the data feed are used in the calculation.",
      "Injuries, offensive-line availability, depth-chart role, game script, stadium surface, and weather are not currently integrated as live verified data.",
      "This endpoint does not generate a projected probability. Use the separate /odds endpoint for the probability calculations documented in the project.",
      "nflverse is not a live in-game data feed.",
    ],
  });
}

function projectQuarterback(player, defense, currentGames, priorGames, weightedAverages) {
  const qbCompletionsPerGame = Number(weightedAverages.completions || 0);
  const opponentYardsPerCompletionAllowed = weightedDefenseRate(
    defense, "QB", "passing_yards", "completions"
  );

  if (qbCompletionsPerGame <= 0 || opponentYardsPerCompletionAllowed === null) {
    return {
      error: "Insufficient player completions or opponent QB passing data.",
      missingInputs: [
        "QB average completions per game",
        "Opponent passing yards allowed divided by opponent completions allowed",
      ],
    };
  }

  const projection = qbCompletionsPerGame * opponentYardsPerCompletionAllowed;

  return {
    formulaName: "QB passing yards — official user-project formula",
    officialFormula: "QB Average Completions Per Game × (Opponent Passing Yards Allowed ÷ Opponent Completions Allowed)",
    projection,
    inputs: {
      qbAverageCompletionsPerGame: round(qbCompletionsPerGame),
      opponentPassingYardsAllowedPerCompletion: round(opponentYardsPerCompletionAllowed, 4),
    },
    calculation: `${round(qbCompletionsPerGame, 2)} × ${round(opponentYardsPerCompletionAllowed, 4)} = ${round(projection, 2)} passing yards`,
  };
}

function projectRunningBackRushing(player, defense, currentGames, priorGames, weightedAverages) {
  const carriesPerGame = Number(weightedAverages.carries || 0);
  const playerYpc = weightedPlayerRate(currentGames, priorGames, "rushing_yards", "carries");
  const opponentYpcAllowed = weightedDefenseRate(
    defense, "RB", "rushing_yards", "carries"
  );

  if (carriesPerGame <= 0 || playerYpc === null || opponentYpcAllowed === null) {
    return {
      error: "Insufficient running-back carries, rushing yards, or opponent RB rushing data.",
      missingInputs: [
        "RB average rushing attempts per game",
        "RB rushing yards divided by RB carries",
        "Opponent RB rushing yards allowed divided by opponent RB carries allowed",
      ],
    };
  }

  const adjustedYpc = (playerYpc + opponentYpcAllowed) / 2;
  const projection = carriesPerGame * adjustedYpc;

  return {
    formulaName: "RB rushing yards — official user-project formula",
    officialFormula: "RB Average Rushing Attempts Per Game × [(RB YPC + Opponent RB YPC Allowed) ÷ 2]",
    projection,
    inputs: {
      rbAverageCarriesPerGame: round(carriesPerGame),
      rbYpc: round(playerYpc, 4),
      opponentRbYpcAllowed: round(opponentYpcAllowed, 4),
      adjustedYpc: round(adjustedYpc, 4),
    },
    calculation: `${round(carriesPerGame, 2)} × [(${round(playerYpc, 2)} + ${round(opponentYpcAllowed, 2)}) ÷ 2] = ${round(projection, 2)} rushing yards`,
  };
}

function projectWideReceiverReceiving(player, defense, currentGames, priorGames) {
  const qbCompletionsPerGame = weightedGameMean(
    currentGames, priorGames, "teamQbCompletions"
  );
  const targetShare = weightedTargetShare(currentGames, priorGames);
  const wrYpr = weightedPlayerRate(
    currentGames, priorGames, "receiving_yards", "receptions"
  );
  const opponentWrYprAllowed = weightedDefenseRate(
    defense, "WR", "receiving_yards", "receptions"
  );

  const missing = [];
  if (qbCompletionsPerGame === null || qbCompletionsPerGame <= 0) {
    missing.push("Team QB average completions per game");
  }
  if (targetShare === null || targetShare <= 0) {
    missing.push("WR targets divided by team pass attempts");
  }
  if (wrYpr === null) missing.push("WR receiving yards divided by receptions");
  if (opponentWrYprAllowed === null) {
    missing.push("Opponent WR receiving yards allowed divided by receptions allowed");
  }
  if (missing.length) {
    return {
      error: "Insufficient team passing-volume or wide-receiver efficiency data.",
      missingInputs: missing,
    };
  }

  const expectedReceptions = qbCompletionsPerGame * targetShare;
  const adjustedYpr = (wrYpr + opponentWrYprAllowed) / 2;
  const projection = expectedReceptions * adjustedYpr;

  return {
    formulaName: "WR receiving yards — official user-project formula",
    officialFormula: "(QB Average Completions × WR Target Share) × [(WR YPR + Opponent WR YPR Allowed) ÷ 2]",
    projection,
    inputs: {
      qbAverageCompletionsPerGame: round(qbCompletionsPerGame),
      wrTargetShare: round(targetShare, 4),
      expectedReceptions: round(expectedReceptions, 4),
      wrYardsPerReception: round(wrYpr, 4),
      opponentWrYardsPerReceptionAllowed: round(opponentWrYprAllowed, 4),
      adjustedYardsPerReception: round(adjustedYpr, 4),
    },
    calculation: `(${round(qbCompletionsPerGame, 2)} × ${round(targetShare * 100, 2)}%) × [(${round(wrYpr, 2)} + ${round(opponentWrYprAllowed, 2)}) ÷ 2] = ${round(projection, 2)} receiving yards`,
  };
}

function projectRunningBackCombined(player, defense, currentGames, priorGames, weightedAverages) {
  const carriesPerGame = Number(weightedAverages.carries || 0);
  const targetsPerGame = Number(weightedAverages.targets || 0);
  const playerYpc = weightedPlayerRate(currentGames, priorGames, "rushing_yards", "carries");
  const opponentYpcAllowed = weightedDefenseRate(
    defense, "RB", "rushing_yards", "carries"
  );
  const playerYpt = weightedPlayerRate(currentGames, priorGames, "receiving_yards", "targets");
  const opponentYptAllowed = weightedDefenseRate(
    defense, "RB", "receiving_yards", "targets"
  );

  const missing = [];
  if (carriesPerGame <= 0) missing.push("RB average rushing attempts per game");
  if (playerYpc === null) missing.push("RB rushing yards divided by carries");
  if (opponentYpcAllowed === null) missing.push("Opponent RB rushing yards allowed divided by RB carries allowed");
  if (targetsPerGame <= 0) missing.push("RB average targets per game");
  if (playerYpt === null) missing.push("RB receiving yards divided by targets");
  if (opponentYptAllowed === null) missing.push("Opponent RB receiving yards allowed divided by RB targets allowed");

  if (missing.length) {
    return {
      error: "Insufficient rushing or receiving data for the official combined RB formula.",
      missingInputs: missing,
    };
  }

  const adjustedYpc = (playerYpc + opponentYpcAllowed) / 2;
  const projectedRushing = carriesPerGame * adjustedYpc;
  const adjustedYpt = (playerYpt + opponentYptAllowed) / 2;
  const projectedReceiving = targetsPerGame * adjustedYpt;
  const projection = projectedRushing + projectedReceiving;

  return {
    formulaName: "RB rushing + receiving yards — official user-project formula",
    officialFormula: "(Carries × [(RB YPC + Opponent RB YPC Allowed) ÷ 2]) + (Targets × [(RB YPT + Opponent RB YPT Allowed) ÷ 2])",
    projection,
    inputs: {
      averageCarriesPerGame: round(carriesPerGame),
      rbYpc: round(playerYpc, 4),
      opponentRbYpcAllowed: round(opponentYpcAllowed, 4),
      adjustedYpc: round(adjustedYpc, 4),
      averageTargetsPerGame: round(targetsPerGame),
      rbYpt: round(playerYpt, 4),
      opponentRbYptAllowed: round(opponentYptAllowed, 4),
      adjustedYpt: round(adjustedYpt, 4),
      projectedRushingYards: round(projectedRushing),
      projectedReceivingYards: round(projectedReceiving),
    },
    calculation: `Rushing: ${round(carriesPerGame, 2)} × ${round(adjustedYpc, 2)} = ${round(projectedRushing, 2)}; Receiving: ${round(targetsPerGame, 2)} × ${round(adjustedYpt, 2)} = ${round(projectedReceiving, 2)}; Combined = ${round(projection, 2)} yards`,
  };
}

function weightedPlayerRate(currentGames, priorGames, numerator, denominator) {
  const currentRate = ratioFromGames(currentGames, numerator, denominator);
  const priorRate = ratioFromGames(priorGames, numerator, denominator);
  return weightedValue(currentRate, priorRate);
}

function weightedTargetShare(currentGames, priorGames) {
  const currentShare = ratioFromGames(
    currentGames, "targets", "teamPassAttempts"
  );
  const priorShare = ratioFromGames(
    priorGames, "targets", "teamPassAttempts"
  );
  return weightedValue(currentShare, priorShare);
}

function ratioFromGames(games, numerator, denominator) {
  if (!games || !games.length) return null;
  const num = sumField(games, numerator);
  const den = sumField(games, denominator);
  return den > 0 ? num / den : null;
}

function weightedGameMean(currentGames, priorGames, field) {
  const current = currentGames.length
    ? mean(currentGames.map(game => Number(game[field] || 0)))
    : null;
  const prior = priorGames.length
    ? mean(priorGames.map(game => Number(game[field] || 0)))
    : null;
  return weightedValue(current, prior);
}

function weightedDefenseRate(defense, position, numerator, denominator) {
  const availableSeasons = Object.keys(defense?.seasons || {})
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  const currentSeason = Number(defense.currentSeason) || availableSeasons[0];
  const priorSeason = Number(defense.priorSeason) ||
    availableSeasons.find(season => season < currentSeason);

  const currentRate = defenseSeasonRate(
    defense, currentSeason, position, numerator, denominator
  );
  const priorRate = priorSeason
    ? defenseSeasonRate(defense, priorSeason, position, numerator, denominator)
    : null;

  return weightedValue(currentRate, priorRate);
}

function defenseSeasonRate(defense, season, position, numerator, denominator) {
  const weekly = defense?.seasons?.[String(season)]?.[position]?.weekly || [];
  if (!weekly.length) return null;

  const num = weekly.reduce(
    (sum, game) => sum + Number(game.statsAllowed?.[numerator] || 0), 0
  );
  const den = weekly.reduce(
    (sum, game) => sum + Number(game.statsAllowed?.[denominator] || 0), 0
  );
  return den > 0 ? num / den : null;
}

function weightedValue(current, prior) {
  if (current !== null && prior !== null) return current * 0.90 + prior * 0.10;
  if (current !== null) return current;
  if (prior !== null) return prior;
  return null;
}

function buildSupportingFactors(player, currentGames, defense, position, market) {
  const recent = currentGames.slice(-5);
  const recentDefense = latestDefenseGames(defense, position, 5);

  const playerTrendFields = position === "QB"
    ? ["completions", "attempts", "passing_yards"]
    : position === "RB"
      ? ["carries", "rushing_yards", "targets", "receiving_yards"]
      : ["targets", "receptions", "receiving_yards"];

  const playerRecentAverages = {};
  for (const field of playerTrendFields) {
    playerRecentAverages[field] = round(mean(
      recent.map(game => Number(game[field] || 0))
    ));
  }

  const surfaceDataAvailable = currentGames.some(
    game => game.surface || game.field_surface
  );

  return {
    recentPlayerForm: {
      gamesReviewed: recent.length,
      perGameAverages: playerRecentAverages,
    },
    opponentRecentDefense: {
      gamesReviewed: recentDefense.length,
      perGameAllowed: summarizeDefenseGames(recentDefense, position),
    },
    playerSituation: {
      homeAwayDataAvailable: currentGames.some(game => game.homeAway),
      fieldSurfaceDataAvailable: surfaceDataAvailable,
      injuryAndStarterStatusVerified: false,
      offensiveLineAvailabilityVerified: false,
      gameScriptAssessmentAvailable: false,
    },
    instruction: "These are supporting information only. They do not change the official mathematical projection.",
  };
}

function latestDefenseGames(defense, position, count) {
  const seasonKey = String(defense.currentSeason);
  const weekly = defense?.seasons?.[seasonKey]?.[position]?.weekly || [];
  return [...weekly].sort((a, b) => Number(a.week) - Number(b.week)).slice(-count);
}

function summarizeDefenseGames(games, position) {
  if (!games.length) return {};
  const fields = position === "QB"
    ? ["passing_yards", "completions", "attempts"]
    : position === "RB"
      ? ["rushing_yards", "carries", "receiving_yards", "targets"]
      : ["receiving_yards", "receptions", "targets"];

  const result = {};
  for (const field of fields) {
    result[field] = round(mean(
      games.map(game => Number(game.statsAllowed?.[field] || 0))
    ));
  }
  return result;
}

function historyResults(currentGames, market, line, last) {
  const sorted = sortGames(currentGames);
  const recentGames = sorted.slice(-last).reverse();
  const valueFor = game => {
    if (market === "rushing_receiving_yards") {
      return Number(game.rushing_yards || 0) + Number(game.receiving_yards || 0);
    }
    return Number(game[market] || 0);
  };

  const values = recentGames.map(valueFor);
  const overHits = line === null
    ? null
    : values.filter(value => value > line).length;
  const pushes = line === null
    ? null
    : values.filter(value => value === line).length;
  const underHits = line === null
    ? null
    : values.length - overHits - pushes;

  return {
    gamesReviewed: values.length,
    overHits,
    underHits,
    pushes,
    historicalOverHitRate: line === null
      ? null
      : values.length
        ? round(overHits / values.length * 100, 1) + "%"
        : "No data",
    gameResults: recentGames.map(game => ({
      week: game.week,
      opponent: game.opponent,
      value: round(valueFor(game)),
    })),
    note: "Historical hit rate is descriptive and is not a projected probability.",
  };
}

function handleOdds(url) {
  const result = {};
  const oddsText = url.searchParams.get("american_odds");
  const probabilityText = url.searchParams.get("my_probability");
  const multiplierText = url.searchParams.get("payout_multiplier");
  const totalPayoutText = url.searchParams.get("total_payout");
  const entryCostText = url.searchParams.get("entry_cost");
  const combinedText = url.searchParams.get("probabilities");

  let impliedProbability = null;
  if (oddsText !== null) {
    const odds = Number(oddsText);
    if (!Number.isFinite(odds) || odds === 0) {
      return json({ error: "american_odds must be a non-zero number." }, 400);
    }
    impliedProbability = odds < 0
      ? Math.abs(odds) / (Math.abs(odds) + 100)
      : 100 / (odds + 100);
    result.americanOdds = odds;
    result.sportsbookImpliedProbability = round(impliedProbability * 100, 2) + "%";
  }

  let myProbability = null;
  if (probabilityText !== null) {
    myProbability = parseProbability(probabilityText);
    if (myProbability === null || myProbability < 0 || myProbability > 1) {
      return json({ error: "my_probability must be a probability from 0 to 1, or a percentage from 0 to 100." }, 400);
    }
    result.myProjectedProbability = round(myProbability * 100, 2) + "%";
  }

  if (impliedProbability !== null && myProbability !== null) {
    result.probabilityEdge = round(
      (myProbability - impliedProbability) * 100, 2
    ) + " percentage points";
    result.edgeFormula = "My Projected Probability − Sportsbook Implied Probability";
  }

  if (multiplierText !== null) {
    const multiplier = Number(multiplierText);
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      return json({ error: "payout_multiplier must be greater than zero." }, 400);
    }
    result.payoutMultiplier = multiplier;
    result.prizePicksBreakEvenProbability = round(100 / multiplier, 2) + "%";
    result.breakEvenFormula = "(1 ÷ Payout Multiplier) × 100";
  }

  if (totalPayoutText !== null || entryCostText !== null) {
    const totalPayout = Number(totalPayoutText);
    const entryCost = Number(entryCostText);
    if (
      myProbability === null ||
      !Number.isFinite(totalPayout) ||
      !Number.isFinite(entryCost) ||
      totalPayout < 0 ||
      entryCost < 0
    ) {
      return json({
        error: "Expected value requires my_probability, total_payout, and entry_cost as non-negative numbers.",
      }, 400);
    }
    result.expectedValue = round(
      (myProbability * totalPayout) - entryCost, 2
    );
    result.expectedValueFormula = "(Win Probability × Total Payout) − Entry Cost";
  }

  if (combinedText !== null) {
    const values = combinedText.split(",").map(parseProbability);
    if (
      values.length !== 3 ||
      values.some(value => value === null || value < 0 || value > 1)
    ) {
      return json({
        error: "probabilities must contain exactly three comma-separated probabilities from 0 to 1 or percentages from 0 to 100.",
      }, 400);
    }
    const combined = values.reduce((product, value) => product * value, 1);
    result.combinedProbability = round(combined * 100, 2) + "%";
    result.combinedProbabilityFormula = "P(Pick 1) × P(Pick 2) × P(Pick 3)";
    result.independenceAssumption =
      "This multiplication assumes the three picks are independent. Correlated picks require a joint probability estimate.";
  }

  if (!Object.keys(result).length) {
    return json({
      error: "Provide at least one odds input.",
      examples: [
        "/odds?american_odds=-110&my_probability=0.60",
        "/odds?payout_multiplier=2.3",
        "/odds?my_probability=0.55&total_payout=230&entry_cost=100",
        "/odds?probabilities=0.60,0.55,0.52",
      ],
    }, 400);
  }

  return json(result);
}

function parseProbability(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number > 1 ? number / 100 : number;
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
    for (const player of list) candidates.set(player.gsisId, player);
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

function sortGames(games) {
  return [...games].sort((a, b) => Number(a.week) - Number(b.week));
}

function sumField(games, field) {
  return games.reduce(
    (sum, game) => sum + Number(game[field] || 0), 0
  );
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function aggregate(games) {
  const fields = [
    "passing_yards", "passing_tds", "completions", "attempts",
    "rushing_yards", "carries", "rushing_tds",
    "receiving_yards", "receptions", "targets", "receiving_tds",
  ];
  const totals = {};
  for (const field of fields) totals[field] = sumField(games, field);
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
