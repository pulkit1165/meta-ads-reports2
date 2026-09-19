import { q, n } from './db';
import { PORTALS } from './ads';

/**
 * Today's budget allocation, product by product and audience by audience —
 * the layout of the "product × audience blocks" workbook.
 *
 * CORE/SUPPORT comes from product_tier, which is seeded from that workbook
 * because the split is curated rather than derivable: Rope Chain sits in CORE
 * on Rs 7,500 of budget while Crystal RR is SUPPORT on Rs 18,950. Anything not
 * in the table falls to SUPPORT, which can never wrongly promote a product.
 */
export type Tier = 'CORE' | 'SUPPORT';

export interface AllocCampaign {
  campaignId: string;
  campaignName: string;
  portal: string;
  product: string;
  tier: Tier;
  audience: string;
  /** ACTIVE, or paused after having spent today */
  status: 'ACTIVE' | 'PAUSED TODAY' | 'PAUSED';
  budget: number;
  spendToday: number;
  revenueToday: number;
  spend7: number;
  revenue7: number;
}

/**
 * The audience code, read from the campaign name.
 *
 * The names carry the targeting the workbook labels with — ex30dp, inc180dp,
 * retarget, loose. sale_block holds the same idea as a long sentence, but the
 * workbook's codes come from the name, so these do too and the two agree.
 */
export function audienceCode(name: string): string {
  const s = (name || '').toLowerCase();
  if (/\bretarget|\brtg\b/.test(s)) return 'RTG';
  const ex = s.match(/ex(\d+)\s*dp/);
  if (ex) return `EX${ex[1]}DP`;
  const inc = s.match(/inc(\d+)\s*dp/);
  if (inc) return `INC${inc[1]}DP`;
  if (/\bex\d*\s*day\s*visitor|exvis/.test(s)) return 'EXVIS';
  if (/\bloose\b/.test(s)) return 'LOOSE';
  if (/\bconv\b|\bsales?\b/.test(s)) return 'CONV';
  return 'OTHER';
}

export async function allocationOn(
  day: string,
  portals: readonly string[] = PORTALS,
): Promise<AllocCampaign[]> {
  const rows = await q(
    `WITH daily AS (
       SELECT campaign_id,
              (array_agg(campaign_name ORDER BY date DESC))[1] AS campaign_name,
              (array_agg(portal        ORDER BY date DESC))[1] AS portal,
              (array_agg(COALESCE(NULLIF(product_name,''), 'Uncategorized')
                         ORDER BY date DESC))[1]               AS product,
              SUM(spend)   FILTER (WHERE date = $1::date) AS spend_today,
              SUM(revenue) FILTER (WHERE date = $1::date) AS rev_today,
              SUM(spend)   AS spend7,
              SUM(revenue) AS rev7
         FROM meta_analysis_ad_daily
        WHERE portal = ANY($2)
          AND date BETWEEN $1::date - 6 AND $1::date
        GROUP BY campaign_id
     ),
     snap AS (
       -- Budget and live status as at the newest capture of that day.
       SELECT DISTINCT ON (s.campaign_id)
              s.campaign_id, s.daily_budget, s.effective_status
         FROM meta_campaign_snapshot s
        WHERE s.snapshot_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
          AND s.snapshot_at <  ($1::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
        ORDER BY s.campaign_id, s.snapshot_at DESC
     )
     SELECT d.campaign_id, d.campaign_name, d.portal, d.product,
            COALESCE(sn.daily_budget, 0)             AS budget,
            COALESCE(sn.effective_status, 'UNKNOWN') AS status,
            COALESCE(d.spend_today, 0) AS spend_today,
            COALESCE(d.rev_today, 0)   AS rev_today,
            COALESCE(d.spend7, 0)      AS spend7,
            COALESCE(d.rev7, 0)        AS rev7,
            COALESCE(t.tier, 'SUPPORT') AS tier
       FROM daily d
       LEFT JOIN snap sn ON sn.campaign_id = d.campaign_id
       LEFT JOIN product_tier t
              ON t.portal = d.portal
             AND t.product_key = regexp_replace(lower(d.product), '[^a-z0-9]', '', 'g')
      WHERE COALESCE(d.spend_today,0) > 0 OR COALESCE(sn.daily_budget,0) > 0
      ORDER BY d.portal, d.product, COALESCE(d.spend_today,0) DESC`,
    [day, portals as string[]],
  );

  return rows.map((r) => {
    const spendToday = n(r.spend_today);
    const live = String(r.status) === 'ACTIVE';
    return {
      campaignId: String(r.campaign_id),
      campaignName: String(r.campaign_name ?? ''),
      portal: String(r.portal),
      product: String(r.product),
      tier: (String(r.tier) === 'CORE' ? 'CORE' : 'SUPPORT') as Tier,
      audience: audienceCode(String(r.campaign_name ?? '')),
      // "Paused today" is the useful state: it spent, then stopped. A campaign
      // that never spent and is paused was simply not part of the day.
      status: live ? 'ACTIVE' : spendToday > 0 ? 'PAUSED TODAY' : 'PAUSED',
      budget: n(r.budget),
      spendToday,
      revenueToday: n(r.rev_today),
      spend7: n(r.spend7),
      revenue7: n(r.rev7),
    };
  });
}

export interface ProductGroup {
  product: string;
  tier: Tier;
  active: number;
  pausedToday: number;
  budget: number;
  spendToday: number;
  revenueToday: number;
  spend7: number;
  revenue7: number;
  campaigns: AllocCampaign[];
}

