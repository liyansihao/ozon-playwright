import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "1688_image_median.py"


spec = importlib.util.spec_from_file_location("image_median_1688", SCRIPT)
image_median_1688 = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(image_median_1688)


def rows(prices, *, strong=True):
    level_title = "same product lamp"
    return [
        {
            "offerId": f"offer-{index}",
            "title": level_title,
            "price": price,
            "saleQuantity": 100 + index,
            "shop": "shop",
        }
        for index, price in enumerate(prices, 1)
    ]


class FirstPageClusterCostTest(unittest.TestCase):
    def test_selects_main_mid_cluster_instead_of_low_cluster(self):
        result = image_median_1688.first_page_p70_cost(
            rows([44, 60, 80, 135, 159, 168, 175, 265]),
            expect_title="same product lamp",
            page_size=10,
        )

        self.assertEqual(result["decision"], "LIGHT_ACCEPT")
        self.assertEqual(result["selected_price_cluster"]["prices"], [135.0, 159.0, 168.0, 175.0])
        self.assertEqual(result["p70_cost"], 168.0)
        self.assertEqual(result["cost_source"], "search_first_page_cluster_p70_similarity_filtered")

    def test_excludes_low_anchor_and_selects_body_cluster(self):
        result = image_median_1688.first_page_p70_cost(
            rows([5.8, 7.25, 17, 19.8, 21.3, 23.8, 60]),
            expect_title="same product lamp",
            page_size=10,
        )

        self.assertEqual(result["decision"], "LIGHT_ACCEPT")
        self.assertEqual(result["selected_price_cluster"]["prices"], [17.0, 19.8, 21.3, 23.8])
        self.assertEqual(result["p70_cost"], 23.8)

    def test_keeps_review_when_main_cluster_has_fewer_than_three(self):
        result = image_median_1688.first_page_p70_cost(
            rows([10, 18, 35, 70]),
            expect_title="same product lamp",
            page_size=10,
        )

        self.assertEqual(result["decision"], "REVIEW")
        self.assertIn("main price cluster fewer than 3", result["reason"])

    def test_extreme_spread_requires_strong_cluster(self):
        result = image_median_1688.first_page_p70_cost(
            rows([10, 18, 35, 70, 200, 210, 220, 230]),
            page_size=10,
        )

        self.assertEqual(result["decision"], "REVIEW")
        self.assertIn("extreme price spread", result["reason"])


if __name__ == "__main__":
    unittest.main()
