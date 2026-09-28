import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from prepare_geodata import select_candidate


def candidate(name, lat=55.7):
    return {"id": "a", "type": "building", "full_name": "Москва, " + name,
            "address_name": name, "point": {"lat": lat, "lon": 37.6}}


class GeocodingTests(unittest.TestCase):
    def test_corpus_is_not_structure(self):
        self.assertIsNone(select_candidate("г. Москва, ул Юных Ленинцев, д 83с 4", [candidate("улица Юных Ленинцев, 83 к4")]))

    def test_street_type_matters(self):
        matching = candidate("Ореховый проезд, 41")
        other = candidate("Ореховый бульвар, 41", 55.8)
        self.assertEqual(select_candidate("Город Москва, проезд.Ореховый, д. 41", [other, matching]), matching)

    def test_ambiguous_same_address_stays_unresolved(self):
        self.assertIsNone(select_candidate("Город Москва, ул.Талалихина, д. 16", [candidate("улица Талалихина, 16"), candidate("улица Талалихина, 16", 55.5)]))

    def test_equivalent_abbreviations_and_dual_address(self):
        matching = candidate("Смоленский бульвар, 17 ст1")
        self.assertEqual(select_candidate("Город Москва, б-р.Смоленский, д. 17 стр. 1", [matching]), matching)
        matching = candidate("Саратовская улица, 14/1 / 2-й Саратовский проезд, 1")
        self.assertEqual(select_candidate("Город Москва, ул.Саратовская, д. 14/1", [matching]), matching)


if __name__ == "__main__":
    unittest.main()
