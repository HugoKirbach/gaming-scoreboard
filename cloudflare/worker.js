// Relais Cloudflare Worker pour le classement.
//
// - POST /        : lance la mise à jour GitHub Actions (bouton « Actualiser » du site),
//                   au plus une fois toutes les COOLDOWN_SECONDS.
// - Cron Trigger  : lance la même mise à jour toutes les heures, de façon fiable.
//
// Secret à définir dans Cloudflare : GITHUB_TOKEN (jeton GitHub « fine-grained »,
// limité au dépôt, permission Actions : Read and write).
// Variable facultative : ALLOWED_ORIGIN (par défaut https://hugokirbach.github.io).

const REPO = "HugoKirbach/gaming-scoreboard";
const WORKFLOW = "classement.yml";
const BRANCH = "main";
const COOLDOWN_SECONDS = 5 * 60;

const GH = "https://api.github.com";

function gh(env, path, init = {}) {
  return fetch(`${GH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gaming-scoreboard-relay",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

async function latestRun(env) {
  const res = await gh(env, `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`);
  if (!res.ok) throw new Error(`GitHub ${res.status} en lisant les mises à jour`);
  const body = await res.json();
  return body.workflow_runs?.[0] ?? null;
}

async function dispatch(env) {
  const res = await gh(env, `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: BRANCH }),
  });
  if (res.status !== 204) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status} au lancement : ${detail.slice(0, 200)}`);
  }
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors },
  });
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || "https://hugokirbach.github.io";
    const cors = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") {
      return json({ ok: false, message: "Relais du classement : utilise le bouton « Actualiser » du site." }, 405, cors);
    }
    if (!env.GITHUB_TOKEN) return json({ ok: false, message: "Secret GITHUB_TOKEN manquant côté Cloudflare." }, 500, cors);

    try {
      const run = await latestRun(env);
      if (run && run.status !== "completed") {
        return json({ ok: true, state: "running", message: "Une actualisation est déjà en cours." }, 202, cors);
      }
      const age = run ? (Date.now() - Date.parse(run.created_at)) / 1000 : Infinity;
      if (age < COOLDOWN_SECONDS) {
        const retryAfter = Math.ceil(COOLDOWN_SECONDS - age);
        return json(
          { ok: false, state: "cooldown", retryAfter, message: "Données actualisées il y a moins de 5 minutes." },
          429,
          { ...cors, "Retry-After": String(retryAfter) }
        );
      }
      await dispatch(env);
      return json({ ok: true, state: "started", message: "Actualisation lancée." }, 202, cors);
    } catch (err) {
      return json({ ok: false, state: "error", message: String(err?.message ?? err) }, 502, cors);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
};
