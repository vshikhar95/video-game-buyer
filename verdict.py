#!/usr/bin/env python3
"""Is this bundle worth it vs Steam India historical lows?

usage: verdict.py <fanatical bundle URL or slug | ITAD bundle id> [--all]
  --all: count every unowned game as wanted, ignoring the wishlist
  e.g. verdict.py https://www.fanatical.com/en/pick-and-mix/build-your-own-killer-bundle
       verdict.py 16638          (any store ITAD tracks, e.g. Humble)

.env: ITAD_API_KEY (required); STEAM_ID (wishlist, needs public profile);
      STEAM_API_KEY (owned games, needs public game details); FOREX_MARKUP (default 0.04)
"""
import json, sys, urllib.request
from pathlib import Path

ENV = {k.strip(): v.strip() for k, v in
       (l.split("=", 1) for l in (Path(__file__).parent / ".env").read_text().splitlines() if "=" in l)}
KEY = ENV["ITAD_API_KEY"]
ITAD = "https://api.isthereanydeal.com"
FANATICAL_MCP = "https://mcp.fanatical.com/mcp"
STEAM = 61


def post(url, body=None, headers=None):
    h = {"Content-Type": "application/json", "User-Agent": "bundle-verdict", **(headers or {})}
    return urllib.request.urlopen(urllib.request.Request(url, json.dumps(body).encode() if body else None, h))


def get(url, body=None):
    return json.load(post(url, body))


