import unittest
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock
import asyncio

from scanner import allowed, category_for, money, normalize_item, send, scan_brand


class ScannerTests(unittest.TestCase):
    def test_gap_replaces_carsicko_without_changing_brand_count(self):
        config = json.loads(Path('brands.json').read_text(encoding='utf-8'))
        queries = [brand['query'] for brand in config['brands']]
        self.assertEqual(queries.count('Gap'), 1)
        self.assertNotIn('Carsicko', queries)
        self.assertEqual(len(queries), 40)

    def test_unavailable_catalog_items_are_not_normalized(self):
        for flag in ('is_sold', 'is_reserved', 'is_closed'):
            self.assertIsNone(normalize_item(SimpleNamespace(json_data={flag: True})))
        self.assertIsNone(normalize_item(SimpleNamespace(is_visible=False)))

    def test_genuine_new_with_tags_is_not_excluded(self):
        config = json.loads(Path('brands.json').read_text(encoding='utf-8'))
        self.assertTrue(allowed({'title': 'Felpa nuovo con cartellino etichetta originale'}, config['common_exclude']))
        self.assertTrue(allowed({'title': 'Giacca outdoor coverall'}, config['common_exclude']))
        self.assertFalse(allowed({'title': 'Felpa replica'}, config['common_exclude']))

    def test_one_failed_brand_does_not_cancel_following_brands(self):
        with patch('scanner.post_json', side_effect=[RuntimeError('HTTP 500'), {'ok': True, 'results': [{'published': 1}]}]) as post:
            result = send('https://test', 'test', [{'query': 'First'}, {'query': 'Second'}])
        self.assertEqual(post.call_count, 2)
        self.assertEqual(result['results'], [{'published': 1}])
        self.assertEqual(len(result['errors']), 1)

    def test_two_pages_deduplicate_and_do_not_have_an_implicit_price_floor(self):
        scraper = SimpleNamespace(search=AsyncMock(side_effect=[list(range(50)), [49, 50]]))
        with patch('scanner.normalize_item', side_effect=lambda n: {'id': str(n), 'title': 'Felpa', 'brand': 'Test', 'price': 2}):
            result = asyncio.run(scan_brand(scraper, {'query': 'Test'}, []))
        self.assertEqual(len(result['items']), 51)
        self.assertEqual(result['diagnostics']['duplicates'], 1)
        self.assertNotIn('price_from', scraper.search.call_args_list[0].args[0])
        self.assertEqual(scraper.search.call_args_list[1].args[0]['page'], 2)

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
            "brand": "Stone Island", "condition": "Ottime", "size": "M",
        })

    def test_exact_brand_search_rejects_foreign_and_unknown_brands(self):
        scraper = SimpleNamespace(search=AsyncMock(return_value=[1, 2, 3, 4]))
        rows = {1: {'id': '1', 'title': 'Felpa', 'brand': 'Jaded London'},
                2: {'id': '2', 'title': 'Jaded London style', 'brand': 'Nike'},
                3: {'id': '3', 'title': 'Jaded London hoodie', 'brand': ''},
                4: {'id': '4', 'title': 'Felpa', 'brand': 'Jaded London Kids'}}
        with patch('scanner.normalize_item', side_effect=rows.get):
            result = asyncio.run(scan_brand(scraper, {'query': 'Jaded London', 'brand_ids': [170260]}, []))
        self.assertEqual([row['id'] for row in result['items']], ['1'])
        params = scraper.search.call_args_list[0].args[0]
        self.assertEqual(params['attribute_ids[brand]'], '170260')
        self.assertNotIn('search_text', params)
        self.assertEqual(result['diagnostics']['brand_mismatch'], 2)
        self.assertEqual(result['diagnostics']['brand_unknown'], 1)

    def test_all_configured_brands_fail_closed_and_aliases_are_explicit(self):
        from scanner import brand_matches
        config = json.loads(Path('brands.json').read_text(encoding='utf-8'))
        for brand in config['brands']:
            self.assertTrue(brand_matches(brand['query'], brand))
            self.assertFalse(brand_matches('Nike', brand))
            self.assertFalse(brand_matches('', brand))
        self.assertTrue(brand_matches('Stüssy', {'query': 'Stussy'}))
        self.assertTrue(brand_matches('Carhartt WIP', {'query': 'Carhartt', 'aliases': ['Carhartt WIP']}))
        self.assertFalse(brand_matches('Nike x Stüssy', {'query': 'Stussy'}))

    def test_scarce_hoodies_get_one_bounded_reference_search_without_new_candidates(self):
        current = [{'id': 'target', 'title': 'Hoodie', 'brand': 'Jaded London'},
                   {'id': 'pants', 'title': 'Jeans', 'brand': 'Jaded London'}]
        reference = [{'id': 'p1', 'title': 'Hoodie', 'brand': 'Jaded London'},
                     {'id': 'p2', 'title': 'Hoodie', 'brand': 'Nike'},
                     {'id': 'target', 'title': 'Hoodie', 'brand': 'Jaded London'},
                     {'id': 'p3', 'title': 'Jeans', 'brand': 'Jaded London'}]
        scraper = SimpleNamespace(search=AsyncMock(side_effect=[current, reference]))
        with patch('scanner.normalize_item', side_effect=lambda row: row):
            result = asyncio.run(scan_brand(scraper, {'query': 'Jaded London', 'brand_ids': [170260]}, []))
        self.assertEqual([item['id'] for item in result['items']], ['target', 'pants'])
        self.assertEqual([item['id'] for item in result['comparables']], ['p1'])
        self.assertEqual(scraper.search.call_count, 2)
        self.assertEqual(scraper.search.call_args_list[1].args[0]['search_text'], 'hoodie')

    def test_excluded_words_are_case_insensitive(self):
        self.assertFalse(allowed({"title": "Stone Island REPLICA", "details": "Felpa"}, ["replica"]))
        self.assertTrue(allowed({"title": "Stone Island originale", "details": "Felpa"}, ["replica"]))

    def test_categories_do_not_mix_tshirts_and_hoodies(self):
        self.assertEqual(category_for("Nike T-shirt vintage"), "tshirt")
        self.assertEqual(category_for("Nike felpa con cappuccio"), "hoodie")


if __name__ == "__main__":
    unittest.main()