export function groupByProduct(rows: AllocCampaign[]): ProductGroup[] {
  const m = new Map<string, ProductGroup>();
  for (const c of rows) {
    const g = m.get(c.product) ?? {
      product: c.product, tier: c.tier, active: 0, pausedToday: 0,
      budget: 0, spendToday: 0, revenueToday: 0, spend7: 0, revenue7: 0, campaigns: [],
    };
    if (c.status === 'ACTIVE') g.active += 1;
    if (c.status === 'PAUSED TODAY') g.pausedToday += 1;
    g.budget += c.budget;
    g.spendToday += c.spendToday;
    g.revenueToday += c.revenueToday;
    g.spend7 += c.spend7;
    g.revenue7 += c.revenue7;
    g.campaigns.push(c);
    m.set(c.product, g);
  }
  // CORE first, then by today's spend — the order the workbook reads in.
  return [...m.values()].sort((a, b) =>
    a.tier === b.tier ? b.spendToday - a.spendToday : a.tier === 'CORE' ? -1 : 1);
}

/* ── tomorrow's push: where the gaps are ────────────────────────────────── */

export type GapKind = 'constrained' | 'starved' | 'overfunded';

export interface Gap {
  kind: GapKind;
  campaign: AllocCampaign;
  utilisation: number;
  roas7: number;
  /** What the budget would become if the suggestion is taken. */
  suggestedBudget: number;
  /** Extra daily spend that implies, and what it would return at the 7-day rate. */
  deltaBudget: number;
  projectedRevenue: number;
  why: string;
}

const UTIL_FULL = 0.85;   // spending essentially all of its allowance
const UTIL_SLACK = 0.55;  // leaving a lot on the table
const GOOD = 1.3;         // clears break-even with margin
const POOR = 0.8;

/**
 * Three gaps worth acting on tomorrow, in order of confidence.
 *
 * A *constrained* campaign is the strongest signal in the set: it spent nearly
 * all of its budget and returned well above break-even, so the budget — not the
 * audience or the creative — is what is limiting it. The projection assumes the
 * extra spend returns at the campaign's own 7-day rate, which is an assumption
 * and is labelled as one: new budget usually buys slightly worse impressions
 * than the budget already running, so treat it as a ceiling.
 *
 * A *starved* campaign returns well but cannot spend what it already has.
 * Raising its budget would change nothing — the constraint is elsewhere — so it
 * is reported without a suggested increase.
 */
export function findGaps(rows: AllocCampaign[], minSpend = 1000): Gap[] {
  const out: Gap[] = [];
  for (const c of rows) {
    if (c.budget <= 0 || c.spendToday < minSpend) continue;
    const util = c.spendToday / c.budget;
    const roas7 = c.spend7 > 0 ? c.revenue7 / c.spend7 : 0;

    if (util >= UTIL_FULL && roas7 >= GOOD) {
      const suggested = Math.round((c.budget * 1.25) / 100) * 100;
      const delta = suggested - c.budget;
      out.push({
        kind: 'constrained', campaign: c, utilisation: util, roas7,
        suggestedBudget: suggested, deltaBudget: delta,
        projectedRevenue: delta * roas7,
        why: `Spent ${(util * 100).toFixed(0)}% of its budget at ${roas7.toFixed(2)} over 7 days — the budget is the limit, not the audience.`,
      });
    } else if (util <= UTIL_SLACK && roas7 >= 1.5) {
      out.push({
        kind: 'starved', campaign: c, utilisation: util, roas7,
        suggestedBudget: c.budget, deltaBudget: 0, projectedRevenue: 0,
        why: `Returns ${roas7.toFixed(2)} but only spent ${(util * 100).toFixed(0)}% of what it already has. More budget will not help; the audience or the bid is the constraint.`,
      });
    } else if (util >= 0.7 && roas7 > 0 && roas7 < POOR) {
      const suggested = Math.round((c.budget * 0.6) / 100) * 100;
      out.push({
        kind: 'overfunded', campaign: c, utilisation: util, roas7,
        suggestedBudget: suggested, deltaBudget: suggested - c.budget,
        projectedRevenue: (suggested - c.budget) * roas7,
        why: `Spending ${(util * 100).toFixed(0)}% of budget at ${roas7.toFixed(2)} — it converts budget into loss reliably.`,
      });
    }
  }
  return out.sort((a, b) => Math.abs(b.projectedRevenue) - Math.abs(a.projectedRevenue));
}

export interface ProductGap {
  product: string;
  tier: Tier;
  budget: number;
  spendToday: number;
  roas7: number;
  headroom: number;
}

/**
 * Products that earn more than the book and are not being funded like it.
 * Headroom is the budget that would bring the product up to the portal's
 * average utilisation, which is a floor on what it could absorb.
 */
export function productGaps(groups: ProductGroup[]): ProductGap[] {
  const totalBudget = groups.reduce((s, g) => s + g.budget, 0);
  const totalSpend = groups.reduce((s, g) => s + g.spendToday, 0);
  const bookRoas = (() => {
    const sp = groups.reduce((s, g) => s + g.spend7, 0);
    return sp > 0 ? groups.reduce((s, g) => s + g.revenue7, 0) / sp : 0;
  })();
  if (!totalBudget || !bookRoas) return [];

  const bookShare = totalSpend / totalBudget;
  return groups
    .map((g) => {
      const roas7 = g.spend7 > 0 ? g.revenue7 / g.spend7 : 0;
      const util = g.budget > 0 ? g.spendToday / g.budget : 0;
      return {
        product: g.product, tier: g.tier, budget: g.budget,
        spendToday: g.spendToday, roas7,
        headroom: util >= bookShare ? g.spendToday * 0.25 : 0,
      };
    })
    .filter((p) => p.roas7 >= bookRoas && p.headroom > 0)
    .sort((a, b) => b.headroom * b.roas7 - a.headroom * a.roas7);
}
