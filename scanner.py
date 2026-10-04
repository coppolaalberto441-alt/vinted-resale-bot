from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.error
import urllib.request
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from vinted_scraper import AsyncVintedScraper


CONFIG_PATH = Path(__file__).with_name("brands.json")


def money(value: Any) -> float:
    try:
        return float(Decimal(str(value)))
    except (InvalidOperation, TypeError, ValueError):
        return 0.0


def normalize_item(item: Any) -> dict[str, Any] | None:
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
    }


def allowed(item: dict[str, Any], excluded: list[str]) -> bool:
    text = f"{item.get('title', '')} {item.get('details', '')}".lower()
    return not any(word.lower() in text for word in excluded)


async def scan_brand(scraper: AsyncVintedScraper, brand: dict[str, Any], excluded: list[str]) -> dict[str, Any]:
    query = str(brand["query"])
    params: dict[str, Any] = {
        "search_text": query,
        "order": "newest_first",
        "currency": "EUR",
        "page": 1,
        "per_page": 50,
        "price_from": str(brand.get("min_price", 10)),
    }
    items = await scraper.search(params)
    normalized = [result for item in items if (result := normalize_item(item)) and allowed(result, excluded)]
    return {"query": query, "items": normalized}


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


def send(worker_url: str, secret: str, scans: list[dict[str, Any]]) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for start in range(0, len(scans), 5):
        request = urllib.request.Request(
            f"{worker_url.rstrip('/')}/ingest",
            data=json.dumps({"scans": scans[start:start + 5]}).encode(),
            headers={
                "Authorization": f"Bearer {secret}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "Chrome/140.0.0.0 Safari/537.36",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"Cloudflare HTTP {error.code}: {error.read().decode(errors='replace')}") from error
        results.extend(payload.get("results", []))
    return {"ok": True, "results": results}


def main() -> None:
    worker_url = os.environ.get("WORKER_URL", "").strip()
    secret = os.environ.get("INGEST_SECRET", "").strip()
    if not worker_url or not secret:
        raise SystemExit("Mancano WORKER_URL o INGEST_SECRET")
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    scans = asyncio.run(collect(config))
    result = send(worker_url, secret, scans)
    published = sum(int(row.get("published", 0)) for row in result.get("results", []))
    print(f"Ricerche riuscite: {len(scans)}/{len(config['brands'])}; annunci pubblicati: {published}")


if __name__ == "__main__":
    main()
