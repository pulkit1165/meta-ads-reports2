#!/usr/bin/env python3
"""
Resolve every campaign to a product and write it to Postgres.

The dashboard needs the same product grouping the reports use, and that lives in
portal_hourly.product_of() — a three-tier classifier (NTN SKU code, then a
keyword catalogue, then a cleaned slug) whose inputs are files in this repo, not
in the warehouse. Rather than port it to TypeScript and let the two drift, the
classifier runs here and writes its answer to a table the dashboard reads.

Idempotent: re-running reclassifies and upserts.
"""
from __future__ import annotations
import os, pathlib, sys, tempfile, subprocess

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import portal_hourly as ph  # noqa: E402

PGHOST = os.environ.get("PGHOST", "3.108.101.235")
PGUSER = os.environ.get("PGUSER", "prithvi")
PGDB = os.environ.get("PGDATABASE", "prithvi_master")
DAYS = int(os.environ.get("CAMP_PRODUCT_DAYS", "120"))

DDL = """
CREATE TABLE IF NOT EXISTS camp_product_resolved (
  campaign_id text PRIMARY KEY,
  portal      text,
  product     text,
  resolved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cpr_portal ON camp_product_resolved (portal);
CREATE INDEX IF NOT EXISTS cpr_product ON camp_product_resolved (product);
"""


def psql(sql: str, capture: bool = True) -> str:
    env = dict(os.environ)
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as fh:
        fh.write(sql)
        path = fh.name
    try:
        r = subprocess.run(
            ["psql", "-h", PGHOST, "-U", PGUSER, PGDB, "-v", "ON_ERROR_STOP=1",
             *(["-At"] if capture else []), "-f", path],
            capture_output=True, text=True, env=env)
        if r.returncode != 0:
            sys.exit(r.stderr[:500])
        return r.stdout
    finally:
        os.unlink(path)


def esc(v) -> str:
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"


def main() -> None:
    psql(DDL, capture=False)
    rows = psql(
        "SELECT DISTINCT ON (campaign_id) campaign_id, portal, campaign_name "
        "FROM meta_analysis_campaign_daily "
        f"WHERE date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date - {DAYS} "
        "ORDER BY campaign_id, date DESC;")
    tuples, seen = [], 0
    for line in rows.splitlines():
        parts = line.split("|")
        if len(parts) < 3:
            continue
        cid, portal, name = parts[0], parts[1], "|".join(parts[2:])
        seen += 1
        try:
            product = ph.product_of(name)
        except Exception:
            product = None
        tuples.append(f"({esc(cid)}, {esc(portal)}, {esc(product or 'Uncategorized')}, now())")

    print(f"campaigns: {seen}, classified: {len(tuples)}")
    for i in range(0, len(tuples), 500):
        psql(
            "INSERT INTO camp_product_resolved (campaign_id, portal, product, resolved_at) VALUES "
            + ",".join(tuples[i:i + 500])
            + " ON CONFLICT (campaign_id) DO UPDATE SET portal = EXCLUDED.portal, "
              "product = EXCLUDED.product, resolved_at = now();",
            capture=False)
    print("upserted", len(tuples))


if __name__ == "__main__":
    main()
