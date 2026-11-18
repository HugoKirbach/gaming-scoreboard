// Récupère le temps de jeu PSN de chaque joueur listé dans config.json
// et écrit docs/data.json (état actuel) + docs/history.json (historique).
//
// Usage : PSN_NPSSO=xxxxx node scripts/update.mjs
//
// S'appuie sur la librairie non officielle psn-api (https://psn-api.achievements.app).

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as psnModule from "psn-api";

const psn =
  typeof psnModule.exchangeNpssoForAccessCode === "function" ? psnModule : psnModule.default;

const ROOT = new URL("..", import.meta.url);
const CONFIG_PATH = new URL("config.json", ROOT);
const DATA_PATH = new URL("docs/data.json", ROOT);
const HISTORY_PATH = new URL("docs/history.json", ROOT);

const CATEGORIES = "ps4_game,ps5_native_game";
const PAGE_SIZE = 200;
const MAX_PAGES = 15;
const DELAY_BETWEEN_CALLS_MS = 400;
const MAX_HISTORY_POINTS = 4000;
// Si le dernier point date de plus longtemps que ça, on ajoute un point "juste avant"
// pour que la courbe ne monte pas en pente douce sur des heures où personne n'a joué.
const ANCHOR_GAP_MS = 90 * 60 * 1000;
const RUN_INTERVAL_MS = 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (onlineId) => String(onlineId).trim().toLowerCase();

/** "PT243H18M48S" -> 14598 (minutes) */
export function durationToMinutes(iso) {
  if (typeof iso !== "string") return 0;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(iso.trim());
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return Number(d) * 1440 + Number(h) * 60 + Number(min) + Math.floor(Number(s) / 60);
}

async function readJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch {
    return fallback;
  }
}

async function authenticate(npsso) {
  try {
    const accessCode = await psn.exchangeNpssoForAccessCode(npsso);
    return await psn.exchangeAccessCodeForAuthTokens(accessCode);
  } catch (err) {
    throw new Error(
      "Connexion au PSN refusée : le jeton NPSSO a probablement expiré (il dure environ 2 mois). " +
        "Récupère-en un nouveau sur https://ca.account.sony.com/api/v1/ssocookie et remplace le secret PSN_NPSSO. " +
        `(détail : ${err?.message ?? err})`
    );
  }
}

async function resolveAccount(auth, player, cache) {
  if (player.accountId) return { accountId: String(player.accountId), avatar: null };
  const key = keyOf(player.psn);
  if (cache[key]?.accountId) return cache[key];

  // 1) Recherche universelle (méthode recommandée par psn-api)
  try {
    const res = await psn.makeUniversalSearch(auth, player.psn, "SocialAllAccounts");
    const results = res?.domainResponses?.[0]?.results ?? [];
    const hit = results.find((r) => keyOf(r?.socialMetadata?.onlineId ?? "") === key);
    if (hit?.socialMetadata?.accountId) {
      return {
        accountId: String(hit.socialMetadata.accountId),
        avatar: hit.socialMetadata.avatarUrl ?? null,
      };
    }
  } catch {
    /* on tente la méthode de secours */
  }
  await sleep(DELAY_BETWEEN_CALLS_MS);

  // 2) Ancien endpoint de profil, en secours
  const legacy = await psn.getProfileFromUserName(auth, player.psn);
  const profile = legacy?.profile ?? {};
  if (!profile.accountId) throw new Error(`Pseudo PSN introuvable : ${player.psn}`);
  const avatars = profile.avatarUrls ?? [];
  return {
    accountId: String(profile.accountId),
    avatar: avatars[avatars.length - 1]?.avatarUrl ?? avatars[0]?.avatarUrl ?? null,
  };
}

async function fetchAllTitles(auth, accountId) {
  const titles = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await psn.getUserPlayedGames(auth, accountId, {
      categories: CATEGORIES,
      limit: PAGE_SIZE,
      offset,
    });
    titles.push(...(res?.titles ?? []));
    const next = res?.nextOffset;
    const total = res?.totalItemCount ?? titles.length;
    if (next == null || next <= offset || titles.length >= total) break;
    offset = next;
    await sleep(DELAY_BETWEEN_CALLS_MS);
  }
  return titles;
}

export function summarize(titles, gameRegex) {
  let gameMinutes = 0;
  let gameLastPlayed = null;
  let gameTitle = null;
  let allMinutes = 0;
  let top = null;

  for (const t of titles) {
    const minutes = durationToMinutes(t.playDuration);
    allMinutes += minutes;
    if (!top || minutes > top.minutes) top = { name: t.name, minutes };
    if (gameRegex.test(t.name ?? "")) {
      gameMinutes += minutes;
      gameTitle = gameTitle ?? t.name;
      if (t.lastPlayedDateTime && (!gameLastPlayed || t.lastPlayedDateTime > gameLastPlayed)) {
        gameLastPlayed = t.lastPlayedDateTime;
      }
    }
  }

  const lastPlayedAny = titles
    .map((t) => t.lastPlayedDateTime)
    .filter(Boolean)
    .sort()
    .pop() ?? null;

  return {
    game: { minutes: gameMinutes, lastPlayed: gameLastPlayed, title: gameTitle },
    all: { minutes: allMinutes, games: titles.length, top, lastPlayed: lastPlayedAny },
  };
}

