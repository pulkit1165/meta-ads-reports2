#!/usr/bin/env python3
"""Send the rendered report PNG to every WhatsApp recipient via the Cloud API.

Upload once to /media, then reuse that media id for every recipient.

Delivery reality: a free-form image only lands if that number messaged the bot in
the last 24h. Outside the window Meta needs an APPROVED TEMPLATE WITH AN IMAGE
HEADER — set WA_IMAGE_TEMPLATE to its name once one exists. Without it we fall
back to the existing text template so the number still gets the numbers.

  python3 send_wa_image.py --to 91XXXXXXXXXX   # explicit
  python3 send_wa_image.py --dry-run
"""
import argparse, json, os, pathlib, sys
import requests

SP = pathlib.Path(__file__).parent
REPO = SP.resolve().parents[2]
ENVS = [REPO / ".env", REPO / "whatsapp-bot/.env",
        pathlib.Path.home() / ".openclaw/workspace/.env"]


def load_env():
    for f in ENVS:
        if f.exists():
            for line in f.read_text().splitlines():
                if "=" in line and not line.startswith("#"):
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip().strip('"'))


def graph(path):
    return f"https://graph.facebook.com/{os.environ.get('WA_GRAPH_VERSION', 'v21.0')}/{path}"


def upload(png: pathlib.Path) -> str | None:
    """Upload the image, return media id."""
    with png.open("rb") as fh:
        r = requests.post(
            graph(f"{os.environ['WA_PHONE_NUMBER_ID']}/media"),
            headers={"Authorization": f"Bearer {os.environ['WA_ACCESS_TOKEN']}"},
            files={"file": (png.name, fh, "image/png")},
            data={"messaging_product": "whatsapp", "type": "image/png"},
            timeout=120)
    if not r.ok:
        print(f"upload failed: {r.status_code} {r.text[:300]}")
        return None
    return r.json().get("id")


def send_image(to: str, media_id: str, caption: str) -> tuple[bool, str]:
    r = requests.post(
        graph(f"{os.environ['WA_PHONE_NUMBER_ID']}/messages"),
        headers={"Authorization": f"Bearer {os.environ['WA_ACCESS_TOKEN']}",
                 "Content-Type": "application/json"},
        json={"messaging_product": "whatsapp", "to": to, "type": "image",
              "image": {"id": media_id, "caption": caption[:1020]}},
        timeout=60)
    return r.ok, ("" if r.ok else f"{r.status_code} {r.text[:240]}")


def send_image_template(to: str, media_id: str, params: list[str]) -> tuple[bool, str]:
    """Template whose HEADER is an image — the only way to push an image outside 24h."""
    name = os.environ.get("WA_IMAGE_TEMPLATE", "").strip()
    if not name:
        return False, "no WA_IMAGE_TEMPLATE configured"
    r = requests.post(
        graph(f"{os.environ['WA_PHONE_NUMBER_ID']}/messages"),
        headers={"Authorization": f"Bearer {os.environ['WA_ACCESS_TOKEN']}",
                 "Content-Type": "application/json"},
        json={"messaging_product": "whatsapp", "to": to, "type": "template",
              "template": {
                  "name": name,
                  "language": {"code": os.environ.get("WA_IMAGE_TEMPLATE_LANG", "en")},
                  "components": [
                      {"type": "header", "parameters": [
                          {"type": "image", "image": {"id": media_id}}]},
                      {"type": "body", "parameters": [
                          {"type": "text", "text": p} for p in params]},
                  ]}},
        timeout=60)
    return r.ok, ("" if r.ok else f"{r.status_code} {r.text[:240]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", default="", help="comma-separated numbers (else WA_REPORT_RECIPIENTS)")
    ap.add_argument("--png", default=str(SP / "report.png"))
    ap.add_argument("--caption", default="")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    load_env()

    png = pathlib.Path(a.png)
    if not png.exists():
        sys.exit(f"missing {png}")
    to = [n.strip().lstrip("+") for n in (a.to or os.environ.get("WA_REPORT_RECIPIENTS", "")).split(",")
          if n.strip()]
    if not to:
        sys.exit("no recipients: pass --to or set WA_REPORT_RECIPIENTS")
    if not os.environ.get("WA_ACCESS_TOKEN") or not os.environ.get("WA_PHONE_NUMBER_ID"):
        sys.exit("WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID not set")

    caption = a.caption or "Daily budget & closing report"
    print(f"{png.name} {png.stat().st_size/1024:.0f} KB → {len(to)} recipient(s)")
    if a.dry_run:
        print("dry-run:", ", ".join(to))
        return

    media_id = upload(png)
    if not media_id:
        sys.exit("could not upload image")
    print("media id:", media_id)

    sent = failed = 0
    for num in to:
        ok, err = send_image(num, media_id, caption)
        how = "image"
        if not ok and ("24" in err or "re-engagement" in err or "131047" in err or "template" in err.lower()):
            ok, err2 = send_image_template(num, media_id, [caption[:58]])
            how = "image-template"
            err = err if ok else f"{err} | {err2}"
        if ok:
            sent += 1
            print(f"  {num}: sent ({how})")
        else:
            failed += 1
            print(f"  {num}: FAILED {err}")
    print(f"sent {sent}, failed {failed}")


if __name__ == "__main__":
    main()
