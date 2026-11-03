"""
German text normalisation for TTS engines that read raw characters (Pocket TTS has none: digits,
currency, dates, units and abbreviations reach the model verbatim and come out garbled in German).

normalize_german("Es kostet 12,50 € bis zum 3.5.2025, ca. 5 km/h.")
  -> "Es kostet zwölf Euro fünfzig bis zum dritten Mai zweitausendfünfundzwanzig, circa fünf Kilometer pro Stunde."

Dependency-free on purpose (no num2words): the venv stays small and reinstall-free.
"""

import re

_ONES = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf",
         "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"]
_TENS = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"]
_MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"]
_MONTH_RE = "|".join(_MONTHS)


def _below100(n, final):
    if n < 20:
        return "ein" if (n == 1 and not final) else _ONES[n]
    tens, ones = divmod(n, 10)
    if ones == 0:
        return _TENS[tens]
    return ("ein" if ones == 1 else _ONES[ones]) + "und" + _TENS[tens]


def _below1000(n, final):
    hundreds, rest = divmod(n, 100)
    text = ""
    if hundreds:
        text = ("ein" if hundreds == 1 else _ONES[hundreds]) + "hundert"
    if rest:
        text += _below100(rest, final)
    return text


def cardinal(n, final=True):
    """Spoken German cardinal. `final=False` yields the attributive form ('ein Euro', not 'eins Euro')."""
    if n == 0:
        return "null"
    billions, rest = divmod(n, 10**9)
    millions, rest = divmod(rest, 10**6)
    thousands, rest = divmod(rest, 1000)
    parts = []
    if billions:
        parts.append("eine Milliarde" if billions == 1 else f"{_below1000(billions, False)} Milliarden")
    if millions:
        parts.append("eine Million" if millions == 1 else f"{_below1000(millions, False)} Millionen")
    tail = ""
    if thousands:
        tail += ("ein" if thousands == 1 else _below1000(thousands, False)) + "tausend"
    if rest:
        tail += _below1000(rest, final)
    if tail:
        parts.append(tail)
    return " ".join(parts)


def ordinal(n, ending="en"):
    """'dritten', 'siebten', 'zwanzigsten' ... (dative/accusative form, as used after 'am', 'den', 'zum')."""
    special = {1: "erst", 3: "dritt", 7: "siebt", 8: "acht"}
    if n in special:
        return special[n] + ending
    word = cardinal(n, final=False)
    return word + ("t" if n < 20 else "st") + ending


def _digits(text):
    return " ".join(_ONES[int(d)] if d != "1" else "eins" for d in text)


def _speak_int(raw, followed_by_word):
    plain = "." not in raw
    raw = raw.replace(".", "")
    # Phone numbers / IDs: leading zero or a long run of digits without thousand separators.
    if (len(raw) > 1 and raw.startswith("0")) or (plain and len(raw) >= 7) or len(raw) > 12:
        return _digits(raw)
    return cardinal(int(raw), final=not followed_by_word)


# --- abbreviations (matched case-sensitively, with optional space after inner dots) ----------
_ABBREVIATIONS = [
    (r"\bz\.\s?B\.", "zum Beispiel"), (r"\bd\.\s?h\.", "das heißt"), (r"\bu\.\s?a\.", "unter anderem"),
    (r"\bu\.\s?U\.", "unter Umständen"), (r"\bs\.\s?o\.", "siehe oben"), (r"\bs\.\s?u\.", "siehe unten"),
    (r"\bi\.\s?d\.\s?R\.", "in der Regel"), (r"\bo\.\s?ä\.", "oder ähnliches"), (r"\bevtl\.", "eventuell"),
    (r"\busw\.", "und so weiter"), (r"\betc\.", "et cetera"), (r"\bbzw\.", "beziehungsweise"),
    (r"\bca\.", "circa"), (r"\bggf\.", "gegebenenfalls"), (r"\binkl\.", "inklusive"), (r"\bexkl\.", "exklusive"),
    (r"\bvgl\.", "vergleiche"), (r"\bsog\.", "sogenannte"), (r"\bDr\.", "Doktor"), (r"\bProf\.", "Professor"),
    (r"\bNr\.", "Nummer"), (r"\bStr\.", "Straße"), (r"\bTel\.", "Telefon"), (r"\bMio\.", "Millionen"),
    (r"\bMrd\.", "Milliarden"), (r"\bz\.\s?T\.", "zum Teil"), (r"\bv\.\s?a\.", "vor allem"),
]

