from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.error
import urllib.request
import http.cookiejar
import re
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from vinted_scraper import AsyncVintedScraper


CONFIG_PATH = Path(__file__).with_name("brands.json")

CATEGORY_WORDS = [
    ("shoes", ("scarpa", "scarpe", "sneaker", "stivale", "stivali", "boots", "dunk", "jordan")),
    ("hoodie", ("felpa", "felpe", "hoodie", "sweatshirt")),
    ("jacket", ("giacca", "giacche", "jacket", "coat", "cappotto", "piumino", "parka", "gilet", "smanicato")),
    ("trousers", ("pantalone", "pantaloni", "trousers", "jeans", "denim", "cargo", "shorts")),
    ("tshirt", ("t-shirt", "t shirt", "maglietta", "magliette", " tee ")),
    ("shirt", ("camicia", "camicie", "shirt", "polo")),
    ("knitwear", ("maglione", "maglioni", "maglioncino", "sweater", "knit", "cardigan")),
    ("dress", ("vestito", "abito", "dress")),
    ("skirt", ("gonna", "skirt")),
    ("tracksuit", ("tuta", "tute", "tracksuit")),
    ("hat", ("cappello", "cappelli", "berretto", "berretti", " cap ", "beanie")),
    ("bag", ("borsa", "borse", " bag ", "zaino", "backpack")),
    ("accessory", ("cintura", "cinture", "belt", "portafogli", "wallet", "occhiali", "watch", "orologio", "collana", "braccialetto")),
]


def category_for(text: str) -> str:
    searchable = f" {str(text).lower()} "
    return next((name for name, words in CATEGORY_WORDS if any(word in searchable for word in words)), "other")


def money(value: Any) -> float:
    try:
        return float(Decimal(str(value)))
    except (InvalidOperation, TypeError, ValueError):
        return 0.0


def normalize_item(item: Any) -> dict[str, Any] | None:
    raw = getattr(item, 'json_data', None) or {}
    if any(raw.get(flag) is True for flag in ('is_closed', 'is_sold', 'is_reserved')) or getattr(item, 'is_visible', None) is False:
        return None
    if item.id is None or item.price is None:
        return None
    price = money(item.price)
    total = money(item.total_item_price) or price
    if price <= 0 or total <= 0:
        return None
    item_box = getattr(item, "item_box", None) or {}
    relative_url = item.url or item.path or f"/items/{item.id}"
    url = relative_url if relative_url.startswith("http") else f"https://www.vinted.it{relative_url}"
    photos = getattr(item, "photos", None) or []
    image_url = photos[0].url if photos else getattr(item, "image", None)
    user = getattr(item, "user", None)
    seller = getattr(user, "login", None) if user else None
    details = " · ".join(filter(None, [
        str(item_box.get("first_line") or "").strip(),
        str(item_box.get("second_line") or "").strip(),
    ]))
    return {
        "id": str(item.id),
        "title": str(item.title or "Articolo Vinted"),
        "url": url,
        "price": price,
        "total": total,
        "currency": str(item.currency or "EUR"),
        "details": details,
        "seller": str(seller or "Non indicato"),
        "image_url": image_url,
        "favourites": int(getattr(item, "favourite_count", 0) or 0),
        "brand": str(getattr(item, "brand_title", None) or getattr(getattr(item, "brand", None), "title", None) or ""),
        "condition": str(getattr(item, "status", None) or ""),
    }


def collect_profile(profile_id: str) -> list[dict[str, Any]]:
    """Read the owner's public wardrobe without storing Vinted credentials."""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    headers = {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    }
    opener.open(urllib.request.Request(f"https://www.vinted.it/member/{profile_id}", headers=headers), timeout=30).read(1)
    endpoint = f"https://www.vinted.it/api/v2/wardrobe/{profile_id}/items?page=1&per_page=96"
    with opener.open(urllib.request.Request(endpoint, headers=headers), timeout=30) as response:
        rows = json.load(response).get("items", [])
    listings: list[dict[str, Any]] = []
    for item in rows:
        price_data = item.get("price") or {}
        photos = item.get("photos") or []
        brand = item.get("brand") or {}
        size = item.get("size") or {}
        photo_timestamp = ((photos[0].get("high_resolution") or {}).get("timestamp") if photos else None)
        published_at = None
        if photo_timestamp:
            try:
                published_at = datetime.fromtimestamp(int(photo_timestamp), timezone.utc).isoformat()
            except (ValueError, TypeError, OSError):
                pass
        listings.append({
            "id": str(item.get("id") or ""),
            "title": str(item.get("title") or "Articolo Vinted"),
            "url": str(item.get("url") or f"https://www.vinted.it{item.get('path', '')}"),
            "price": money(price_data.get("amount")),
            "currency": str(price_data.get("currency_code") or item.get("currency") or "EUR"),
            "brand": str(brand.get("title") if isinstance(brand, dict) else brand or ""),
            "size": str(size.get("title") if isinstance(size, dict) else size or ""),
            "status": str(item.get("status") or ""),
            "favourites": int(item.get("favourite_count") or 0),
            "image_url": str(photos[0].get("url") if photos else ""),
            "category": category_for(str(item.get("title") or "")),
            "published_at": published_at,
        })
    return [row for row in listings if row["id"] and row["url"].startswith("https://")]


