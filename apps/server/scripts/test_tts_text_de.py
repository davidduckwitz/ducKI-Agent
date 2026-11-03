import unittest

from tts_text_de import cardinal, normalize_german as n, ordinal


class GermanNormalizerTest(unittest.TestCase):
    def test_cardinals(self):
        self.assertEqual(cardinal(0), "null")
        self.assertEqual(cardinal(1), "eins")
        self.assertEqual(cardinal(1, final=False), "ein")
        self.assertEqual(cardinal(21), "einundzwanzig")
        self.assertEqual(cardinal(101), "einhunderteins")
        self.assertEqual(cardinal(1000), "eintausend")
        self.assertEqual(cardinal(1234), "eintausendzweihundertvierunddreißig")
        self.assertEqual(cardinal(2025), "zweitausendfünfundzwanzig")
        self.assertEqual(cardinal(1_000_000), "eine Million")
        self.assertEqual(cardinal(2_300_000), "zwei Millionen dreihunderttausend")

    def test_ordinals(self):
        self.assertEqual([ordinal(i) for i in (1, 3, 7, 8, 20, 21)],
                         ["ersten", "dritten", "siebten", "achten", "zwanzigsten", "einundzwanzigsten"])

    def test_money_percent_units(self):
        self.assertEqual(n("Es kostet 12,50 € bar."), "Es kostet zwölf Euro fünfzig bar.")
        self.assertEqual(n("nur 1 €"), "nur ein Euro")
        self.assertEqual(n("20 % mehr bei 25 °C"), "zwanzig Prozent mehr bei fünfundzwanzig Grad Celsius")
        self.assertEqual(n("5 km/h und 100 GB"), "fünf Kilometer pro Stunde und einhundert Gigabyte")
        self.assertEqual(n("1 h später"), "eine Stunde später")
        self.assertEqual(n("$5 und £3,50"), "fünf Dollar und drei Pfund fünfzig")

    def test_dates_and_times(self):
        self.assertEqual(n("Am 3.5.2025"), "Am dritten Mai zweitausendfünfundzwanzig")
        self.assertEqual(n("am 1. Mai"), "am ersten Mai")
        self.assertEqual(n("um 14:30 Uhr"), "um vierzehn Uhr dreißig")
        self.assertEqual(n("um 9:00"), "um neun Uhr")
        self.assertEqual(n("im Jahr 1999"), "im Jahr neunzehnhundertneunundneunzig")

    def test_numbers_in_text(self):
        self.assertEqual(n("21 Birnen und 1.234 Nüsse"), "einundzwanzig Birnen und eintausendzweihundertvierunddreißig Nüsse")
        self.assertEqual(n("1 Apfel"), "ein Apfel")
        self.assertEqual(n("Platz 1 von 10"), "Platz eins von zehn")
        self.assertEqual(n("pi ist 3,14"), "pi ist drei Komma eins vier")
        self.assertEqual(n("Wert -5"), "Wert minus fünf")
        self.assertEqual(n("von 10-20 Leuten"), "von zehn bis zwanzig Leuten")
        self.assertEqual(n("Rufnummer 0171 1234567"), "Rufnummer null eins sieben eins eins zwei drei vier fünf sechs sieben")

    def test_abbreviations_and_symbols(self):
        self.assertEqual(n("z. B. ca. 5 Stück, d.h. fünf, usw."), "zum Beispiel circa fünf Stück, das heißt fünf, und so weiter.")
        self.assertEqual(n("Tom & Jerry"), "Tom und Jerry")
        self.assertEqual(n("2+2=4"), "zwei plus zwei gleich vier")
        self.assertEqual(n("**fett** und `code`"), "fett und code")
        self.assertEqual(n("max@example.de"), "max at example Punkt de")

    def test_plain_text_unchanged(self):
        text = "Hallo, ich bin dein persönlicher Assistent."
        self.assertEqual(n(text), text)


if __name__ == "__main__":
    unittest.main()
