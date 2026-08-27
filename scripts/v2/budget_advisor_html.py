#!/usr/bin/env python3
"""HTML dashboard for budget_advisor.py"""
import html, json

CSS = """<style>
:root,:root[data-theme="light"],:root[data-theme="dark"]{--paper:#FFF;--card:#FFF;--ink:#14181D;--ink2:#4A555E;--ink3:#7C8892;
--rule:rgba(20,24,29,.14);--accent:#1F4E6B;--pos:#2F6B4F;--warn:#9A6207;--neg:#9E3B2E;
--display:'Charter','Iowan Old Style',Georgia,serif;--body:'Avenir Next','Segoe UI',system-ui,sans-serif;
--mono:ui-monospace,'SF Mono',Menlo,monospace;color-scheme:light only;}
*{box-sizing:border-box}body{margin:0;background:#FFF;color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.55}
.wrap{max-width:78rem;margin:0 auto;padding:0 clamp(1rem,3vw,3rem)}
header{padding:2.6rem 0 1.6rem;border-bottom:2px solid var(--ink)}
h1{font-family:var(--display);font-weight:400;font-size:clamp(1.8rem,3.6vw,2.6rem);margin:0 0 .4rem;letter-spacing:-.02em}
h2{font-family:var(--display);font-weight:400;font-size:1.4rem;margin:0 0 .8rem}
.lbl{font-family:var(--mono);font-size:.64rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink3)}
.sub{color:var(--ink2);margin:0}
section{padding:2.4rem 0 0}
.verdict{border:2px solid var(--ink);padding:1.5rem 1.6rem;margin:1.6rem 0 0;display:flex;
  justify-content:space-between;gap:1.4rem;flex-wrap:wrap;align-items:center}
.verdict .big{font-family:var(--display);font-size:clamp(1.3rem,2.6vw,1.9rem);max-width:34ch;line-height:1.2}
.verdict .amt{font-family:var(--mono);font-size:clamp(1.6rem,3.4vw,2.4rem);font-weight:500;white-space:nowrap}
.go{border-color:var(--pos)}.go .amt{color:var(--pos)}
.warn{border-color:var(--warn)}.warn .amt{color:var(--warn)}
.stop{border-color:var(--neg)}.stop .amt{color:var(--neg)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));gap:1px;background:var(--rule);
  border:1px solid var(--rule);margin-top:1.4rem}
.kpis div{background:#FFF;padding:1.1rem 1rem;display:flex;flex-direction:column;gap:.25rem}
.kpis b{font-family:var(--mono);font-size:1.45rem;font-weight:500}
.kpis small{font-size:.74rem;color:var(--ink3)}
.scroll{overflow-x:auto;border:1px solid var(--rule);margin-top:1rem}
table{border-collapse:collapse;width:100%;font-size:.86rem;min-width:40rem}
th,td{padding:.5rem .7rem;text-align:right;border-bottom:1px solid var(--rule);white-space:nowrap}
th{font-family:var(--mono);font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);
  font-weight:400;background:#F6F6F3}
th:first-child,td:first-child{text-align:left}
td.n{font-family:var(--mono);font-variant-numeric:tabular-nums}
td.nm{font-family:var(--mono);font-size:.76rem;text-align:left}
tr.hi td{background:#F2F7F4}
.bar{height:26px;display:flex;border:1px solid var(--rule);margin:.9rem 0 .4rem;overflow:hidden}
.bar span{display:grid;place-items:center;font-family:var(--mono);font-size:.68rem;color:#FFF;font-weight:600}
.note{border-left:3px solid var(--warn);background:#FDFBF6;padding:1rem 1.2rem;margin-top:1.2rem;
  max-width:66ch;color:var(--ink2);font-size:.9rem}
.pos{color:var(--pos)}.neg{color:var(--neg)}.warnc{color:var(--warn)}
footer{margin-top:3rem;padding:1.6rem 0 2.6rem;border-top:1px solid var(--rule);display:flex;
  justify-content:space-between;gap:1rem;flex-wrap:wrap}
</style>"""

def rs(x):
    try: return f"&#8377;{round(float(x)):,}"
    except Exception: return "&#8377;0"

