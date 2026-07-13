#!/usr/bin/env python3
"""Search 1688 by image and estimate procurement cost from first-page matches.

This script intentionally uses the same 1688 H5 endpoints that the web image
search page calls, via the lightweight `search1688api` package. It is meant for
Codex agents when browser automation of 1688 is blocked.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path


GENERIC_TOKENS = {
    "1",
    "шт",
    "sht",
    "art",
    "арт",
    "для",
    "the",
    "and",
    "with",
    "без",
    "无品牌",
}

CATEGORY_KEYWORDS = {
    "汽车防盗器遥控器套": ["钥匙套", "钥匙壳", "钥匙包", "保护壳", "汽车钥匙", "本田", "honda"],
    "空调滤清器": ["空调滤", "滤清器", "滤芯", "空滤", "汽车"],
    "自动变速器过滤器": ["变速箱滤", "变速器滤", "滤清器", "滤芯", "filter"],
}

BAD_ACCESSORY_HINTS = [
    "包装盒",
    "纸盒",
    "贴纸",
    "配件",
    "accessory",
    "sticker",
    "box",
    "packaging",
    "only",
    "自行车灯",
    "车前灯",
    "洗车刷",
    "吸尘器",
    "毛刷",
]


def parse_int(value: object) -> int:
    if value is None:
        return 0
    match = re.search(r"\d+(?:\.\d+)?", str(value).replace(",", ""))
    return int(float(match.group(0))) if match else 0


def parse_price(data: dict) -> float | None:
    price_info = data.get("priceInfo") or {}
    for key in ("price", "priceUnderLine", "priceInteger"):
        value = price_info.get(key)
        if value not in (None, ""):
            try:
                return float(str(value).replace(",", ""))
            except ValueError:
                pass
    return None


def normalize_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").lower()).strip()


def split_tokens(value: str) -> list[str]:
    text = normalize_text(value)
    ascii_tokens = re.findall(r"[a-z0-9][a-z0-9-]{1,}", text)
    cn_tokens = re.findall(r"[\u4e00-\u9fff]{2,}", text)
    return [token for token in ascii_tokens + cn_tokens if token not in GENERIC_TOKENS]


def model_tokens(value: str) -> list[str]:
    tokens = split_tokens(value)
    return [token for token in tokens if re.search(r"\d", token) and len(token) >= 3]


def title_tokens(value: str) -> list[str]:
    tokens = split_tokens(value)
    useful: list[str] = []
    for token in tokens:
        if re.search(r"\d", token) and len(token) >= 3:
            useful.append(token)
        elif re.search(r"[\u4e00-\u9fff]", token) and len(token) >= 2:
            useful.append(token)
        elif len(token) >= 4:
            useful.append(token)
    return useful[:16]


def category_tokens(value: str) -> list[str]:
    tokens = []
    for key, keywords in CATEGORY_KEYWORDS.items():
        if key in value:
            tokens.extend(keywords)
    tokens.extend(split_tokens(value))
    return list(dict.fromkeys(tokens))


def count_hits(title: str, tokens: list[str]) -> int:
    normalized = normalize_text(title)
    return sum(1 for token in tokens if normalize_text(token) and normalize_text(token) in normalized)


def assess_match(rows: list[dict], expect_title: str, expect_model: str, expect_category: str, match_top: int) -> dict:
    top3 = rows[:3]
    match_window = rows[:match_top]
    model_needles = model_tokens(expect_model)
    title_needles = title_tokens(expect_title)
    category_needles = category_tokens(expect_category)
    weak_needles = [token for token in category_needles if token not in title_needles]

    scored = []
    for row in match_window:
        title = row.get("title", "")
        model_hits = count_hits(title, model_needles)
        title_hits = count_hits(title, title_needles)
        category_hits = count_hits(title, weak_needles)
        bad_hits = count_hits(title, BAD_ACCESSORY_HINTS)
        score = model_hits * 3 + title_hits * 2 + category_hits - bad_hits * 2
        scored.append(
            {
                "offerId": row.get("offerId"),
                "title": title,
                "model_hits": model_hits,
                "title_hits": title_hits,
                "category_hits": category_hits,
                "bad_hits": bad_hits,
                "score": score,
                "price": row.get("price"),
                "saleQuantity": row.get("saleQuantity"),
            }
        )

    matched = [item for item in scored if (item["model_hits"] or item["title_hits"] >= 2 or item["score"] >= 2) and item["bad_hits"] == 0]
    weak_matched = [item for item in scored if item["score"] > 0 and item["bad_hits"] == 0]
    top3_bad = sum(1 for item in scored[:3] if item["bad_hits"] > 0 and item["score"] <= 0)
    model_matched = [item for item in scored if item["model_hits"] and item["bad_hits"] == 0]
    matched_for_cost = model_matched if model_needles else (matched or weak_matched)
    matched_prices = [item["price"] for item in matched_for_cost[:3] if item.get("price") is not None]
    matched_median = statistics.median(matched_prices) if matched_prices else None

    if not top3:
        decision = "REJECT"
        reason = "no valid 1688 rows"
    elif model_needles and model_matched:
        decision = "ACCEPT"
        reason = "model token matched in search window"
    elif model_needles and not model_matched:
        decision = "REJECT"
        reason = "model token not found in search window"
    elif len(matched) >= 2:
        decision = "ACCEPT"
        reason = "at least two search-window results match title/category signals"
    elif len(weak_matched) >= 2:
        decision = "REVIEW"
        reason = "two weak matches; quick visual/title review recommended"
    elif top3_bad >= 2 or not weak_matched:
        decision = "REJECT"
        reason = "top results look unrelated or accessory-biased"
    else:
        decision = "REVIEW"
        reason = "only one plausible title/category match"

    return {
        "decision": decision,
        "reason": reason,
        "model_tokens": model_needles,
        "title_tokens": title_needles,
        "category_tokens": weak_needles,
        "match_top": match_top,
        "matched_prices": matched_prices,
        "matched_median_cost": matched_median,
        "scored_rows": scored,
    }


def p70_index(count: int) -> int:
    return max(0, min(count - 1, int(count * 0.7 + 0.999) - 1))


def p80_index(count: int) -> int:
    return max(0, min(count - 1, int(count * 0.8 + 0.999) - 1))


def median_number(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def price_cluster_summary(cluster_rows: list[dict]) -> dict:
    prices = sorted(float(row["price"]) for row in cluster_rows if row.get("price") is not None)
    count = len(cluster_rows)
    strong_count = sum(1 for row in cluster_rows if row.get("level") == "strong")
    score_sum = sum(float(row.get("score") or 0) for row in cluster_rows)
    return {
        "count": count,
        "prices": prices,
        "min_price": prices[0] if prices else None,
        "max_price": prices[-1] if prices else None,
        "median_price": median_number(prices),
        "strong_count": strong_count,
        "strong_ratio": strong_count / count if count else 0,
        "score_sum": score_sum,
        "avg_score": score_sum / count if count else 0,
        "rows": cluster_rows,
    }


def build_price_clusters(filtered_rows: list[dict], adjacent_ratio: float = 1.8) -> list[dict]:
    priced_rows = sorted(
        [row for row in filtered_rows if row.get("price") is not None and float(row["price"]) > 0],
        key=lambda row: float(row["price"]),
    )
    if not priced_rows:
        return []

    clusters: list[list[dict]] = []
    for start in range(len(priced_rows)):
        cluster = [priced_rows[start]]
        cluster_min_price = float(priced_rows[start]["price"])
        previous_price = cluster_min_price
        for row in priced_rows[start + 1:]:
            current_price = float(row["price"])
            if current_price / previous_price <= adjacent_ratio and current_price / cluster_min_price <= adjacent_ratio:
                cluster.append(row)
                previous_price = current_price
            else:
                break
        clusters.append(cluster)
    return [price_cluster_summary(cluster) for cluster in clusters]


def choose_price_cluster(price_clusters: list[dict], all_median: float | None = None) -> dict | None:
    if not price_clusters:
        return None
    return sorted(
        price_clusters,
        key=lambda cluster: (
            cluster["count"],
            cluster["strong_count"],
            cluster["avg_score"],
            -abs((cluster["median_price"] or 0) - all_median) if all_median else 0,
        ),
        reverse=True,
    )[0]


def scored_similarity_rows(rows: list[dict], expect_title: str, expect_model: str, expect_category: str, match_top: int) -> list[dict]:
    model_needles = model_tokens(expect_model)
    title_needles = title_tokens(expect_title)
    category_needles = category_tokens(expect_category)
    weak_needles = [token for token in category_needles if token not in title_needles]
    scored = []
    for row in rows[:match_top]:
        title = row.get("title", "")
        model_hits = count_hits(title, model_needles)
        title_hits = count_hits(title, title_needles)
        category_hits = count_hits(title, weak_needles)
        bad_hits = count_hits(title, BAD_ACCESSORY_HINTS)
        score = model_hits * 3 + title_hits * 2 + category_hits - bad_hits * 3
        if bad_hits:
            level = "bad"
        elif model_needles and model_hits:
            level = "strong"
        elif title_hits >= 1 or score >= 2:
            level = "strong"
        elif category_hits or score > 0:
            level = "weak"
        else:
            level = "none"
        scored.append({**row, "score": score, "level": level, "bad_hits": bad_hits})
    return scored


def first_page_p70_cost(
    rows: list[dict],
    *,
    expect_title: str = "",
    expect_model: str = "",
    expect_category: str = "",
    page_size: int = 10,
) -> dict:
    first_page = scored_similarity_rows(rows, expect_title, expect_model, expect_category, page_size)
    first_page_prices = [row["price"] for row in first_page if row.get("price") is not None]
    strong_exists = any(row["level"] == "strong" for row in first_page)
    weak_exists = any(row["level"] == "weak" for row in first_page)
    allowed_levels = {"strong", "weak"} if strong_exists else ({"weak"} if weak_exists else set())

    raw_prices = sorted(float(row["price"]) for row in first_page if row.get("price") is not None and float(row["price"]) > 0)
    raw_median = raw_prices[len(raw_prices) // 2] if raw_prices else None
    filtered_rows = []
    excluded_rows = []
    for row in first_page:
        price = row.get("price")
        reason = ""
        if price is None or float(price) <= 0:
            reason = "missing or invalid price"
        elif row.get("bad_hits"):
            reason = "accessory or packaging title"
        elif allowed_levels and row.get("level") not in allowed_levels:
            reason = "not a same-product candidate"
        elif raw_median and len(raw_prices) >= 3 and float(price) < raw_median * 0.25:
            reason = "extreme low price"
        elif raw_median and len(raw_prices) >= 5 and float(price) > raw_median * 8:
            reason = "extreme high price"

        if reason:
            excluded_rows.append({**row, "exclude_reason": reason})
        else:
            filtered_rows.append(row)

    filtered_prices = sorted(float(row["price"]) for row in filtered_rows if row.get("price") is not None)
    if len(filtered_prices) < 3:
        return {
            "decision": "REVIEW",
            "reason": "filtered first-page 1688 candidates fewer than 3",
            "p70_cost": None,
            "selected_offer_id": None,
            "first_page_prices": first_page_prices,
            "filtered_first_page_prices": filtered_prices,
            "price_clusters": [],
            "selected_price_cluster": None,
            "cluster_p70_cost": None,
            "cluster_p80_cost": None,
            "filtered_rows": filtered_rows,
            "excluded_rows": excluded_rows,
        }
    all_median = median_number(filtered_prices)
    price_clusters = build_price_clusters(filtered_rows)
    selected_cluster = choose_price_cluster(price_clusters, all_median)
    if not selected_cluster or selected_cluster["count"] < 3:
        return {
            "decision": "REVIEW",
            "reason": f"main price cluster fewer than 3 {filtered_prices}",
            "p70_cost": None,
            "selected_offer_id": None,
            "first_page_prices": first_page_prices,
            "filtered_first_page_prices": filtered_prices,
            "price_clusters": price_clusters,
            "selected_price_cluster": selected_cluster,
            "cluster_p70_cost": None,
            "cluster_p80_cost": None,
            "filtered_rows": filtered_rows,
            "excluded_rows": excluded_rows,
        }

    main_prices = selected_cluster["prices"]
    full_spread_ratio = raw_prices[-1] / raw_prices[0] if raw_prices and raw_prices[0] > 0 else 0
    main_share = selected_cluster["count"] / len(filtered_prices) if filtered_prices else 0
    main_median = selected_cluster["median_price"]
    median_ratio = max(main_median, all_median) / min(main_median, all_median) if main_median and all_median else 1
    min_main_share = 0.4 if selected_cluster["count"] >= 3 and selected_cluster["strong_ratio"] >= 0.6 else 0.5
    if main_share < min_main_share:
        return {
            "decision": "REVIEW",
            "reason": f"main price cluster share below {min_main_share:.0%} {main_prices} of {filtered_prices}",
            "p70_cost": None,
            "selected_offer_id": None,
            "first_page_prices": first_page_prices,
            "filtered_first_page_prices": filtered_prices,
            "price_clusters": price_clusters,
            "selected_price_cluster": selected_cluster,
            "cluster_p70_cost": None,
            "cluster_p80_cost": None,
            "filtered_rows": filtered_rows,
            "excluded_rows": excluded_rows,
        }
    if median_ratio > 2.5:
        return {
            "decision": "REVIEW",
            "reason": f"main price cluster median too far from all prices {main_prices} of {filtered_prices}",
            "p70_cost": None,
            "selected_offer_id": None,
            "first_page_prices": first_page_prices,
            "filtered_first_page_prices": filtered_prices,
            "price_clusters": price_clusters,
            "selected_price_cluster": selected_cluster,
            "cluster_p70_cost": None,
            "cluster_p80_cost": None,
            "filtered_rows": filtered_rows,
            "excluded_rows": excluded_rows,
        }
    if full_spread_ratio > 15 and not (selected_cluster["count"] >= 5 and selected_cluster["strong_ratio"] >= 0.6):
        return {
            "decision": "REVIEW",
            "reason": f"extreme price spread without strong main cluster {filtered_prices}",
            "p70_cost": None,
            "selected_offer_id": None,
            "first_page_prices": first_page_prices,
            "filtered_first_page_prices": filtered_prices,
            "price_clusters": price_clusters,
            "selected_price_cluster": selected_cluster,
            "cluster_p70_cost": None,
            "cluster_p80_cost": None,
            "filtered_rows": filtered_rows,
            "excluded_rows": excluded_rows,
        }

    cluster_p70_cost = main_prices[p70_index(len(main_prices))]
    cluster_p80_cost = main_prices[p80_index(len(main_prices))]
    use_p80 = full_spread_ratio > 8
    selected_cost = cluster_p80_cost if use_p80 else cluster_p70_cost
    selected = sorted(
        selected_cluster["rows"],
        key=lambda row: (abs(float(row["price"]) - selected_cost), -row.get("score", 0), row.get("title", "")),
    )[0]
    return {
        "decision": "LIGHT_ACCEPT",
        "reason": "filtered first-page similarity clustered cost",
        "p70_cost": selected_cost,
        "selected_offer_id": selected.get("offerId"),
        "first_page_prices": first_page_prices,
        "filtered_first_page_prices": filtered_prices,
        "price_clusters": price_clusters,
        "selected_price_cluster": selected_cluster,
        "cluster_p70_cost": cluster_p70_cost,
        "cluster_p80_cost": cluster_p80_cost,
        "cost_source": "search_first_page_cluster_p80_similarity_filtered"
        if use_p80
        else "search_first_page_cluster_p70_similarity_filtered",
        "filtered_rows": filtered_rows,
        "excluded_rows": excluded_rows,
    }


def load_session():
    try:
        from search1688api import Sync1688Session
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Missing dependency `search1688api`. Install with:\n"
            "python3 -m pip install search1688api requests aiohttp beautifulsoup4 lxml"
        ) from exc
    return Sync1688Session(debug=False)


def is_webp(path: Path) -> bool:
    with path.open("rb") as handle:
        header = handle.read(12)
    return header.startswith(b"RIFF") and header[8:12] == b"WEBP"


def normalize_image(image_path: Path, temp_dir: Path) -> tuple[Path, str | None]:
    """Convert Ozon WebP assets to JPEG before uploading to 1688."""
    if not is_webp(image_path):
        return image_path, None

    sips = shutil.which("sips")
    if not sips:
        return image_path, "Input is WebP, but `sips` was not found; uploading original file."

    converted = temp_dir / f"{image_path.stem}_1688.jpg"
    try:
        subprocess.run(
            [sips, "-s", "format", "jpeg", str(image_path), "--out", str(converted)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        message = (exc.stderr or "").strip()
        return image_path, f"WebP-to-JPEG conversion failed; uploading original file. {message}"

    return converted, f"Converted WebP input to JPEG for 1688 upload: {converted}"


def summarize_products(raw_products: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for product in raw_products:
        data = product.get("data", {}) if isinstance(product, dict) else {}
        price = parse_price(data)
        sale = parse_int(data.get("saleQuantity") or (data.get("afterPrice") or {}).get("text"))
        if price is None or not sale:
            continue
        rows.append(
            {
                "offerId": data.get("offerId"),
                "title": data.get("title", ""),
                "price": price,
                "saleQuantity": sale,
                "shop": (data.get("shop") or {}).get("text") or data.get("loginId"),
                "pic": data.get("offerPicUrl") or data.get("odPicUrl"),
                "url": data.get("linkUrl"),
            }
        )
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="Path to the product image crop")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON only")
    parser.add_argument("--top", type=int, default=10, help="How many sorted rows to show")
    parser.add_argument("--expect-title", default="", help="Ozon product title for fast match screening")
    parser.add_argument("--expect-model", default="", help="Product model/article/SKU-like text for strong matching")
    parser.add_argument("--expect-category", default="", help="Ozon/Maozi category text for fast match screening")
    parser.add_argument("--match-top", type=int, default=10, help="How many high-sales rows to scan for title/model matches")
    args = parser.parse_args()

    image_path = Path(args.image).expanduser().resolve()
    if not image_path.exists():
        raise SystemExit(f"Image not found: {image_path}")

    with tempfile.TemporaryDirectory(prefix="1688-image-") as temp_name:
        upload_path, note = normalize_image(image_path, Path(temp_name))
        session = load_session()
        raw_products = session.search_by_image(str(upload_path))
    rows = summarize_products(raw_products)
    top3 = rows[:3]
    median = statistics.median([row["price"] for row in top3]) if top3 else None
    p70 = first_page_p70_cost(
        rows,
        expect_title=args.expect_title,
        expect_model=args.expect_model,
        expect_category=args.expect_category,
        page_size=args.top,
    )

    payload = {
        "image": str(image_path),
        "upload_image": str(upload_path),
        "note": note,
        "decision": p70["decision"],
        "reason": p70["reason"],
        "selected_cost": p70["p70_cost"],
        "selected_offer_id": p70["selected_offer_id"],
        "cost_source": p70.get("cost_source") or "search_first_page_p70_similarity_filtered",
        "first_page_prices": p70["first_page_prices"],
        "filtered_first_page_prices": p70["filtered_first_page_prices"],
        "price_clusters": p70["price_clusters"],
        "selected_price_cluster": p70["selected_price_cluster"],
        "cluster_p70_cost": p70["cluster_p70_cost"],
        "cluster_p80_cost": p70["cluster_p80_cost"],
        "p70_cost": p70["p70_cost"],
        "filtered_rows": p70["filtered_rows"],
        "excluded_rows": p70["excluded_rows"],
        "valid_count": len(rows),
        "top3_prices": [row["price"] for row in top3],
        "median_cost": median,
        "match": assess_match(rows, args.expect_title, args.expect_model, args.expect_category, args.match_top)
        if (args.expect_title or args.expect_model or args.expect_category)
        else None,
        "top_rows": rows[: args.top],
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    if note:
        print(f"NOTE {note}")
    print(f"VALID_COUNT {payload['valid_count']}")
    print("DECISION", payload["decision"])
    print("COST_SOURCE", payload["cost_source"])
    print("REASON", payload["reason"])
    for index, row in enumerate(payload["top_rows"], 1):
        title = row["title"][:80]
        print(
            f"{index}. sale={row['saleQuantity']} price={row['price']} "
            f"offer={row['offerId']} shop={row.get('shop') or ''} title={title}"
        )
    print("FIRST_PAGE_PRICES", payload["first_page_prices"])
    print("FILTERED_FIRST_PAGE_PRICES", payload["filtered_first_page_prices"])
    print("PRICE_CLUSTERS", json.dumps(payload["price_clusters"], ensure_ascii=False))
    print("SELECTED_PRICE_CLUSTER", json.dumps(payload["selected_price_cluster"], ensure_ascii=False))
    print("CLUSTER_P70_COST", payload["cluster_p70_cost"])
    print("CLUSTER_P80_COST", payload["cluster_p80_cost"])
    print("P70_COST", payload["p70_cost"])
    print("TOP3_PRICES", payload["top3_prices"])
    print("MEDIAN_COST", payload["median_cost"])
    if payload["match"]:
        print("MATCH_DECISION", payload["match"]["decision"])
        print("MATCH_REASON", payload["match"]["reason"])
        print("MATCH_MODEL_TOKENS", payload["match"]["model_tokens"])
        print("MATCH_TITLE_TOKENS", payload["match"]["title_tokens"])
        print("MATCHED_PRICES", payload["match"]["matched_prices"])
        print("MATCHED_MEDIAN_COST", payload["match"]["matched_median_cost"])
    return 0 if payload["p70_cost"] is not None else 2


if __name__ == "__main__":
    sys.exit(main())