# --- units following a number: token -> (singular, plural, feminine singular?) ---------------
_UNITS = {
    "km/h": ("Kilometer pro Stunde", "Kilometer pro Stunde", False), "m/s": ("Meter pro Sekunde", "Meter pro Sekunde", False),
    "km²": ("Quadratkilometer", "Quadratkilometer", False), "m²": ("Quadratmeter", "Quadratmeter", False),
    "m³": ("Kubikmeter", "Kubikmeter", False), "km": ("Kilometer", "Kilometer", False), "cm": ("Zentimeter", "Zentimeter", False),
    "mm": ("Millimeter", "Millimeter", False), "m": ("Meter", "Meter", False), "kg": ("Kilogramm", "Kilogramm", False),
    "mg": ("Milligramm", "Milligramm", False), "g": ("Gramm", "Gramm", False), "ml": ("Milliliter", "Milliliter", False),
    "l": ("Liter", "Liter", False), "h": ("Stunde", "Stunden", True), "min": ("Minute", "Minuten", True),
    "s": ("Sekunde", "Sekunden", True), "TB": ("Terabyte", "Terabyte", False), "GB": ("Gigabyte", "Gigabyte", False),
    "MB": ("Megabyte", "Megabyte", False), "KB": ("Kilobyte", "Kilobyte", False), "kB": ("Kilobyte", "Kilobyte", False),
    "GHz": ("Gigahertz", "Gigahertz", False), "MHz": ("Megahertz", "Megahertz", False), "kHz": ("Kilohertz", "Kilohertz", False),
    "Hz": ("Hertz", "Hertz", False), "kWh": ("Kilowattstunde", "Kilowattstunden", True), "kW": ("Kilowatt", "Kilowatt", False),
    "W": ("Watt", "Watt", False), "V": ("Volt", "Volt", False), "°C": ("Grad Celsius", "Grad Celsius", False),
    "°F": ("Grad Fahrenheit", "Grad Fahrenheit", False), "°": ("Grad", "Grad", False),
    "%": ("Prozent", "Prozent", False), "‰": ("Promille", "Promille", False),
}
_UNIT_RE = "|".join(re.escape(u) for u in sorted(_UNITS, key=len, reverse=True))
_NUM = r"\d{1,3}(?:\.\d{3})+|\d+"
_WORD_AFTER = r"(?=\s+[A-Za-zÄÖÜäöüß])"

_CURRENCIES = {"€": ("Euro", "Cent"), "EUR": ("Euro", "Cent"), "Euro": ("Euro", "Cent"), "$": ("Dollar", "Cent"),
               "USD": ("Dollar", "Cent"), "£": ("Pfund", "Pence"), "CHF": ("Franken", "Rappen")}
_CUR_RE = "|".join(re.escape(c) for c in sorted(_CURRENCIES, key=len, reverse=True))


def _currency(match):
    return _speak_money(match.group(1), match.group(2), match.group(3))


def _speak_money(whole_raw, cents_raw, symbol):
    whole = int(whole_raw.replace(".", ""))
    unit = _CURRENCIES[symbol][0]
    text = f"{cardinal(whole, final=False)} {unit}"
    if cents_raw and int(cents_raw.ljust(2, '0')) != 0:
        text += f" {cardinal(int(cents_raw.ljust(2, '0')), final=True)}"
    return text


def _date_full(match):
    day, month, year = int(match.group(1)), int(match.group(2)), match.group(3)
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return match.group(0)
    y = int(year) + (2000 if len(year) == 2 and int(year) < 70 else 1900 if len(year) == 2 else 0)
    return f"{ordinal(day)} {_MONTHS[month - 1]} {_year_words(y)}"


def _date_short(match):
    day, month = int(match.group(1)), int(match.group(2))
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return match.group(0)
    return f"{ordinal(day)} {_MONTHS[month - 1]}"


def _year_words(year):
    if 1100 <= year <= 1999:
        hundreds, rest = divmod(year, 100)
        return cardinal(hundreds, final=False) + "hundert" + (cardinal(rest, final=True) if rest else "")
    return cardinal(year)


def _time(match):
    hours, minutes = int(match.group(1)), int(match.group(2))
    if hours > 24 or minutes > 59:
        return match.group(0)
    text = f"{cardinal(hours, final=False)} Uhr"
    if minutes:
        text += f" {cardinal(minutes)}"
    return text


def _unit_after_number(match):
    number, unit = match.group(1), match.group(2)
    singular, plural, feminine = _UNITS[unit]
    value = int(number.replace(".", "")) if number.replace(".", "").isdigit() else None
    if value == 1:
        return f"{'eine' if feminine else 'ein'} {singular}"
    spoken = _speak_int(number, followed_by_word=True)
    return f"{spoken} {plural}"


