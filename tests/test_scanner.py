import unittest
import json
from pathlib import Path
from types import SimpleNamespace

from scanner import allowed, category_for, money, normalize_item


class ScannerTests(unittest.TestCase):
    def test_brand_queries_are_unique(self):
        config = json.loads(Path("brands.json").read_text(encoding="utf-8"))
        queries = [brand["query"].casefold() for brand in config["brands"]]
        self.assertEqual(len(queries), len(set(queries)))

    def test_money_invalid_is_zero(self):
        self.assertEqual(money(None), 0)
        self.assertEqual(money("12.50"), 12.5)

    def test_normalize_item_builds_vinted_url_and_total(self):
        item = SimpleNamespace(
            id=123, price="40", total_item_price="43.20",
            item_box={"first_line": "Stone Island", "second_line": "M · Ottime"},
            url="/items/123-test", path=None,
            photos=[SimpleNamespace(url="https://img.example/1.jpg")], image=None,
            user=SimpleNamespace(login="venditore"), title="Felpa", currency="EUR",
        )
        self.assertEqual(normalize_item(item), {
            "id": "123", "title": "Felpa", "url": "https://www.vinted.it/items/123-test",
            "price": 40.0, "total": 43.2, "currency": "EUR",
            "details": "Stone Island · M · Ottime", "seller": "venditore",
            "image_url": "https://img.example/1.jpg",
            "favourites": 0,
        })

    def test_excluded_words_are_case_insensitive(self):
        self.assertFalse(allowed({"title": "Stone Island REPLICA", "details": "Felpa"}, ["replica"]))
        self.assertTrue(allowed({"title": "Stone Island originale", "details": "Felpa"}, ["replica"]))

    def test_categories_do_not_mix_tshirts_and_hoodies(self):
        self.assertEqual(category_for("Nike T-shirt vintage"), "tshirt")
        self.assertEqual(category_for("Nike felpa con cappuccio"), "hoodie")


if __name__ == "__main__":
    unittest.main()
