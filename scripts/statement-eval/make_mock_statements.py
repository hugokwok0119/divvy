#!/usr/bin/env python3
"""Write fictional credit-card statement PDFs and their ground-truth manifest.

Every merchant, amount, date and account detail is invented. Six layouts imitate common
statement structures without any issuer's name or design:
  A  account summary first, per-cardholder sections, rewards table repeating purchases
  B  activity beside a balance panel, continued after a page of terms
  C  US-style periodic statement: activity summary, transactions grouped by type, foreign
     currency lines, fee and interest totals with year-to-date figures
  D  post date before transaction date, credits marked CR, cardholder blocks, no clean reference
  E  online transaction-history printout: newest first, debit/credit/balance columns, DD/MM/YYYY
  F  transactions grouped by spending category with points per row and a spending table
Stdlib only and deterministic: rerun after editing, then commit the output.
test_mock_statements.py fails if the committed files drift from this script.
"""
import json
import random
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path


NOTICE = "FICTIONAL SAMPLE: all data is made up, for demo and testing only. Not a real statement."
OUTPUT = Path(__file__).with_name("mock-statements")
PRIMARY, ADDITIONAL, OTHER = "PRIMARY CARDHOLDER", "ADDITIONAL CARDHOLDER", "Other Account Transactions"
ACCOUNT = {"A": "XXXX XXXXXX 0000", "B": "XXXX XXXX XXXX 0000"}
ADDITIONAL_CARD = "XXXX XXXX XXXX 0001"
CITY = "DEMO CITY"
FEE = ("ANNUAL FEE INSTALLMENT", "Fee", 1299)
MONTHS = ("January February March April May June July August September October November December").split()

# Invented merchant descriptors: (store, category, lowest cents, highest cents).
MERCHANTS = [
    ("QUILLFERN MARKET #0042", "Groceries", 450, 9800),
    ("BRAMBLEWICK GROCER", "Groceries", 600, 7400),
    ("MOSSRIDGE FRESH FOODS", "Groceries", 300, 4200),
    ("TINDERLEAF ASIAN MART", "Groceries", 500, 6500),
    ("BRINDLEWOOD CAFE", "Dining", 450, 1900),
    ("LANTERNFIG NOODLE BAR", "Dining", 1400, 5600),
    ("OTTERBLOOM BAKERY", "Dining", 350, 2400),
    ("SAFFRONQUILL KITCHEN", "Dining", 2200, 8800),
    ("KESTRELBAY TRANSIT", "Transport", 250, 4500),
    ("PARKWISP METER", "Transport", 200, 1800),
    ("ZEPHYRINE BOOKS", "Shopping", 1200, 6400),
    ("COPPERFINCH HOME GOODS", "Shopping", 1500, 22000),
    ("MARIGOLD THREADS", "Shopping", 2500, 16000),
    ("GLIMMERSTONE PHARMACY", "Health", 600, 5200),
    ("STARGLADE CINEMA", "Entertainment", 1400, 4200),
]


def pick(rng, n):
    # Only random() is stable across Python versions; randrange and choice are not guaranteed.
    return int(rng.random() * n)


def row(rng, day, store, category, cents, closing, opening=None):
    posted = min(day + timedelta(days=pick(rng, 3)), closing)
    if opening and posted < opening:
        posted = opening
    return {"date": day.isoformat(), "posted": posted.isoformat(), "store": store,
            "category": category, "amount": cents}


def random_rows(rng, opening, closing, count):
    rows = []
    for _ in range(count):
        store, category, low, high = MERCHANTS[pick(rng, len(MERCHANTS))]
        day = opening + timedelta(days=pick(rng, (closing - opening).days + 1))
        rows.append(row(rng, day, store, category, low + pick(rng, high - low), closing))
    return rows