async function fetchTrophyTitles(auth, accountId) {
  const titles = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await psn.getUserTitles(auth, accountId, { limit: 800, offset });
    const batch = res?.trophyTitles ?? [];
    titles.push(...batch);
    const total = res?.totalItemCount ?? titles.length;
    const next = res?.nextOffset ?? offset + batch.length;
    if (!batch.length || titles.length >= total || next <= offset) break;
    offset = next;
    await sleep(DELAY_BETWEEN_CALLS_MS);
  }
  return titles;
}

const GRADES = ["platinum", "gold", "silver", "bronze"];
const countOf = (o) => GRADES.reduce((s, g) => s + (Number(o?.[g]) || 0), 0);
const gradesOf = (o) => Object.fromEntries(GRADES.map((g) => [g, Number(o?.[g]) || 0]));

/** Trophées du jeu suivi (meilleure version si PS4 + PS5) et total tous jeux confondus. */
export function summarizeTrophies(trophyTitles, gameRegex) {
  const all = { earned: 0, ...gradesOf({}) };
  let game = null;
  for (const t of trophyTitles) {
    const earned = gradesOf(t.earnedTrophies);
    for (const g of GRADES) all[g] += earned[g];
    all.earned += countOf(earned);
    if (gameRegex.test(t.trophyTitleName ?? "")) {
      const candidate = {
        title: t.trophyTitleName,
        platform: t.trophyTitlePlatform ?? null,
        earned: countOf(earned),
        defined: countOf(t.definedTrophies),
        progress: Number(t.progress) || 0,
        grades: earned,
        hasPlatinum: (Number(t.definedTrophies?.platinum) || 0) > 0,
        updatedAt: t.lastUpdatedDateTime ?? null,
      };
      if (!game || candidate.progress > game.progress || candidate.earned > game.earned) game = candidate;
    }
  }
  return { game, all };
}

function classifyError(err) {
  const msg = String(err?.message ?? err);
  if (/introuvable|not found|404/i.test(msg)) return { status: "not_found", message: msg };
  if (/privacy|permit|forbidden|access|403|denied/i.test(msg)) return { status: "private", message: msg };
  return { status: "error", message: msg };
}

export function appendHistory(history, values, nowIso) {
  const points = history.points;
  const last = points[points.length - 1];
  const next = {
    t: nowIso,
    g: { ...(last?.g ?? {}), ...values.g },
    a: { ...(last?.a ?? {}), ...values.a },
  };
  const same = (x, y) => {
    const kx = Object.keys(x);
    return kx.length === Object.keys(y).length && kx.every((k) => x[k] === y[k]);
  };
  if (last && same(last.g, next.g) && same(last.a, next.a)) return false;

  if (last) {
    const anchorTime = Date.parse(nowIso) - RUN_INTERVAL_MS;
    if (anchorTime - Date.parse(last.t) > ANCHOR_GAP_MS) {
      points.push({ t: new Date(anchorTime).toISOString(), g: { ...last.g }, a: { ...last.a } });
    }
  }
  points.push(next);

  // Garde l'historique léger : on éclaircit la moitié la plus ancienne si besoin.
  while (points.length > MAX_HISTORY_POINTS) {
    const half = Math.floor(points.length / 2);
    const thinned = points.slice(0, half).filter((_, i) => i % 2 === 0);
    points.splice(0, half, ...thinned);
  }
  return true;
}

// Pseudos d'exemple laissés dans config.json : ignorés tant qu'ils ne sont pas remplacés.
const PLACEHOLDER = /^(TON_PSEUDO_PSN|PSEUDO_AMI_\d+)$/i;

function siteMeta(config) {
  const label = config.game?.label ?? "GTA VI";
  return {
    title: config.title ?? `Classement ${label}`,
    kicker: config.kicker ?? "PS5 · entre potes",
    subtitle: config.subtitle ?? `Qui passe le plus de temps sur ${label} ?`,
    game: { label, releaseDate: config.game?.releaseDate ?? null },
    refreshMinutes: RUN_INTERVAL_MS / 60000,
  };
}

