/**
 * The module registry.
 *
 * Every report this business runs daily is one module here. The registry is the
 * single source of truth: the sidebar, the home grid and the cross-links all
 * read from it, so adding a module means adding one entry and one page rather
 * than editing four files and forgetting the fifth.
 *
 * `status` is deliberately part of the contract. A half-built module says so in
 * the UI instead of rendering an empty chart that looks like a zero.
 */
export type ModuleStatus = 'live' | 'partial' | 'planned';

export interface ModuleDef {
  slug: string;
  label: string;
  hint: string;
  section: SectionKey;
  status: ModuleStatus;
  /** What it answers, shown on the home grid. */
  question: string;
  /** Where its numbers come from, so a wrong figure can be traced. */
  source: string;
}

export type SectionKey = 'daily' | 'ads' | 'catalogue' | 'commerce' | 'customers' | 'intel' | 'admin';

export const SECTIONS: { key: SectionKey; label: string; blurb: string }[] = [
  { key: 'daily', label: 'Daily', blurb: 'The morning read, saved every day' },
  { key: 'ads', label: 'Ads', blurb: 'What we spent and what it closed' },
  { key: 'catalogue', label: 'Catalogue', blurb: 'Which products carry the spend' },
  { key: 'commerce', label: 'Commerce', blurb: 'Orders as the shop actually took them' },
  { key: 'customers', label: 'Customers', blurb: 'Who buys, and who stopped' },
  { key: 'intel', label: 'Intelligence', blurb: 'Patterns across every module' },
  { key: 'admin', label: 'Admin', blurb: 'Who can see what' },
];