def statement(sid, split, layout, opening, closing, previous, payments, sections, seed):
    rng = random.Random(seed)
    built = []
    for title, count, extras in sections:
        rows = random_rows(rng, opening, closing, count)
        for offset, store, category, cents in extras:
            day = opening + timedelta(days=offset)
            fx = cents if isinstance(cents, tuple) else None  # (currency, foreign cents, rate)
            if fx:
                cents = int((Decimal(fx[1]) * Decimal(fx[2])).quantize(Decimal(1), ROUND_HALF_UP))
            rows.append(row(rng, day, store, category, cents, closing, opening))
            if fx:
                rows[-1]["fx"] = fx
            if fx and cents > 0:
                fee = row(rng, day, "FOREIGN TRANSACTION FEE", "Fee", (cents * 25 + 500) // 1000, closing, opening)
                rows.append({**fee, "posted": rows[-1]["posted"]})
        built.append({"title": title, "rows": sorted(rows, key=lambda r: r["date"])})
    paid = [row(rng, opening + timedelta(days=offset), "PAYMENT RECEIVED - THANK YOU", None, -cents, closing)
            for offset, cents in payments]
    rows = [r for section in built for r in section["rows"]]
    fees = sum(r["amount"] for r in rows if r["category"] == "Fee")
    return {
        "id": sid, "split": split, "layout": layout, "opening": opening.isoformat(),
        "closing": closing.isoformat(), "previous_balance": previous, "payments": paid,
        "sections": built, "fees": fees, "purchases": sum(r["amount"] for r in rows) - fees,
        "closing_balance": previous + sum(r["amount"] for r in rows + paid),
        "rewards": [r for r in rows if r["category"] in ("Dining", "Groceries") and r["amount"] > 0],
    }


def statements():
    """The fictional statements, at least one development and one test case per layout."""
    a2 = statement("sample-a2", "test", "A", date(2026, 6, 25), date(2026, 7, 24), 64218, [(10, 64218)], [
        (PRIMARY, 31, [(3, "ZEPHYRINE BOOKS", "Shopping", 4700), (12, "ZEPHYRINE BOOKS", "Shopping", -2350),
                       (20, "ORROWIND STREAMING", "Subscriptions", 1699)]),
        (ADDITIONAL, 5, [(16, "MOSSRIDGE FRESH FOODS", "Groceries", -425)]),
        (OTHER, 0, [(29, *FEE)]),
    ], seed=2)
    a3 = statement("sample-a3", "test", "A", date(2026, 7, 25), date(2026, 8, 24), a2["closing_balance"],
                   [(10, 50000)], [
        (PRIMARY, 15, [(9, "KESTRELBAY TRANSIT", "Transport", 315), (9, "KESTRELBAY TRANSIT", "Transport", 315),
                       (20, "ORROWIND STREAMING", "Subscriptions", 1699)]),
        (ADDITIONAL, 9, [(-2, "OTTERBLOOM BAKERY", "Dining", 685), (-1, "QUILLFERN MARKET #0042", "Groceries", 2318)]),
        (OTHER, 0, [(30, *FEE)]),
    ], seed=3)
    a1 = statement("sample-a1", "development", "A", date(2026, 8, 25), date(2026, 9, 24), a3["closing_balance"],
                   [(9, a3["closing_balance"]), (21, 350000)], [
        (PRIMARY, 10, [(4, "VELLUMTIDE ELECTRONICS", "Shopping", 189900),
                       (18, "VELLUMTIDE ELECTRONICS", "Shopping", -35000),
                       (20, "ORROWIND STREAMING", "Subscriptions", 1699), (22, "HEARTHLINE INTERNET", "Utilities", 7240)]),
        (ADDITIONAL, 12, [(-2, "BRINDLEWOOD CAFE", "Dining", 940), (-1, "TINDERLEAF ASIAN MART", "Groceries", 3127),
                          (14, "QUILLFERN MARKET #0042", "Groceries", -675)]),
        (OTHER, 0, [(30, *FEE)]),
    ], seed=1)
    b1 = statement("sample-b1", "development", "B", date(2026, 7, 6), date(2026, 8, 5), 45560, [(9, 45560)], [
        (PRIMARY, 6, [(4, "GLOWMERE MOBILE", "Utilities", 6500), (11, "BRINDLEWOOD CAFE", "Dining", 875),
                      (12, "BRINDLEWOOD CAFE", "Dining", 875)]),
        (ADDITIONAL, 7, []),
    ], seed=4)
    b2 = statement("sample-b2", "test", "B", date(2026, 8, 6), date(2026, 9, 5), b1["closing_balance"], [(19, 30000)], [
        (PRIMARY, 9, [(4, "GLOWMERE MOBILE", "Utilities", 6500), (30, "ANNUAL FEE", "Fee", 3900)]),
        (ADDITIONAL, 9, [(15, "PIXELMOTH CLOUD STORAGE", "Subscriptions", 399)]),
    ], seed=5)
    c1 = statement("sample-c1", "development", "C", date(2026, 2, 26), date(2026, 3, 25), 38214, [(8, 38214)], [
        (PRIMARY, 14, [(5, "NIMBUSTRAIL STAYS", "Travel", ("USD", 18640, "1.3725")),
                       (6, "LANTERNFIG NOODLE BAR", "Dining", ("USD", 4250, "1.3725")),
                       (11, "COPPERFINCH HOME GOODS", "Shopping", 8999), (17, "COPPERFINCH HOME GOODS", "Shopping", -8999),
                       (20, "MARIGOLD THREADS", "Shopping", -1550)]),
    ], seed=6)
    c2 = statement("sample-c2", "test", "C", date(2026, 3, 26), date(2026, 4, 25), c1["closing_balance"], [(9, 20000)], [
        (PRIMARY, 16, [(3, "NIMBUSTRAIL STAYS", "Travel", ("EUR", 21000, "1.5012")),
                       (12, "NIMBUSTRAIL STAYS", "Travel", ("EUR", -4500, "1.4987")),
                       (14, "ANNUAL MEMBERSHIP FEE", "Fee", 9500), (22, "STARGLADE CINEMA", "Entertainment", -1800)]),
    ], seed=7)
    d1 = statement("sample-d1", "development", "D", date(2025, 12, 16), date(2026, 1, 15), 152340, [(10, 152340)], [
        (PRIMARY, 10, [(7, "MARIGOLD THREADS", "Shopping", 8900), (9, "MARIGOLD THREADS", "Shopping", -8900)]),
        (ADDITIONAL, 6, []),
    ], seed=8)
    d2 = statement("sample-d2", "test", "D", date(2026, 1, 16), date(2026, 2, 15), d1["closing_balance"], [(12, 40000)], [
        (PRIMARY, 9, [(20, "VELLUMTIDE ELECTRONICS", "Shopping", 60000), (21, "VELLUMTIDE ELECTRONICS", "Shopping", -60000),
                      (21, "VELLUMTIDE ELECTRONICS 1ST OF 6 INSTALMENTS", "Shopping", 10000)]),
        (ADDITIONAL, 7, []),
    ], seed=9)
    e1 = statement("sample-e1", "development", "E", date(2026, 3, 1), date(2026, 3, 31), 51288, [(14, 51288)], [
        (PRIMARY, 16, [(9, "ZEPHYRINE BOOKS", "Shopping", -2499)]),
    ], seed=10)
    e2 = statement("sample-e2", "test", "E", date(2026, 4, 1), date(2026, 4, 30), e1["closing_balance"], [(13, 30000)], [
        (PRIMARY, 17, [(5, "PARKWISP METER", "Transport", 450), (5, "PARKWISP METER", "Transport", 450),
                       (19, "GLIMMERSTONE PHARMACY", "Health", -1275)]),
    ], seed=11)
    f1 = statement("sample-f1", "development", "F", date(2026, 5, 1), date(2026, 5, 31), 72315, [(12, 72315)], [
        (PRIMARY, 20, [(2, "ORROWIND STREAMING", "Subscriptions", 1699), (15, "BRAMBLEWICK GROCER", "Groceries", -820),
                       (30, "ANNUAL FEE", "Fee", 12000)]),
    ], seed=12)
    f2 = statement("sample-f2", "test", "F", date(2026, 6, 1), date(2026, 6, 30), f1["closing_balance"],
                   [(11, f1["closing_balance"])], [
        (PRIMARY, 22, [(2, "ORROWIND STREAMING", "Subscriptions", 1699), (9, "LANTERNFIG NOODLE BAR", "Dining", -1600)]),
    ], seed=13)
    return [a1, b1, a2, a3, b2, c1, c2, d1, d2, e1, e2, f1, f2]


# --- formatting -------------------------------------------------------------------------------

def money(cents, dollar=True):
    text = f"{abs(cents) / 100:,.2f}"
    return ("-" if cents < 0 else "") + ("$" if dollar else "") + text


def day_month(iso, upper=False):
    value = date.fromisoformat(iso)
    text = f"{MONTHS[value.month - 1][:3]} {value.day}"
    return text.upper() if upper else text


def full_date(iso):
    value = date.fromisoformat(iso)
    return f"{MONTHS[value.month - 1]} {value.day}, {value.year}"


def fmt(iso, style):
    value = date.fromisoformat(iso)
    month = MONTHS[value.month - 1][:3]
    return {"mm/dd": f"{value.month:02d}/{value.day:02d}",
            "mm/dd/yy": f"{value.month:02d}/{value.day:02d}/{value.year % 100:02d}",
            "dd mon": f"{value.day:02d} {month}", "dd MON yyyy": f"{value.day:02d} {month.upper()} {value.year}",
            "dd/mm/yyyy": f"{value.day:02d}/{value.month:02d}/{value.year}",
            "weekday": f"{'Mon Tue Wed Thu Fri Sat Sun'.split()[value.weekday()]}, {month} {value.day}"}[style]


def later(iso, days):
    return (date.fromisoformat(iso) + timedelta(days=days)).isoformat()


# --- minimal PDF writer -----------------------------------------------------------------------

WIDTHS = {**dict.fromkeys("0123456789$", 556), ",": 278, ".": 278, "-": 333, " ": 278, "%": 889}


def escape(text):
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


class Page:
    def __init__(self):
        self.ops = []

    def text(self, x, y, value, size=9, bold=False, gray=0):
        self.ops.append(f"BT /{'F2' if bold else 'F1'} {size} Tf {gray} g {x:.1f} {y:.1f} Td ({escape(value)}) Tj ET")

    def right(self, x, y, value, size=9, bold=False):
        # shortcut: widths cover amount characters only; other glyphs use an average width.
        self.text(x - sum(WIDTHS.get(c, 556) for c in value) * size / 1000, y, value, size, bold)

    def rule(self, x1, y, x2, width=0.5):
        self.ops.append(f"{width} w {x1} {y} m {x2} {y} l S")

    def box(self, x, y, w, h, gray):
        self.ops.append(f"{gray} g {x} {y} {w} {h} re f 0 g")

    def paragraph(self, x, y, lines, size=8, leading=11):
        for line in lines:
            self.text(x, y, line, size)
            y -= leading
        return y


def finish(pages, page_label):
    """Add the notice banner and footer to every page."""
    # No diagonal watermark: text extractors interleave its letters with transaction rows.
    for number, page in enumerate(pages, 1):
        page.box(36, 756, 540, 22, 0.85)
        page.text(44, 763, NOTICE, 10, bold=True)
        page.text(36, 30, "Generated by scripts/statement-eval/make_mock_statements.py. "
                          "No real person, account, card issuer or merchant is shown.", 7, gray=0.35)
        page.right(576, 30, page_label(number, len(pages)), 7)
    return pages


def pdf(pages, title):
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", None,
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
               f"<< /Title ({escape(title)}) /Producer (make_mock_statements.py) >>".encode()]
    kids = []
    for page in pages:
        stream = "\n".join(page.ops).encode("latin-1")
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font "
                       f"<< /F1 3 0 R /F2 4 0 R >> >> /Contents {len(objects)} 0 R >>".encode())
        kids.append(f"{len(objects)} 0 R")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>".encode()
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    start = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{offset:010d} 00000 n \n" for offset in offsets).encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()
    return bytes(out)