def fanatical(tool, args):
    """Call a tool on Fanatical's public MCP server (streamable HTTP, needs a session)."""
    h = {"Accept": "application/json, text/event-stream"}
    init = {"jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "verdict", "version": "1"}}}
    h["Mcp-Session-Id"] = post(FANATICAL_MCP, init, h).headers["Mcp-Session-Id"]
    post(FANATICAL_MCP, {"jsonrpc": "2.0", "method": "notifications/initialized"}, h)
    body = post(FANATICAL_MCP, {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                "params": {"name": tool, "arguments": args}}, h).read().decode()
    data = next(json.loads(l[5:]) for l in body.splitlines() if l.startswith("data:"))
    return json.loads(data["result"]["content"][0]["text"])


def load_bundle(arg):
    """-> name, pick_and_mix, tiers [(qty, total_price, currency, [titles])], {title: itad_id}"""
    if arg.isdigit():
        for offset in range(0, 500, 50):
            page = get(f"{ITAD}/bundles/v1?key={KEY}&country=IN&limit=50&offset={offset}&mature=true")
            b = next((b for b in page if b["id"] == int(arg)), None)
            if b:
                tiers = [(None, t["price"]["amount"] if t["price"] else None, t["price"] and t["price"]["currency"],
                          [g["title"] for g in t["games"]]) for t in b["tiers"]]
                ids = {g["title"]: g["id"] for t in b["tiers"] for g in t["games"]}
                return f"{b['title']} ({b['page']['name']}, ends {b.get('expiry')})", False, tiers, ids
            if len(page) < 50:
                break
        sys.exit(f"bundle {arg} not found among active ITAD bundles")

    r = fanatical("get_product", {"slug": arg.rstrip("/").split("/")[-1].split("?")[0], "region": "IN", "include_related": False})
    p = r["product"] or sys.exit("not found on Fanatical (or not sold in India)")
    tiers = [(t["tier_product_count"], t["price"], r["currency"], [g["name"] for g in t["products"] if g["type"] == "game"])
             for t in p["bundle_tiers"] or []]
    pick = len(tiers) > 1 and not any(t[3] for t in tiers[1:])  # pick-and-mix lists its pool only in tier 1
    titles = [g for t in tiers for g in t[3]]
    ids = {t: i for t, i in get(f"{ITAD}/lookup/id/title/v1?key={KEY}", titles).items() if i}
    if missing := set(titles) - set(ids):
        print("not on ITAD (ignored):", ", ".join(missing))
    return f"{p['name']} (Fanatical, {r['currency']})", pick, tiers, ids


def steam_sets():
    owned = wish = None
    if sid := ENV.get("STEAM_ID"):
        r = get(f"https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid={sid}")
        wish = {i["appid"] for i in r.get("response", {}).get("items", [])}
        if ENV.get("STEAM_API_KEY"):
            r = get(f"https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/"
                    f"?key={ENV['STEAM_API_KEY']}&steamid={sid}&include_free_sub=1")
            owned = {g["appid"] for g in r.get("response", {}).get("games", [])}
    return owned, wish


def best_picks(candidates, tiers, fx):
    """Pick-and-mix: try every count n, priced at the per-item rate of the highest tier n reaches;
    keep the n with the most Steam-low value over cost.
    candidates sorted by Steam low desc; tiers [(qty, total_usd)]. -> (n, cost_inr, value_inr, picks) or None"""
    best = None
    for n in range(tiers[0][0], len(candidates) + 1):
        qty, total = max(t for t in tiers if t[0] <= n)
        picks = candidates[:n]
        cost, value = n * total / qty * fx, sum(r[2] for r in picks)
        if best is None or value - cost > best[2] - best[1]:
            best = (n, cost, value, picks)
    return best


def main():
    name, pick, tiers, ids = load_bundle(sys.argv[1])
    rate = get("https://open.er-api.com/v6/latest/USD")["rates"]["INR"]
    fx = rate * (1 + float(ENV.get("FOREX_MARKUP", 0.04)))
    gids = list(ids.values())
    prices = {p["id"]: p for p in get(f"{ITAD}/games/overview/v2?key={KEY}&country=IN&shops={STEAM}", gids)["prices"]}
    appids = {gid: int(app[4:]) for gid, v in get(f"{ITAD}/lookup/shop/{STEAM}/id/v1", gids).items()
              if (app := next((s for s in v or [] if s.startswith("app/")), None))}  # list may start with sub/
    owned, wish = steam_sets()
    if unmapped := [t for t, g in ids.items() if g not in appids]:
        print("no Steam app id, ownership unknown:", ", ".join(unmapped))

    rows = []
    for title, gid in ids.items():
        p, app = prices.get(gid, {}), appids.get(gid)
        low = (p.get("lowest") or {}).get("price", {}).get("amount")
        cur = (p.get("current") or {}).get("price", {}).get("amount")
        status = ("OWNED" if owned and app in owned else "WISH" if wish and app in wish else
                  "new" if wish is not None else "?")
        rows.append((title, status, low or 0, cur))
    rows.sort(key=lambda r: -r[2])

    print(f"{name}\nUSD→INR {rate:.2f}, with card markup {fx:.2f}\n")
    print(f"{'game':40} {'status':6} {'steam low':>9} {'steam now':>9}")
    for t, s, low, cur in rows:
        print(f"{t[:40]:40} {s:6} {low or '-':>9} {cur or '-':>9}")

    use_wish = wish is not None and "--all" not in sys.argv
    wanted = [r for r in rows if r[1] == "WISH"] if use_wish else [r for r in rows if r[1] != "OWNED"]
    print()
    if pick:
        b = best_picks(wanted, [(q, p) for q, p, _, _ in tiers], fx)
        if not b:
            print(f"SKIP: only {len(wanted)} wanted games, minimum pick is {tiers[0][0]}")
        else:
            qty, cost, value, picks = b
            print(f"Best: pick {qty} for ₹{cost:.0f} vs Steam India lows ₹{value:.0f}  →  {'BUY' if value > cost else 'SKIP'}")
            print("  " + ", ".join(r[0] for r in picks))
    else:
        seen = set()
        for qty, price, cur, titles in tiers:
            seen |= set(titles)
            if price is None:
                continue
            inr = price * (fx if cur == "USD" else 1)
            value = sum(r[2] for r in wanted if r[0] in seen)
            print(f"Tier {price} {cur} (₹{inr:.0f}): wanted games' Steam India lows ₹{value:.0f}  →  "
                  f"{'BUY' if value > inr else 'SKIP'}")
    if not use_wish:
        print("\n(counting every unowned game as wanted: this overstates value)")


def _check():
    rows = [("a", "new", 500, 0), ("b", "new", 300, 0), ("c", "new", 50, 0), ("d", "new", 40, 0)]
    assert best_picks(rows, [(2, 2.0), (4, 3.0)], 100) == (2, 200.0, 800, rows[:2])  # 600 net beats 590
    assert best_picks(rows, [(2, 2.0)], 100)[0] == 2  # 3rd game's 50 low < 100 per item: stop
    assert best_picks(rows, [(2, 0.4)], 100)[0] == 4  # 40 per item: in-between counts allowed
    assert best_picks(rows[:1], [(2, 2.0)], 100) is None


if __name__ == "__main__":
    _check()
    main()
