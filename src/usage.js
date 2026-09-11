/**
 * Cloudflare Workers AI Neurons usage endpoint.
 *
 * GET /usage
 * Reads today's UTC-day Workers AI Neurons consumption from
 * Cloudflare GraphQL Analytics API and calculates the remaining
 * 10,000-Neuron daily allowance.
 */

const DAILY_FREE_NEURONS = 10000;
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function onRequestGet({ env }) {
  const token = await readSecret(env, "CLOUDFLARE_ANALYTICS_TOKEN");
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim();

  if (!token || !accountId) {
    return json({
      ok: false,
      error: "尚未設定 CLOUDFLARE_ANALYTICS_TOKEN 或 CLOUDFLARE_ACCOUNT_ID",
    }, 500);
  }

  // Workers AI free allocation resets at 00:00 UTC.
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);

  const query = `
    query GetWorkersAIUsage($accountTag: string, $start: Time) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          aiInferenceAdaptiveGroups(
            limit: 10000
            filter: { datetimeHour_geq: $start }
          ) {
            sum {
              totalNeurons
            }
          }
        }
      }
    }
  `;

  let response;
  try {
    response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: accountId,
          start: start.toISOString(),
        },
      }),
    });
  } catch (error) {
    return json({
      ok: false,
      error: `Cloudflare Analytics API 連線失敗：${error?.message || String(error)}`,
    }, 502);
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.errors?.length) {
    return json({
      ok: false,
      error: "Cloudflare Analytics API 查詢失敗",
      details: payload?.errors || [{ status: response.status }],
    }, 502);
  }

  const groups = payload?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups || [];
  const used = groups.reduce((sum, group) => {
    const value = Number(group?.sum?.totalNeurons || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);

  const remaining = Math.max(0, DAILY_FREE_NEURONS - used);
  const percent = DAILY_FREE_NEURONS > 0
    ? Math.min(100, (used / DAILY_FREE_NEURONS) * 100)
    : 0;

  const nextReset = new Date(start);
  nextReset.setUTCDate(nextReset.getUTCDate() + 1);

  return json({
    ok: true,
    dailyAllowance: DAILY_FREE_NEURONS,
    usedNeurons: used,
    remainingNeurons: remaining,
    usedPercent: Number(percent.toFixed(2)),
    resetAt: nextReset.toISOString(),
    timezone: "UTC",
    fetchedAt: now.toISOString(),
  });
}

async function readSecret(env, name) {
  let value = env?.[name];
  if (value && typeof value.get === "function") value = await value.get();
  return String(value || "").trim();
}