async function main() {
  const config = await readJson(CONFIG_PATH, null);
  if (!config) throw new Error("config.json introuvable ou mal formé.");
  const meta = siteMeta(config);

  const configured = (config.players ?? [])
    .map((p, order) => ({ ...p, order }))
    .filter((p) => p.psn && !PLACEHOLDER.test(String(p.psn).trim()));
  const npsso = process.env.PSN_NPSSO?.trim();

  // Mise en place pas terminée : on publie la page en mode démo, sans échouer.
  const missing = [];
  if (!configured.length) missing.push("les pseudos PSN dans config.json");
  if (!npsso) missing.push("le jeton PSN (secret PSN_NPSSO)");
  if (missing.length) {
    const msg = `Il manque encore ${missing.join(" et ")}.`;
    console.log(`::warning::${msg} Le site est publié en mode démo.`);
    await writeFile(
      DATA_PATH,
      JSON.stringify({ ...meta, setup: true, setupMessage: msg, updatedAt: new Date().toISOString(), players: [] }, null, 2) + "\n"
    );
    return;
  }

  const gameRegex = new RegExp(config.game?.match ?? "grand\\s*theft\\s*auto\\s*(vi|6)\\b", "i");
  const history = await readJson(HISTORY_PATH, { accounts: {}, points: [] });
  history.accounts ??= {};
  history.points ??= [];

  // Nouveau jeu suivi : on repart de zéro pour sa courbe (l'historique « tous les jeux » est gardé).
  const gameSignature = String(gameRegex.source);
  if (history.gameMatch !== gameSignature) {
    for (const pt of history.points) pt.g = {};
    if (history.gameMatch) console.log("Jeu suivi modifié : historique du jeu remis à zéro.");
    history.gameMatch = gameSignature;
  }

  const auth = await authenticate(npsso);
  const nowIso = new Date().toISOString();
  const lastPoint = history.points[history.points.length - 1];

  const players = [];
  const values = { g: {}, a: {} };

  for (const player of configured) {
    const index = player.order;
    const key = keyOf(player.psn);
    const base = { key, psn: player.psn, name: player.name || player.psn, order: index };
    try {
      const account = await resolveAccount(auth, player, history.accounts);
      history.accounts[key] = account;
      await sleep(DELAY_BETWEEN_CALLS_MS);

      const titles = await fetchAllTitles(auth, account.accountId);
      const summary = summarize(titles, gameRegex);

      // Trophées : réglage de confidentialité séparé, donc lecture indépendante du temps de jeu.
      let trophies;
      try {
        await sleep(DELAY_BETWEEN_CALLS_MS);
        trophies = summarizeTrophies(await fetchTrophyTitles(auth, account.accountId), gameRegex);
      } catch (err) {
        trophies = { hidden: true, reason: classifyError(err).status };
        console.warn(`  trophées illisibles pour ${player.psn} : ${err?.message ?? err}`);
      }

      players.push({ ...base, avatar: account.avatar ?? null, status: "ok", ...summary, trophies });
      values.g[key] = summary.game.minutes;
      values.a[key] = summary.all.minutes;
      const tr = trophies.hidden
        ? "trophées masqués"
        : `trophées jeu ${trophies.game ? `${trophies.game.earned}/${trophies.game.defined}` : "—"} · total ${trophies.all.earned} (${trophies.all.platinum} platines)`;
      console.log(
        `✔ ${player.psn} : ${config.game?.label ?? "jeu"} ${summary.game.minutes} min · tous jeux ${summary.all.minutes} min (${titles.length} jeux) · ${tr}`
      );
    } catch (err) {
      const { status, message } = classifyError(err);
      const prevG = lastPoint?.g?.[key];
      const prevA = lastPoint?.a?.[key];
      const hasPrevious = prevG != null || prevA != null;
      players.push({
        ...base,
        avatar: history.accounts[key]?.avatar ?? null,
        status: hasPrevious ? "stale" : status,
        reason: status,
        message,
        game: { minutes: prevG ?? 0, lastPlayed: null, title: null },
        all: { minutes: prevA ?? 0, games: null, top: null, lastPlayed: null },
        trophies: null,
      });
      console.warn(`✖ ${player.psn} : ${message}`);
    }
    await sleep(DELAY_BETWEEN_CALLS_MS);
  }

  // Ne garde en cache que les joueurs encore présents dans la config
  const keys = new Set(configured.map((p) => keyOf(p.psn)));
  for (const k of Object.keys(history.accounts)) if (!keys.has(k)) delete history.accounts[k];

  const changed = appendHistory(history, values, nowIso);

  const data = { ...meta, updatedAt: nowIso, players };

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  await writeFile(HISTORY_PATH, JSON.stringify(history) + "\n");
  console.log(changed ? "Historique mis à jour." : "Aucun changement de temps de jeu depuis le dernier passage.");

  const okCount = players.filter((p) => p.status === "ok").length;
  if (okCount === 0) {
    throw new Error("Aucun joueur n'a pu être lu (pseudos ou paramètres de confidentialité à vérifier).");
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`\n${err?.message ?? err}`);
    process.exit(1);
  });
}