def render(s, outdir):
    lr = s["learning"]; cap = s["push"]; inc = s["incremental"]; cl = s["closing"]
    cls = "go" if cap["headroom"] > 0 and cap["factor"] >= 0.6 else ("warn" if cap["headroom"] > 0 else "stop")
    dod = inc.get("dod"); slope = inc.get("slope")
    o = [CSS, '<div class="wrap">']
    o.append(f'''<header><span class="lbl">Budget Advisor &middot; {html.escape(str(s["generated"])[:16].replace("T"," "))} IST</span>
<h1>Push, reactivate, or close &mdash; today&rsquo;s call.</h1>
<p class="sub">Target {s["target_orders"]:.0f} orders/day at {s["target_roas"]}&times;. Revenue is Shopify actuals; learning
share is measured on today&rsquo;s live adset spend. Incremental ROAS is what your <em>added</em> rupees earned &mdash; the
number that decides whether more budget helps.</p></header>''')

    o.append(f'''<div class="verdict {cls}">
<div class="big">{html.escape(cap["verdict"])}</div>
<div class="amt">{rs(cap["headroom"])}<span style="font-size:.9rem;color:var(--ink3)"> safe to add</span></div></div>''')

    proj = s.get("projected"); gap = (proj - s["target_orders"]) if proj else None
    o.append(f'''<div class="kpis">
<div><span class="lbl">Active budget</span><b>{rs(s["active_budget"])}</b><small>daily, live campaigns</small></div>
<div><span class="lbl">Spent today</span><b>{rs(s["spend_today"])}</b><small>so far</small></div>
<div><span class="lbl">Learning share</span><b>{100*lr["ratio"]:.0f}%</b><small>{lr["n_learning"]} of {lr["n_total"]} adsets</small></div>
<div><span class="lbl">Incremental ROAS</span><b class="{"pos" if (dod or 0)>=s["target_roas"] else ("warnc" if (dod or 0)>=1 else "neg")}">{dod if dod is not None else "n/a"}</b><small>median of last moves</small></div>
<div><span class="lbl">Orders today</span><b>{s["orders_today"]}</b><small>{"proj " + str(proj) if proj else "projecting"}</small></div>
<div><span class="lbl">vs target</span><b class="{"pos" if (gap or 0)>=0 else "neg"}">{f"{gap:+.0f}" if gap is not None else "n/a"}</b><small>orders</small></div>
</div>''')

    # learning bar
    tot = lr["spend_total"] or 1
    settled = max(0, tot - lr["spend_learning"])
    o.append(f'''<section><span class="lbl">1 &middot; Learning saturation</span><h2>How much of today&rsquo;s spend is still unstable.</h2>
<div class="bar"><span style="flex:{settled};background:#2F6B4F">SETTLED {rs(settled)}</span>
<span style="flex:{max(lr["spend_learning"],1)};background:#9A6207">LEARNING {rs(lr["spend_learning"])}</span></div>
<p class="sub" style="font-size:.86rem">Meta resets an adset&rsquo;s learning when its budget moves more than ~20%, so the
headroom above is 20% of active budget scaled down by how much is already learning{", and halved because incremental ROAS is under target" if cap["gate"]<1 and cap["gate"]>0 else ""}{", and zeroed because incremental ROAS is far below target" if cap["gate"]==0 else ""}.</p></section>''')

    # reactivation
    o.append(f'''<section><span class="lbl">2 &middot; Reactivation</span>
<h2>Paused campaigns clearing {s["reactivate_roas"]}&times; on 7-day data.</h2>''')
    rl = s["reactivation"]
    if not rl:
        o.append('<p class="sub">Nothing paused clears that bar right now.</p>')
    else:
        o.append('<div class="scroll"><table><thead><tr><th>Campaign</th><th>Portal</th><th>ROAS</th><th>Budget/day</th><th>7d spend</th><th>Orders</th><th>CAC</th><th>Fits headroom</th></tr></thead><tbody>')
        cum = 0
        for c in rl[:25]:
            cum += c["budget"]; fit = cum <= cap["headroom"]
            o.append(f'<tr class="{"hi" if fit else ""}"><td class="nm">{html.escape(c["name"][:46])}</td><td>{c["portal"]}</td>'
                     f'<td class="n">{c["roas"]:.2f}</td><td class="n">{rs(c["budget"])}</td><td class="n">{rs(c["spend"])}</td>'
                     f'<td class="n">{c["orders"]}</td><td class="n">{rs(c["cac"])}</td><td>{"yes" if fit else "&mdash;"}</td></tr>')
        o.append(f'<tr class="tot"><td><strong>{len(rl)} available</strong></td><td colspan="2"></td>'
                 f'<td class="n"><strong>{rs(sum(c["budget"] for c in rl))}</strong></td><td colspan="4"></td></tr>')
        o.append('</tbody></table></div>')
    o.append('</section>')

    # closing
    o.append(f'''<section><span class="lbl">3 &middot; Closing</span><h2>What you can switch off and still hit {s["target_orders"]:.0f}.</h2>
<p class="sub" style="font-size:.9rem">Active campaigns are producing about {cl["projected_active_orders"]:.0f} orders/day on 7-day
averages, leaving {cl["slack"]:+.1f} of slack against target.</p>''')
    if cl["closable"]:
        o.append(f'<p class="sub"><strong>Safe to close now: {len(cl["closable"])} campaigns, freeing {rs(cl["budget_freed"])} at a cost of ~{cl["orders_at_risk"]:.1f} orders/day.</strong></p>')
    else:
        o.append('<p class="sub"><strong>No safe closes &mdash; every active campaign is needed to reach target.</strong></p>')
    o.append('<div class="scroll"><table><thead><tr><th>Campaign</th><th>Portal</th><th>ROAS 7d</th><th>Budget/day</th><th>Orders/day</th><th>Verdict</th></tr></thead><tbody>')
    closable_ids = {c["id"] for c in cl["closable"]}
    for c in cl["candidates"]:
        v = "CLOSE" if c["id"] in closable_ids else ("keep — needed" if c["roas"] < 1 else "keep")
        o.append(f'<tr class="{"hi" if c["id"] in closable_ids else ""}"><td class="nm">{html.escape(c["name"][:46])}</td>'
                 f'<td>{c["portal"]}</td><td class="n">{c["roas"]:.2f}</td><td class="n">{rs(c["budget"])}</td>'
                 f'<td class="n">{c["orders_per_day"]:.1f}</td><td>{v}</td></tr>')
    o.append('</tbody></table></div></section>')

    # incremental
    o.append(f'''<section><span class="lbl">4 &middot; Incremental ROAS</span><h2>What your added rupees actually earned.</h2>
<div class="kpis" style="margin-top:.8rem">
<div><span class="lbl">Average ROAS</span><b>{inc.get("avg","n/a")}</b><small>shopify, whole book</small></div>
<div><span class="lbl">Incremental (slope)</span><b>{slope if slope is not None else "n/a"}</b><small>regression of rev on spend</small></div>
<div><span class="lbl">Incremental (day-over-day)</span><b>{dod if dod is not None else "n/a"}</b><small>median recent moves</small></div>
</div>
<div class="scroll"><table><thead><tr><th>Date</th><th>&Delta; spend</th><th>&Delta; revenue</th><th>Incremental ROAS</th><th>Read</th></tr></thead><tbody>''')
    for r in inc["series"][-10:]:
        v = r["inc"]
        read = "flat day" if v is None else ("earning above target" if v >= s["target_roas"] else
               ("above cost, below target" if v >= 1 else ("losing money" if v >= 0 else "destroying revenue")))
        klass = "" if v is None else ("pos" if v >= s["target_roas"] else ("warnc" if v >= 1 else "neg"))
        o.append(f'<tr><td class="n">{r["date"]}</td><td class="n">{r["dspend"]:+,}</td><td class="n">{r["drev"]:+,}</td>'
                 f'<td class="n {klass}">{v if v is not None else "&mdash;"}</td><td>{read}</td></tr>')
    o.append('</tbody></table></div>')
    if dod is not None:
        msg = ("Adding budget is earning above your target — push into the reactivation list above."
               if dod >= s["target_roas"] else
               "Added budget earns more than it costs but below target — push only into campaigns already proven above target."
               if dod >= 1 else
               "Added budget is losing money right now. Reallocate from the closing list instead of adding new spend.")
        o.append(f'<div class="note"><strong>Read:</strong> {msg} Average ROAS ({inc.get("avg")}) describes the whole book; '
                 f'incremental ({dod}) describes only the money you moved — always trust the second when deciding tomorrow.</div>')
    o.append('</section>')
    o.append('<footer><span class="lbl">Budget Advisor</span><span class="lbl">Studd Muffyn &middot; SML &middot; NBP</span></footer></div>')

    path = f"{outdir}/dashboard.html"
    with open(path, "w") as f: f.write("\n".join(o))
    return path
