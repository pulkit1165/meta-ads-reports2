#!/usr/bin/env python3
"""Port SM's Destiny landing page onto SML's live theme, one template per pack.

The section is copied from SM byte-for-byte — it is fully schema-driven and reads the
price off the real variant, so nothing in it is SM-specific except a logo URL and the
pack size, both of which are template settings. Keeping it identical means a future
change on SM can be re-copied here without a merge.

BLOCKED until SML's custom app is granted write_themes + write_theme_code. Everything
else (assigning the template to each product) only needs write_products, which it has.

    python3 deploy_sml.py            # dry run: says what it would do
    python3 deploy_sml.py --apply    # upload section + templates, assign to products
"""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request

DOM   = os.environ["SHOPIFY_STORE_URL_SML"]
TOK   = os.environ["SHOPIFY_ACCESS_TOKEN_SML"]
THEME = 162595504365          # SML live theme "Copy of fastrrv3<fastrLogin>Trade..."
LOGO  = ("https://studdmuffynlife.com/cdn/shop/files/"
         "studd-muffyn-life-logo_12bc7d42-1850-4563-8b0f-dd6027bfc315.png")

# pack size -> product handle on SML. NTN1130 is 3 questions here (it is 6 on SM).
PACKS = {3: "3-questions-for-399", 5: "5-questions-for-599", 10: "10-questions-for-999",
         15: "15-questions-for-1399", 20: "20-questions-for-1699"}

APPLY = "--apply" in sys.argv


def api(path, data=None, method=None):
    req = urllib.request.Request(
        f"https://{DOM}/admin/api/2024-10/{path}",
        data=json.dumps(data).encode() if data else None, method=method,
        headers={"X-Shopify-Access-Token": TOK, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=90))


def put_asset(key, value):
    if not APPLY:
        print(f"   would upload {key} ({len(value)} chars)")
        return
    try:
        a = api(f"themes/{THEME}/assets.json", {"asset": {"key": key, "value": value}}, "PUT")
        print(f"   uploaded {key} ({a['asset'].get('size')} bytes)")
    except urllib.error.HTTPError as e:
        if e.code == 403:
            sys.exit("   403 — SML's app still lacks write_themes. Add it in Shopify Admin "
                     "→ Apps → Develop apps → the astro app → Configuration → Admin API scopes, "
                     "then reinstall the app and update SHOPIFY_ACCESS_TOKEN_SML.")
        raise


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    section = open(os.path.join(here, "sm-destiny-landing.liquid")).read()
    base = json.load(open(os.path.join(here, "base-settings.json")))

    print("section:")
    put_asset("sections/sm-destiny-landing.liquid", section)

    print("templates:")
    for n in PACKS:
        t = json.loads(json.dumps(base))
        s = t["sections"]["main"]["settings"]
        s["topbar_logo_url"] = LOGO
        s["topbar_title"]    = f"{n} Questions — Astro Reading"
        s["b1_b"]            = f"{n} questions"
        put_asset(f"templates/product.destiny-{n}.json",
                  json.dumps(t, ensure_ascii=False, indent=2))
        time.sleep(0.4)

    print("products:")
    prods = {p["handle"]: p for p in
             api("products.json?limit=250&fields=id,handle,title,template_suffix")["products"]}
    for n, handle in PACKS.items():
        p = prods.get(handle)
        if not p:
            print(f"   !! {handle} not found on SML — skipped")
            continue
        suffix = f"destiny-{n}"
        if p.get("template_suffix") == suffix:
            print(f"   {handle} already on {suffix}")
            continue
        if not APPLY:
            print(f"   would set {handle} -> template_suffix={suffix}")
            continue
        api(f"products/{p['id']}.json",
            {"product": {"id": p["id"], "template_suffix": suffix}}, "PUT")
        print(f"   {handle} -> {suffix}")
        time.sleep(0.4)

    print("\nDry run only — re-run with --apply." if not APPLY else
          "\nDone. Check https://studdmuffynlife.com/products/5-questions-for-599")


if __name__ == "__main__":
    main()