# --- layout A: summary first, cardholder sections, rewards table -----------------------------

ABOUT_A = [
    "About Your Statement (sample wording)",
    "",
    "This page imitates the explanatory notes that card statements usually carry. The wording is",
    "invented for software testing. It is not legal, financial or product information.",
    "",
    "Transaction and posting dates. Each row shows the date of the purchase and the date it was",
    "posted. A purchase made shortly before the opening date can appear on this statement.",
    "",
    "Account summary. Purchases are shown after merchant refunds. Fees are shown separately. The",
    "new balance also reflects the previous balance and payments, so it is not a purchase total.",
    "",
    "Minimum payment. In this sample the minimum payment is a made-up percentage of the balance.",
    "",
    "Interest. Sample annual rates: purchases 19.99%, cash advances 22.99%. No interest was",
    "charged in this sample period.",
]


def layout_a(s):
    pages, subtotal_pages = [Page()], {}
    page, y = pages[0], 0

    def header(p, title):
        p.text(36, 728, "Sample Rewards Card", 16, bold=True)
        p.text(36, 712, title, 11)
        for x, label, value in ((36, "Prepared For", PRIMARY), (230, "Account Number", ACCOUNT["A"]),
                                (380, "Opening Date", full_date(s["opening"])), (480, "Closing Date", full_date(s["closing"]))):
            p.text(x, 690, label, 8, bold=True)
            p.text(x, 678, value, 8)
        p.rule(36, 670, 576)

    summary = pages[0]
    header(summary, "Statement of Account")
    summary.text(36, 648, "ACCOUNT SUMMARY", 10, bold=True)
    payments = -sum(p["amount"] for p in s["payments"])
    lines = [("", "Previous Balance", s["previous_balance"]), ("Less", "Payments", payments),
             ("Less", "Other Credits", 0), ("Plus", "Interest", 0), ("Plus", "Purchases", s["purchases"]),
             ("Plus", "Fees", s["fees"]), ("Plus", "Credit Advances", 0), ("Plus", "Other Charges", 0),
             ("Equals", "New Balance", s["closing_balance"])]
    y = 630
    for operator, label, cents in lines:
        bold = operator == "Equals"
        summary.text(36, y, operator, 9, bold)
        summary.text(80, y, label, 9, bold)
        summary.right(300, y, money(cents), 9, bold)
        y -= 16
    due = max(0, s["closing_balance"]) * 3 // 100
    for i, (label, value) in enumerate((("Credit Limit", "$8,000.00"),
                                        ("Available Credit", money(800000 - max(0, s["closing_balance"]))),
                                        ("Minimum Amount Due", money(due)),
                                        ("Payment Due Date", full_date((date.fromisoformat(s["closing"]) + timedelta(days=21)).isoformat())))):
        summary.text(340, 630 - 16 * i, label, 9)
        summary.right(576, 630 - 16 * i, value, 9)
    note = ("Your account has a credit balance. No payment is required." if s["closing_balance"] < 0
            else "Pay at least the Minimum Amount Due by the Payment Due Date.")
    summary.text(36, y - 10, f"Statement includes payments and charges received by {full_date(s['closing'])}.", 8)
    summary.text(36, y - 22, note, 8)

    def new_page(title):
        nonlocal page, y
        page = Page()
        pages.append(page)
        header(page, "Statement of Account")
        page.text(36, 650, "Your Transactions", 11, bold=True)
        page.text(36, 634, "Transaction", 8, bold=True)
        page.text(100, 634, "Posting", 8, bold=True)
        page.text(160, 634, "Details", 8, bold=True)
        page.right(576, 634, "Amount ($)", 8, bold=True)
        page.text(36, 624, "Date", 8, bold=True)
        page.text(100, 624, "Date", 8, bold=True)
        y = 600
        if title:
            line(f"{title} (continued)", bold=True)

    def line(text, cents=None, bold=False, r=None):
        nonlocal y
        if r:
            page.text(36, y, day_month(r["date"]), 8)
            page.text(100, y, day_month(r["posted"]), 8)
            page.text(160, y, f"{r['store']}   {CITY}" if r["category"] not in (None, "Fee") else r["store"], 8)
        else:
            page.text(36, y, text, 9, bold)
        if cents is not None:
            page.right(576, y, money(cents, dollar=False), 9 if r is None else 8, bold)
        y -= 15

    def section(title, rows, total_label, holder=None):
        nonlocal y
        if y < 150:
            new_page(None)
        line(title, bold=True)
        for r in rows:
            if y < 90:
                new_page(title)
            line(None, r["amount"], r=r)
        line(total_label, sum(r["amount"] for r in rows), bold=True)
        if holder:
            line(holder, bold=True)
        page.rule(36, y + 9, 576)
        y -= 6
        return len(pages)

    new_page(None)
    section("New Payments", s["payments"], "Total of Payment Activity")
    for sec in s["sections"]:
        if sec["title"] == OTHER:
            subtotal_pages[OTHER] = section(OTHER, sec["rows"], "Total of Other Account Transactions")
        else:
            subtotal_pages[sec["title"]] = section(f"New Transactions for {sec['title']}", sec["rows"],
                                                   "Total of New Transactions for", sec["title"])

    about = Page()
    header(about, "Statement of Account")
    about.paragraph(36, 640, ABOUT_A, 9, 14)
    pages.append(about)

    rewards = Page()
    header(rewards, "Statement of Account")
    rewards.text(36, 648, "Rewards Summary", 11, bold=True)
    earned = sum(r["amount"] for r in s["rewards"]) * 3 // 100 + s["purchases"] // 100
    columns = (("Previous Points", 18420), ("Points Earned", earned), ("Bonus Points", 250),
               ("Points Redeemed", 0), ("New Points Balance", 18420 + earned + 250))
    for i, (label, points) in enumerate(columns):
        rewards.text(36 + 108 * i, 628, label, 8, bold=True)
        rewards.text(36 + 108 * i, 614, f"{points:,}", 9)
    rewards.text(36, 588, "Summary of Points on Bonus Categories (3 points per $1)", 10, bold=True)
    rewards.text(36, 570, "Date", 8, bold=True)
    rewards.text(110, 570, "Description", 8, bold=True)
    rewards.right(576, 570, "Qualifying Purchase", 8, bold=True)
    rewards.text(36, 554, "Eligible Dining and Groceries", 9, bold=True)
    rewards.right(576, 554, money(sum(r["amount"] for r in s["rewards"])), 9, bold=True)
    y = 540
    for r in s["rewards"]:
        rewards.text(36, y, date.fromisoformat(r["posted"]).strftime("%m/%d/%Y"), 8)
        rewards.text(110, y, f"{r['store']}   {CITY}", 8)
        rewards.right(576, y, money(r["amount"]), 8)
        y -= 13
    pages.append(rewards)

    references = [{"label": "Plus Purchases", "amount": s["purchases"] / 100, "page": 1},
                  {"label": "Plus Fees", "amount": s["fees"] / 100, "page": 1}]
    subtotals = [{"label": "Total of New Transactions for" if sec["title"] != OTHER else "Total of Other Account Transactions",
                  "amount": sum(r["amount"] for r in sec["rows"]) / 100, "page": subtotal_pages[sec["title"]]}
                 for sec in s["sections"]]
    return finish(pages, lambda n, total: f"Page {n} / {total}"), references, [subtotals]