def _decimal(match):
    whole, frac = match.group(1), match.group(2)
    return f"{_speak_int(whole, followed_by_word=True)} Komma {_digits(frac)}"


def normalize_german(text):
    if not text:
        return text
    t = text

    # URLs / e-mail addresses -> spoken form
    t = re.sub(r"https?://", "", t)
    t = re.sub(r"\bwww\.", "www ", t)
    t = re.sub(r"(\w)@(\w)", r"\1 at \2", t)
    t = re.sub(r"(?<=[A-Za-z0-9])\.(?=(?:com|de|org|net|io|ch|at|eu|info|app|dev)\b)", " Punkt ", t)

    # "usw."/"etc." often end a sentence: keep that full stop so the sentence boundary survives.
    t = re.sub(r"\busw\.(?=\s*$|\s+[A-ZÄÖÜ])", "und so weiter.", t)
    t = re.sub(r"\betc\.(?=\s*$|\s+[A-ZÄÖÜ])", "et cetera.", t)
    for pattern, spoken in _ABBREVIATIONS:
        t = re.sub(pattern, spoken, t)

    # fractions
    t = re.sub(r"\b1/2\b", "ein halb", t)
    t = re.sub(r"\b1/4\b", "ein Viertel", t)
    t = re.sub(r"\b3/4\b", "drei Viertel", t)

    # dates and times
    t = re.sub(r"\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b", _date_full, t)
    t = re.sub(r"\b(\d{1,2})\.(\d{1,2})\.(?!\d)", _date_short, t)
    t = re.sub(rf"\b(\d{{1,2}})\.\s+({_MONTH_RE})\b", lambda m: f"{ordinal(int(m.group(1)))} {m.group(2)}", t)
    t = re.sub(r"\b(\d{1,2}):(\d{2})(?:\s?Uhr)?\b", _time, t)

    # money, then percent / degrees / measurement units
    t = re.sub(rf"({_NUM})(?:,(\d{{1,2}}))?\s?({_CUR_RE})(?![A-Za-z])", _currency, t)
    t = re.sub(rf"(?<![\w.,])([$£])\s?({_NUM})(?:,(\d{{1,2}}))?(?![\d])",
               lambda m: _speak_money(m.group(2), m.group(3), m.group(1)), t)
    t = re.sub(rf"({_NUM})\s?({_UNIT_RE})(?![\wäöüÄÖÜß])", _unit_after_number, t)

    # years (1100-1999) after typical prepositions / month names
    t = re.sub(rf"\b((?:im Jahr|Jahr|seit|ab|bis|in|um|vor|nach|von|Anfang|Ende|{_MONTH_RE}))\s(1[1-9]\d{{2}})\b",
               lambda m: f"{m.group(1)} {_year_words(int(m.group(2)))}", t)

    # decimals, thousands separators, ranges, negatives
    t = re.sub(rf"(?<![\d.])({_NUM}),(\d+)(?!\d)", _decimal, t)
    t = re.sub(r"(?<![\w.])(\d+)\s?[-–]\s?(\d+)(?![\w.])", lambda m: f"{m.group(1)} bis {m.group(2)}", t)
    t = re.sub(r"(?<![\w)])-(\d)", r"minus \1", t)

    # remaining integers
    def integer(match):
        end = match.end()
        # attributive "ein" only before a noun (capitalised word); "Platz eins von zehn" stays "eins"
        followed_by_word = bool(re.match(r"\s+[A-ZÄÖÜ]", t[end:end + 3]))
        return _speak_int(match.group(0), followed_by_word)
    t = re.sub(rf"(?<![\w.,])(?:{_NUM})(?![\w])", integer, t)

    # leftover symbols
    for symbol, spoken in (("&", " und "), ("+", " plus "), ("=", " gleich "), ("§", "Paragraph "), ("~", "ungefähr "),
                           ("→", ", "), ("←", ", "), ("≈", " ungefähr "), ("≥", " größer gleich "), ("≤", " kleiner gleich "),
                           ("…", "."), ("°", " Grad "), ("€", " Euro "), ("$", " Dollar "), ("%", " Prozent ")):
        t = t.replace(symbol, spoken)
    t = re.sub(r"(?<=\w)\s*/\s*(?=\w)", " ", t)
    t = re.sub(r"[*_`#|^<>{}\[\]\\]", " ", t)
    t = re.sub(r"[\U0001F300-\U0001FAFF☀-➿️]", "", t)  # emoji / dingbats
    t = re.sub(r"\s+([,.;:!?])", r"\1", t)
    return re.sub(r"\s{2,}", " ", t).strip()