export const MODULES: ModuleDef[] = [
  {
    slug: 'conversations',
    label: 'WhatsApp Conversations',
    hint: 'astro bot · open, paid, spent',
    section: 'customers',
    status: 'live',
    question: 'Who is talking to the astro bot, who bought, and who paid but has not asked yet?',
    source: 'astro.db on EC2 via the bot\'s token-gated /admin feed',
  },

  // ── Daily ──────────────────────────────────────────────────────────────
  {
    slug: 'brief',
    label: "Yesterday's Brief",
    hint: 'the ADS PLANNER report',
    section: 'daily',
    status: 'live',
    question: 'What happened yesterday, product by product, in the team-report format?',
    source: 'meta_analysis_ad_daily (ad level)',
  },

  {
    slug: 'continuous',
    label: '7 Days+ Continuous',
    hint: 'the stable book, ROAS-filterable',
    section: 'daily',
    status: 'live',
    question: 'Which mature campaigns run every day, and which of them are underperforming?',
    source: 'meta_analysis_campaign_daily + meta_campaign_snapshot',
  },
  {
    slug: 'portfolio',
    label: 'Portfolio by Age',
    hint: 'ROAS vs target, day 1 / 1-3 / 4-7 / 7+',
    section: 'daily',
    status: 'live',
    question: 'How does each campaign-age cohort perform against target, and what closed from which cohort?',
    source: 'meta_analysis_campaign_daily + meta_campaign_snapshot',
  },
  {
    slug: 'product-audience',
    label: 'Product × Audience',
    hint: 'allocation + tomorrow gaps',
    section: 'daily',
    status: 'live',
    question: 'Where is budget allocated by product and audience, and what should be pushed tomorrow?',
    source: 'camp_product_resolved + meta_campaign_snapshot',
  },

  // ── Ads ────────────────────────────────────────────────────────────────
  {
    slug: 'overview',
    label: 'Ads Overview',
    hint: 'CPM, CTR, CPC, RPM',
    section: 'ads',
    status: 'live',
    question: 'What does delivery cost, and is it worth what it costs?',
    source: 'meta_analysis_campaign_daily (impressions, clicks)',
  },
  {
    slug: 'closing',
    label: 'Closing Desk',
    hint: 'daily auto-close breakdown',
    section: 'ads',
    status: 'live',
    question: 'How much budget did the protocol switch off today, at what ROAS, and where?',
    source: 'meta_campaign_snapshot + meta_analysis_campaign_daily',
  },
  {
    slug: 'closing-log',
    label: 'Closing Log',
    hint: 'every cut, timed, bot or manual',
    section: 'ads',
    status: 'live',
    question: 'What was closed, at what time, at what burn, and by the bot or a person?',
    source: 'meta_campaign_snapshot status flips + bot_pause_event',
  },
  {
    slug: 'closing-daily',
    label: 'Daily Closing',
    hint: 'by 10am vs whole day, bot vs manual, push or minus',
    section: 'ads',
    status: 'live',
    question: 'How much of each day\u2019s book was closed, how early, by whom, and was the book pushed or cut?',
    source: 'camp_day_state + camp_close_event + bot_pause_event',
  },
  {
    slug: 'attempts',
    label: 'Attempts',
    hint: 'how often a shape is tried, and how it dies',
    section: 'ads',
    status: 'live',
    question: 'How many times have we tried this product in this block with this creative, and at what ROAS did those attempts get closed?',
    source: 'camp_day_state + meta_analysis_campaign_daily + camp_product_resolved',
  },
  {
    slug: 'blocks',
    label: 'Sales Blocks',
    hint: 'audience performance & closure',
    section: 'ads',
    status: 'live',
    question: 'Which audience blocks earn their budget, and which get closed out?',
    source: 'meta_analysis_campaign_daily.sale_block',
  },
  {
    slug: 'budget',
    label: 'Budget & ROAS',
    hint: 'day-wise split, ROAS buckets',
    section: 'ads',
    status: 'live',
    question: 'Where does the budget sit across ROAS bands, and how is that moving?',
    source: 'meta_analysis_campaign_daily',
  },
  {
    slug: 'creative',
    label: 'Creative Success',
    hint: 'type & sentiment hit rate',
    section: 'ads',
    status: 'live',
    question: 'Which creative types and sentiments clear 1.0 ROAS most often?',
    source: 'meta_analysis_campaign_daily.creative_type',
  },
  {
    slug: 'patterns',
    label: 'Winning Patterns',
    hint: 'block × product × creative × budget',
    section: 'ads',
    status: 'live',
    question: 'Which combination of settings actually produces a winner?',
    source: 'meta_analysis_campaign_daily + meta_camp_product_map',
  },

  // ── Catalogue ──────────────────────────────────────────────────────────
  {
    slug: 'products',
    label: 'Product Success',
    hint: 'per-product hit rate',
    section: 'catalogue',
    status: 'live',
    question: 'Which products win when we put budget behind them?',
    source: 'meta_camp_product_map + meta_analysis_campaign_daily',
  },
  {
    slug: 'allocation',
    label: 'Allocation',
    hint: 'website × product, 70/30',
    section: 'catalogue',
    status: 'live',
    question: 'Is spend split across products the way we intended?',
    source: 'meta_camp_product_map + meta_analysis_campaign_daily',
  },

  // ── Commerce ───────────────────────────────────────────────────────────
  {
    slug: 'orders',
    label: 'Orders',
    hint: 'live, all stores',
    section: 'commerce',
    status: 'live',
    question: 'What has the shop taken today, order by order?',
    source: 'Shopify Admin API (live)',
  },
  {
    slug: 'payments',
    label: 'Payments',
    hint: 'gateway & prepaid/COD split',
    section: 'commerce',
    status: 'live',
    question: 'How did yesterday get paid for?',
    source: 'shopify_orders.payment_mode + gateway from tags',
  },
  {
    slug: 'channels',
    label: 'App vs Website',
    hint: 'where orders come from',
    section: 'commerce',
    status: 'live',
    question: 'How much is the mobile app taking versus the website?',
    source: 'shopify_orders.tags (appmaker / App_android_device)',
  },

  // ── Customers ──────────────────────────────────────────────────────────
  {
    slug: 'cohorts',
    label: 'New vs Returning',
    hint: 'repeat rate by day',
    section: 'customers',
    status: 'live',
    question: 'What share of orders comes from someone who bought before?',
    source: 'shopify_orders.customer_phone, first-order lookup',
  },
  {
    slug: 'segments',
    label: 'Customer Segments',
    hint: 'VIP, Loyal, At risk',
    section: 'customers',
    status: 'live',
    question: 'Who are the valuable customers, and which of them are slipping away?',
    source: 'customer_lifetime (RFM scored)',
  },
  {
    slug: 'rfm',
    label: 'RFM Cohorts',
    hint: 'C1–C6, inflow & outflow',
    section: 'customers',
    status: 'live',
    question: 'Which recency window is filling up, and which is draining?',
    source: 'customer_lifetime + cohort_daily',
  },

  // ── Intelligence ───────────────────────────────────────────────────────
  {
    slug: 'signals',
    label: 'Signals',
    hint: 'read across every module',
    section: 'intel',
    status: 'live',
    question: 'What changed today that nobody asked about?',
    source: 'every module above',
  },

  // ── Admin ──────────────────────────────────────────────────────────────
  {
    slug: 'access',
    label: 'Access',
    hint: 'accounts and permissions',
    section: 'admin',
    status: 'live',
    question: 'Who can sign in, and which modules can each of them open?',
    source: 'dash_user',
  },
];

export const bySlug = (slug: string) => MODULES.find((m) => m.slug === slug);
export const inSection = (key: SectionKey) => MODULES.filter((m) => m.section === key);