# --- layout B: activity beside a balance panel, continued after terms -------------------------

TERMS_B = [
    "IMPORTANT INFORMATION (SAMPLE WORDING)",
    "",
    "This page stands in for the terms that often sit between pages of card activity. Its text is",
    "invented for software testing and describes no real product.",
    "",
    "Payment due date. Pay at least the minimum payment by the payment due date shown on page 1.",
    "",
    "Grace period. In this sample, new purchases carry no interest when the new balance is paid in",
    "full by the payment due date.",
    "",
    "Net amount of monthly activity. This figure adds purchases and fees and subtracts payments and",
    "credits for one card. It is not a purchase total.",
    "",
    "How payments apply. Sample payments apply to the balance with the highest sample rate first.",
]


def layout_b(s):
    primary, additional = s["sections"][0]["rows"], s["sections"][1]["rows"]
    first, rest = additional[:2], additional[2:]
    payment = s["payments"][0]
    activity = sorted(primary + [payment], key=lambda r: r["date"])
    page1, page2, page3 = Page(), Page(), Page()
    statement_date = full_date(s["closing"])
    previous = full_date((date.fromisoformat(s["opening"]) - timedelta(days=1)).isoformat())

    def heading(p, number):
        p.text(36, 728, "Sample Rewards Card", 14, bold=True)
        p.text(36, 712, f"{PRIMARY}   {ACCOUNT['B']}", 9)
        p.text(36, 698, f"STATEMENT DATE: {statement_date}", 9)
        p.text(300, 698, f"{number} OF 3", 9, bold=True)
        p.text(36, 686, f"PREVIOUS STATEMENT: {previous}", 9)

    def table_head(p, y):
        for x, label in ((36, "TRANSACTION"), (100, "POSTING")):
            p.text(x, y, label, 7, bold=True)
            p.text(x, y - 9, "DATE", 7, bold=True)
        p.text(160, y - 9, "ACTIVITY DESCRIPTION", 7, bold=True)
        p.right(372, y - 9, "AMOUNT($)", 7, bold=True)
        p.rule(36, y - 14, 372)
        return y - 28

    def activity_row(p, y, r):
        p.text(36, y, day_month(r["date"], upper=True), 8)
        p.text(100, y, day_month(r["posted"], upper=True), 8)
        store = "PREAUTHORIZED PAYMENT" if r["category"] is None else r["store"]
        p.text(160, y, store, 8)
        p.right(372, y, money(r["amount"]), 8)
        if r["category"] not in (None, "Fee") and len(store) > 16:
            y -= 11
            p.text(160, y, CITY, 8)
        return y - 14

    def net(p, y, rows, label="NET AMOUNT OF MONTHLY"):
        p.text(160, y, label, 8, bold=True)
        p.right(372, y, money(sum(r["amount"] for r in rows)), 8, bold=True)
        p.text(160, y - 10, "ACTIVITY", 8, bold=True)
        return y - 26

    heading(page1, 1)
    page1.text(36, 674, f"STATEMENT PERIOD: {full_date(s['opening'])} to {statement_date}", 9)
    y = table_head(page1, 656)
    page1.text(160, y, "PREVIOUS STATEMENT BALANCE", 8)
    page1.right(372, y, money(s["previous_balance"]), 8)
    y -= 16
    for r in activity:
        y = activity_row(page1, y, r)
    y = net(page1, y, activity)
    page1.text(36, y, ADDITIONAL, 8, bold=True)
    page1.text(160, y, ADDITIONAL_CARD, 8)
    y -= 16
    for r in first:
        y = activity_row(page1, y, r)
    page1.right(372, y, "Continued", 8, bold=True)

    panel = [("REWARDS POINTS", None),
             ("Points Earned on Purchases", f"+ {s['purchases'] // 100:,}"), ("Bonus Points", "+ 40"),
             ("Total Points Earned", f"= {s['purchases'] // 100 + 40:,}"), ("", None),
             ("PAYMENT INFORMATION", None),
             ("Minimum Payment", money(max(1000, s["closing_balance"] * 3 // 100))),
             ("Payment Due Date", full_date((date.fromisoformat(s["closing"]) + timedelta(days=21)).isoformat())),
             ("Credit Limit", "$5,000.00"), ("Available Credit", money(500000 - s["closing_balance"])),
             ("Annual Interest Rate: Purchases", "19.99%"), ("", None),
             ("CALCULATING YOUR BALANCE", None),
             ("Previous Balance", money(s["previous_balance"])),
             ("Payments & Credits", money(-payment["amount"])),
             ("Purchases & Other Charges", money(s["purchases"])),
             ("Cash Advances", money(0)), ("Interest", money(0)), ("Fees", money(s["fees"])),
             ("Sub-total", money(s["closing_balance"])), ("NEW BALANCE", money(s["closing_balance"]))]
    y = 656
    for label, value in panel:
        bold = value is None or label == "NEW BALANCE"
        page1.text(392, y, label, 8, bold)
        if value:
            page1.right(576, y, value, 8, bold)
        y -= 14

    page2.text(300, 728, "2 OF 3", 9, bold=True)
    page2.paragraph(36, 700, TERMS_B, 9, 14)

    heading(page3, 3)
    y = table_head(page3, 668)
    page3.text(36, y, f"{ADDITIONAL} (continued)", 8, bold=True)
    page3.text(200, y, ADDITIONAL_CARD, 8)
    y -= 16
    for r in rest:
        y = activity_row(page3, y, r)
    y = net(page3, y, additional)
    page3.text(160, y, "TOTAL NEW BALANCE", 8, bold=True)
    page3.right(372, y, money(s["closing_balance"]), 8, bold=True)
    page3.text(36, y - 30, "MESSAGE CENTRE: this sample has no real payment schedule.", 8)

    references = [{"label": "Purchases & Other Charges", "amount": s["purchases"] / 100, "page": 1}]
    if s["fees"]:
        references.append({"label": "Fees", "amount": s["fees"] / 100, "page": 1})
    return finish([page1, page2, page3], lambda n, total: f"{n} OF {total}"), references, []


class Flow:
    """Writes table lines down the page; when a page fills, starts another with the caller's
    header and repeats the open section title with "(continued)"."""

    def __init__(self, header, bottom=80):
        self.header, self.bottom, self.pages, self.title = header, bottom, [], None
        self.new_page()

    def new_page(self):
        self.page = Page()
        self.pages.append(self.page)
        self.y = self.header(self.page, len(self.pages))
        if self.title:
            self.line([(36, f"{self.title} (continued)")], bold=True)

    def section(self, title):
        self.title = None
        if self.y < self.bottom + 40:
            self.new_page()
        self.y -= 4
        self.line([(36, title)], bold=True)
        self.title = title

    def line(self, cells, bold=False, gap=14):
        """Cells are (x, text) left-aligned or (x, text, "r") right-aligned. Returns the page number."""
        if self.y < self.bottom:
            self.new_page()
        for x, text, *right in cells:
            if text:
                (self.page.right if right else self.page.text)(x, self.y, text, 8, bold)
        self.y -= gap
        return len(self.pages)


def describe(r):
    return "PAYMENT - THANK YOU" if r["category"] is None else r["store"] if r["category"] == "Fee" else f"{r['store']} {CITY}"


# --- layout C: US-style periodic statement ----------------------------------------------------

def layout_c(s):
    rows = s["sections"][0]["rows"]
    fees = [r for r in rows if r["category"] == "Fee"]
    buys = [r for r in rows if r["amount"] > 0 and r["category"] != "Fee"]
    credits = sorted(s["payments"] + [r for r in rows if r["amount"] < 0], key=lambda r: r["date"])
    gross, refunds = sum(r["amount"] for r in buys), sum(r["amount"] for r in rows if r["amount"] < 0)
    paid, closing = sum(p["amount"] for p in s["payments"]), s["closing_balance"]
    period = f"{fmt(s['opening'], 'mm/dd/yy')} - {fmt(s['closing'], 'mm/dd/yy')}"

    def top(p):
        p.text(36, 728, "Sample Rewards Card", 16, bold=True)
        p.text(36, 712, "Periodic Statement", 11)
        p.text(36, 696, f"Account Number: {ACCOUNT['B']}", 8)
        p.text(300, 696, f"Billing Period: {period}", 8)
        p.rule(36, 688, 576)

    summary = Page()
    top(summary)
    summary.text(36, 668, "Summary of Account Activity", 10, bold=True)
    lines = [("Previous Balance", money(s["previous_balance"])), ("Payment", money(paid)), ("Other Credits", money(refunds)),
             ("Purchases", "+" + money(gross)), ("Balance Transfers", "+$0.00"), ("Cash Advances", "+$0.00"),
             ("Fees Charged", "+" + money(s["fees"])), ("Interest Charged", "+$0.00"), ("New Balance", money(closing)),
             ("", ""), ("Credit Limit", "$6,000.00"), ("Available Credit", money(600000 - max(0, closing))),
             ("Statement Closing Date", fmt(s["closing"], "mm/dd/yy")),
             ("Days in Billing Cycle", str((date.fromisoformat(s["closing"]) - date.fromisoformat(s["opening"])).days + 1))]
    y = 650
    for label, value in lines:
        if label:
            summary.text(36, y, label, 9, label == "New Balance")
            summary.right(290, y, value, 9, label == "New Balance")
        y -= 15
    summary.box(330, 520, 246, 160, 0.95)
    summary.text(340, 664, "Payment Information", 10, bold=True)
    for i, (label, value) in enumerate((("New Balance", money(closing)), ("Minimum Payment Due", money(max(2500, closing * 2 // 100))),
                                        ("Payment Due Date", fmt(later(s["closing"], 25), "mm/dd/yy")))):
        summary.text(340, 646 - 15 * i, label, 9)
        summary.right(568, 646 - 15 * i, value, 9)
    summary.paragraph(340, 594, ["Late Payment Warning: if the minimum payment arrives after", "the due date, a sample late fee of up to $29.00 may apply.",
                                 "", "Minimum Payment Warning: paying only the minimum makes", "the balance take longer to repay. Sample wording only."])

    def head(p, number):
        top(p)
        p.text(36, 668, "Transactions", 11, bold=True)
        for x, label in ((36, "Reference Number"), (116, "Trans Date"), (166, "Post Date"), (216, "Description")):
            p.text(x, 650, label, 8, bold=True)
        p.right(576, 650, "Amount", 8, bold=True)
        p.rule(36, 644, 576)
        return 628

    flow, numbers = Flow(head), iter(range(1, 1000))

    def entry(r):
        n = next(numbers)
        flow.line([(36, f"{'QKRMTV'[n % 6]}{'ABCDEFGH'[n % 8]}{n * 7919 % 9000 + 1000}"), (116, fmt(r["date"], "mm/dd")),
                   (166, fmt(r["posted"], "mm/dd")), (216, describe(r)), (576, money(r["amount"], dollar=False), "r")])
        if r.get("fx"):
            currency, foreign, rate = r["fx"]
            flow.line([(216, f"{currency} {foreign / 100:,.2f} @ {rate}")], gap=12)

    for title, members in (("PAYMENTS AND OTHER CREDITS", credits), ("PURCHASES", buys), ("FEES", fees)):
        flow.section(title)
        for r in members:
            entry(r)
    flow.line([(216, "TOTAL FEES FOR THIS PERIOD"), (576, money(s["fees"]), "r")], bold=True)
    flow.section("INTEREST CHARGED")
    flow.line([(216, "Interest Charge on Purchases"), (576, "$0.00", "r")])
    flow.line([(216, "Interest Charge on Cash Advances"), (576, "$0.00", "r")])
    flow.line([(216, "TOTAL INTEREST FOR THIS PERIOD"), (576, "$0.00", "r")], bold=True)
    year = s["closing"][:4]
    flow.section(f"{year} Totals Year-to-Date")
    flow.line([(36, f"Total fees charged in {year}"), (576, money(s["fees"] + 6450), "r")])
    flow.line([(36, f"Total interest charged in {year}"), (576, "$0.00", "r")])
    flow.section("Interest Charge Calculation")
    flow.line([(36, "Type of Balance"), (150, "Annual Percentage Rate (APR)"), (330, "Balance Subject to Interest Rate"),
               (576, "Interest Charge", "r")], bold=True)
    for label, rate in (("Purchases", "19.99%"), ("Cash Advances", "24.99%")):
        flow.line([(36, label), (150, rate), (330, "$0.00"), (576, "$0.00", "r")])

    references = [{"label": "Purchases", "amount": gross / 100, "page": 1},
                  {"label": "Other Credits", "amount": refunds / 100, "page": 1},
                  {"label": "Fees Charged", "amount": s["fees"] / 100, "page": 1}]
    return finish([summary] + flow.pages, lambda n, total: f"Page {n} of {total}"), references, []


# --- layout D: post date first, CR credits, no clean reference ---------------------------------

def layout_d(s):
    primary = sorted(s["sections"][0]["rows"] + s["payments"], key=lambda r: r["date"])
    additional = s["sections"][1]["rows"]
    rows = s["sections"][0]["rows"] + additional
    credits = sum(r["amount"] for r in rows + s["payments"] if r["amount"] < 0)
    debits = sum(r["amount"] for r in rows if r["amount"] > 0)
    plan = [r for r in rows if " 1ST OF " in r["store"]]
    outstanding = sum(r["amount"] * 5 for r in plan)  # five instalments still to bill
    closing = s["closing_balance"]

    def amount(cents):
        return f"{abs(cents) / 100:.2f}" + (" CR" if cents < 0 else "")  # no thousands separator, as some issuers print

    def panel(p):
        lines = [("ACCOUNT SUMMARY", None), ("Previous Statement Balance", amount(s["previous_balance"])),
                 ("Payments & Credits", amount(credits)), ("Purchases & Debits", amount(debits)),
                 ("Outstanding Instalments", amount(outstanding)), ("Total Account Balance", amount(closing)), ("", None),
                 ("CREDIT LIMIT AND INTEREST RATES", None), ("Credit Limit ($)", "9000.00"),
                 ("Available Credit ($)", amount(900000 - max(0, closing))), ("Annual Interest Rate", None),
                 ("Purchase", "26.90%"), ("Cash Advance", "28.90%"), ("", None), ("REWARDS SUMMARY", None),
                 ("Points Carried Forward", "4,210"), ("Points Earned", f"{debits // 100:,}"), ("Bonus Points", "120"),
                 ("Points Redeemed", "0"), ("Points Expired", "0"), ("Total Points Available", f"{4330 + debits // 100:,}")]
        y = 638
        for label, value in lines:
            p.text(392, y, label, 8, value is None)
            if value:
                p.right(576, y, value, 8)
            y -= 13

    def head(p, number):
        p.text(36, 728, "Sample Rewards Card", 14, bold=True)
        p.text(36, 714, "STATEMENT OF ACCOUNT", 9)
        p.text(36, 700, PRIMARY, 8)
        p.text(36, 690, "XXXX-XXXX-XXXX-0000", 8)
        for x, label, value in ((36, "Statement period", f"{fmt(s['opening'], 'dd MON yyyy')} to {fmt(s['closing'], 'dd MON yyyy')}"),
                                (230, "Total Due", amount(closing)), (330, "Minimum Payment", amount(max(5000, closing * 3 // 100))),
                                (450, "Payment Due Date", fmt(later(s["closing"], 21), "dd MON yyyy"))):
            p.text(x, 672, label, 8, bold=True)
            p.text(x, 660, value, 8)
        p.rule(36, 652, 576)
        if number == 1:
            panel(p)
        for x, label in ((36, "POST DATE"), (90, "TRAN DATE"), (145, "DESCRIPTION")):
            p.text(x, 638, label, 7, bold=True)
        p.right(372, 638, "AMOUNT ($)", 7, bold=True)
        p.rule(36, 632, 372)
        return 618

    flow = Flow(head)
    for holder, card, members in ((PRIMARY, "XXXX-XXXX-XXXX-0000", primary), (ADDITIONAL, "XXXX-XXXX-XXXX-0001", additional)):
        flow.section(f"{holder}   {card}")
        if holder == PRIMARY:
            flow.line([(145, "Previous Statement Balance"), (372, amount(s["previous_balance"]), "r")])
        for r in members:
            first, instalment, rest = (r["store"] if r["category"] else "PAYMENT - THANK YOU").partition(" 1ST OF ")
            flow.line([(36, fmt(r["posted"], "dd mon")), (90, fmt(r["date"], "dd mon")), (145, first), (372, amount(r["amount"]), "r")])
            if instalment:
                flow.line([(145, f"1ST OF {rest}")], gap=12)
    flow.line([(145, "Total Due"), (372, amount(closing), "r")], bold=True)
    if plan:
        flow.section("YOUR INSTALMENT PLAN")
        flow.line([(36, "DATE"), (120, "EXPIRY"), (300, "AMOUNT ($)", "r"), (372, "BALANCE ($)", "r")], bold=True)
        for r in plan:
            flow.line([(36, r["store"].partition(" 1ST OF ")[0])])
            flow.line([(36, fmt(r["date"], "dd MON yyyy")), (120, fmt(later(r["date"], 150), "dd MON yyyy")),
                       (300, amount(r["amount"] * 6), "r"), (372, amount(r["amount"] * 5), "r")])
    return finish(flow.pages, lambda n, total: f"Page {n} of {total}"), None, []


# --- layout E: online transaction history, no summary ------------------------------------------

def layout_e(s):
    balance, lines = s["previous_balance"], []
    for r in sorted(s["sections"][0]["rows"] + s["payments"], key=lambda r: r["date"]):
        balance += r["amount"]
        lines.append((r, balance))

    def head(p, number):
        p.text(36, 728, "Sample Rewards Card", 14, bold=True)
        p.text(36, 712, "Transaction history (online account view)", 10)
        p.text(36, 698, f"Card {ACCOUNT['B']}", 8)
        p.text(36, 686, f"Showing posted transactions from {fmt(s['opening'], 'dd/mm/yyyy')} "
                        f"to {fmt(s['closing'], 'dd/mm/yyyy')}, newest first", 8)
        p.text(400, 698, f"Printed {fmt(later(s['closing'], 2), 'dd/mm/yyyy')}", 8)
        if number == 1:
            p.text(400, 686, f"Current balance {money(s['closing_balance'])}", 8)
            p.text(400, 674, f"Available credit {money(700000 - s['closing_balance'])}", 8)
        for x, label in ((36, "Date"), (100, "Description")):
            p.text(x, 656, label, 8, bold=True)
        for x, label in ((420, "Debit"), (490, "Credit"), (576, "Balance")):
            p.right(x, 656, label, 8, bold=True)
        p.rule(36, 650, 576)
        return 634

    flow = Flow(head)
    for r, after in reversed(lines):
        flow.line([(36, fmt(r["date"], "dd/mm/yyyy")), (100, describe(r)),
                   (420, money(r["amount"], dollar=False) if r["amount"] > 0 else "", "r"),
                   (490, money(-r["amount"], dollar=False) if r["amount"] < 0 else "", "r"), (576, money(after), "r")])
    flow.line([(100, "Opening balance"), (576, money(s["previous_balance"]), "r")], bold=True)
    return finish(flow.pages, lambda n, total: f"Page {n} of {total}"), None, []


# --- layout F: grouped by spending category ---------------------------------------------------

CATEGORY_ORDER = ("Groceries", "Dining", "Transport", "Shopping", "Health", "Entertainment", "Travel",
                  "Subscriptions", "Utilities", "Fee")


def layout_f(s):
    rows = s["sections"][0]["rows"]
    groups = [("Fees and charges" if c == "Fee" else c, [r for r in rows if r["category"] == c]) for c in CATEGORY_ORDER]
    groups = [(name, members) for name, members in groups if members]
    assert sum(len(members) for _, members in groups) == len(rows), "every row needs a category group"
    paid, total = sum(p["amount"] for p in s["payments"]), s["purchases"] + s["fees"]
    period = f"{fmt(s['opening'], 'weekday')} to {fmt(s['closing'], 'weekday')}, {s['closing'][:4]}"

    def top(p):
        p.text(36, 728, "Sample Rewards Card", 16, bold=True)
        p.text(36, 712, "Monthly Statement", 11)
        p.text(36, 696, f"Card {ACCOUNT['B']}", 8)
        p.text(300, 696, f"Statement period: {period}", 8)
        p.rule(36, 688, 576)

    summary = Page()
    top(summary)
    summary.text(36, 668, "Account summary", 10, bold=True)
    y = 650
    for label, value in (("Previous balance", money(s["previous_balance"])), ("Payments received", money(paid)),
                         ("New purchases (net of returns)", money(s["purchases"])), ("Fees and charges", money(s["fees"])),
                         ("Interest", money(0)), ("New balance", money(s["closing_balance"]))):
        summary.text(36, y, label, 9, label == "New balance")
        summary.right(300, y, value, 9, label == "New balance")
        y -= 15
    summary.text(36, y - 14, "Your spending this period", 10, bold=True)
    y -= 34
    summary.text(36, y, "Category", 8, bold=True)
    for x, label in ((230, "Transactions"), (330, "Amount"), (400, "Share")):
        summary.right(x, y, label, 8, bold=True)
    y -= 14
    for name, members in groups + [("Total", rows)]:
        cents = sum(r["amount"] for r in members)
        cells = (name, str(len(members)), money(cents), f"{(200 * cents + total) // (2 * total)}%")
        summary.text(36, y, cells[0], 9, name == "Total")
        for x, text in zip((230, 330, 400), cells[1:]):
            summary.right(x, y, text, 9, name == "Total")
        y -= 14

    def head(p, number):
        top(p)
        p.text(36, 668, "Transactions by category", 11, bold=True)
        p.text(36, 650, "Date", 8, bold=True)
        p.text(130, 650, "Merchant", 8, bold=True)
        p.right(470, 650, "Points", 8, bold=True)
        p.right(576, 650, "Amount", 8, bold=True)
        p.rule(36, 644, 576)
        return 628

    flow, subtotals = Flow(head), []
    for name, members in groups:
        flow.section(name)
        for r in members:
            points = 0 if r["category"] == "Fee" else int(r["amount"] / 100)
            flow.line([(36, fmt(r["date"], "weekday")), (130, describe(r)), (470, str(points), "r"), (576, money(r["amount"]), "r")])
        cents = sum(r["amount"] for r in members)
        page = flow.line([(130, f"{name} total"), (576, money(cents), "r")], bold=True)
        subtotals.append({"label": f"{name} total", "amount": cents / 100, "page": page + 1})  # after the summary page
    flow.section("Payments")
    for r in s["payments"]:
        flow.line([(36, fmt(r["date"], "weekday")), (130, describe(r)), (576, money(r["amount"]), "r")])
    flow.line([(130, "Payments total"), (576, money(paid), "r")], bold=True)

    references = [{"label": "New purchases (net of returns)", "amount": s["purchases"] / 100, "page": 1}]
    if s["fees"]:
        references.append({"label": "Fees and charges", "amount": s["fees"] / 100, "page": 1})
    alternatives = [[{"label": "Total", "amount": total / 100, "page": 1}], subtotals]
    return finish([summary] + flow.pages, lambda n, total: f"Page {n} of {total}"), references, alternatives


LAYOUTS = {"A": layout_a, "B": layout_b, "C": layout_c, "D": layout_d, "E": layout_e, "F": layout_f}

# What each statement can showcase in the app's demo mode; the scorer ignores this field.
DEMO = {
    "sample-a1": "Reconciles purchases plus fees, not the negative closing balance after an overpayment",
    "sample-a3": "Same charge twice on one day: the import flags a potential duplicate",
    "sample-c1": "Transactions grouped by type, with foreign-currency rows and separate foreign transaction fees",
    "sample-d1": "No printed purchase total: the app refuses the PDF and imports no rows, rather than guess a total",
    "sample-f1": "Transactions grouped by spending category, with points per row",
}


def build():
    """Return {file name: bytes} for every PDF and the manifest."""
    files, cases = {}, []
    for s in statements():
        pages, references, alternatives = LAYOUTS[s["layout"]](s)
        name = f"{s['id']}.pdf"
        files[name] = pdf(pages, f"Fictional sample statement {s['id']}")
        rows = [r for section in s["sections"] for r in section["rows"]]
        cases.append({
            "id": s["id"], "split": s["split"], "layout": s["layout"], "path": name,
            "transactions": [{"date": r["date"], "amount": r["amount"] / 100} for r in rows],
            "expectedTotalCents": None if references is None else sum(r["amount"] for r in rows),
            "referenceComponents": references, "referenceAlternatives": alternatives,
            "closingBalanceCents": s["closing_balance"],
            **({"demo": DEMO[s["id"]]} if s["id"] in DEMO else {}),
        })
    files["manifest.json"] = (json.dumps({"cases": cases}, indent=2) + "\n").encode()
    return files


if __name__ == "__main__":
    OUTPUT.mkdir(exist_ok=True)
    for name, data in build().items():
        (OUTPUT / name).write_bytes(data)
    print(f"wrote {len(statements())} fictional statements and manifest.json to {OUTPUT}")