def allowed(item: dict[str, Any], excluded: list[str]) -> bool:
    text = f"{item.get('title', '')} {item.get('details', '')}".lower()
    return not any(re.search(r"(?<!\w)" + re.escape(word.lower()) + r"(?!\w)", text) for word in excluded)


async def scan_brand(scraper: AsyncVintedScraper, brand: dict[str, Any], excluded: list[str]) -> dict[str, Any]:
    query = str(brand["query"])
    params: dict[str, Any] = {
        "search_text": query,
        "order": "newest_first",
        "currency": "EUR",
        "page": 1,
        "per_page": 50,
    }
    if brand.get("min_price") is not None:
        params["price_from"] = str(brand["min_price"])
    normalized = {}
    warnings = []
    diagnostics = {"received": 0, "invalid": 0, "excluded": 0, "duplicates": 0}
    seen_ids = set()
    for page in range(1, 3):
        try:
            items = await scraper.search({**params, "page": page})
        except Exception as error:
            if page == 1:
                raise
            warnings.append(f"Seconda pagina non disponibile: {type(error).__name__}")
            break
        for item in items:
            diagnostics["received"] += 1
            result = normalize_item(item)
            if not result:
                diagnostics["invalid"] += 1
                continue
            if result["id"] in seen_ids:
                diagnostics["duplicates"] += 1
                continue
            seen_ids.add(result["id"])
            if not allowed(result, excluded):
                diagnostics["excluded"] += 1
                continue
            normalized[result["id"]] = result
        if len(items) < 50:
            break
    return {"query": query, "items": list(normalized.values()), "checked_at": datetime.now(timezone.utc).isoformat(), "warnings": warnings, "diagnostics": diagnostics}


async def collect(config: dict[str, Any]) -> list[dict[str, Any]]:
    scraper = await AsyncVintedScraper.create(
        "https://www.vinted.it", locale="it-IT",
        config={"timeout": 30.0, "follow_redirects": True},
    )
    semaphore = asyncio.Semaphore(4)

    async def guarded(brand: dict[str, Any]) -> dict[str, Any]:
        async with semaphore:
            last_error: Exception | None = None
            for attempt in range(3):
                try:
                    return await scan_brand(scraper, brand, config["common_exclude"])
                except Exception as error:
                    last_error = error
                    await asyncio.sleep(2 ** attempt)
            raise RuntimeError(f"Vinted {brand['query']}: {last_error}") from last_error

    try:
        results = await asyncio.gather(*(guarded(brand) for brand in config["brands"]), return_exceptions=True)
    finally:
        await scraper.__aexit__(None, None, None)
    scans = []
    for result in results:
        if isinstance(result, Exception):
            print(str(result), file=sys.stderr)
        else:
            scans.append(result)
    if not scans:
        raise RuntimeError("Nessuna ricerca Vinted riuscita")
    return scans


def post_json(worker_url: str, secret: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{worker_url.rstrip('/')}{path}", data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "Mozilla/5.0"},
        method="POST",
    )
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors='replace')
            if attempt == 0 and error.code in (502, 503, 504) and 'quota_exhausted' not in detail:
                time.sleep(1)
                continue
            raise RuntimeError(f"Cloudflare HTTP {error.code}: {detail}") from error
        except urllib.error.URLError:
            if attempt:
                raise
            time.sleep(1)


def send(worker_url: str, secret: str, scans: list[dict[str, Any]], profile: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    errors = []
    for scan in scans:
        try:
            payload = post_json(worker_url, secret, "/ingest", {"scans": [scan]})
            if not payload.get("ok"):
                raise RuntimeError(str(payload.get("error") or "Invio non riuscito"))
            results.extend(payload.get("results", []))
        except Exception as error:
            message = f"{scan['query']}: {error}"
            print(message, file=sys.stderr)
            errors.append(message)
            # A shared exhausted quota affects all brands; do not hammer the service.
            if "quota_exhausted" in str(error):
                break
    if profile is not None:
        post_json(worker_url, secret, "/profile-ingest", {"items": profile})
    return {"ok": not errors, "results": results, "errors": errors}


def main() -> None:
    worker_url = os.environ.get("WORKER_URL", "").strip()
    secret = os.environ.get("INGEST_SECRET", "").strip()
    if not worker_url or not secret:
        raise SystemExit("Mancano WORKER_URL o INGEST_SECRET")
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    scans = asyncio.run(collect(config))
    profile_id = os.environ.get("VINTED_PROFILE_ID", "155300457").strip()
    result = send(worker_url, secret, scans)
    successful = {row["query"] for row in result["results"]}
    try:
        post_json(worker_url, secret, "/scan-summary", {
            "results": result["results"],
            "failed_brands": [brand["query"] for brand in config["brands"] if brand["query"] not in successful],
        })
    except Exception as error:
        print(f"Riepilogo non salvato: {error}", file=sys.stderr)
    profile = []
    try:
        profile = collect_profile(profile_id)
        post_json(worker_url, secret, "/profile-ingest", {"items": profile})
    except Exception as error:
        print(f"Profilo non aggiornato (ricerche indipendenti): {error}", file=sys.stderr)
    published = sum(int(row.get("published", 0)) for row in result.get("results", []))
    print(f"Ricerche riuscite: {len(scans)}/{len(config['brands'])}; profilo: {len(profile)} attivi; annunci pubblicati: {published}")
    if result["errors"]:
        raise SystemExit("Invii incompleti: controllare gli errori per brand riportati sopra")


if __name__ == "__main__":
    main()
