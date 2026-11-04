import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from fastapi import HTTPException

from backend.app import (
    HeatReport,
    build_routing_url,
    build_nominatim_url,
    city_insights,
    cities,
    create_report,
    geocode,
    initialize_database,
    list_reports,
    parse_coordinate,
    report_bounds,
    route_comfort,
    routes,
)


class RouteHelpersTests(unittest.TestCase):
    def test_parse_coordinate_uses_longitude_then_latitude(self):
        self.assertEqual(parse_coordinate("76.8897,43.2389", "начала"), (76.8897, 43.2389))

    def test_parse_coordinate_rejects_out_of_range_values(self):
        with self.assertRaises(HTTPException):
            parse_coordinate("200,43", "начала")

    def test_route_urls_use_the_selected_transport_profile(self):
        foot_url = build_routing_url(76.9, 43.2, 76.91, 43.21, "foot")
        bike_url = build_routing_url(76.9, 43.2, 76.91, 43.21, "bike")
        self.assertIn("/routed-foot/", urlparse(foot_url).path)
        self.assertIn("/routed-bike/", urlparse(bike_url).path)

    def test_nominatim_search_preserves_unicode_names_and_language_preference(self):
        query = "\u6771\u4eac"
        language = "ja-JP,en-US"
        url = build_nominatim_url(query, limit=10, language=language, featuretype="city")
        parameters = parse_qs(urlparse(url).query)
        self.assertEqual(parameters["q"], [query])
        self.assertEqual(parameters["accept-language"], [language])
        self.assertEqual(parameters["featuretype"], ["city"])

    def test_nominatim_search_rejects_malformed_language_preferences(self):
        with self.assertRaises(HTTPException):
            build_nominatim_url("Almaty", limit=5, language="en\r\nInjected: true")

    def test_route_endpoint_uses_the_selected_transport_profile(self):
        def fake_fetch(url, timeout=12):
            self.assertGreater(timeout, 0)
            if "routing.openstreetmap.de" in url:
                self.assertIn("/routed-bike/", urlparse(url).path)
                return {
                    "code": "Ok",
                    "routes": [
                        {
                            "distance": 1000,
                            "duration": 300,
                            "geometry": {"coordinates": [[76.9, 43.2], [76.91, 43.21]]},
                        }
                    ],
                }
            if "open-meteo.com" in url:
                return {"current": {"temperature_2m": 30}}
            return {"elements": []}

        with patch("backend.app.fetch_json", side_effect=fake_fetch):
            response = routes(
                start="76.9,43.2",
                end="76.91,43.21",
                mode="bike",
            )
        self.assertEqual(response["mode"], "bike")
        self.assertEqual(len(response["routes"]), 1)

    def test_city_search_returns_only_city_places(self):
        response = [
            {"category": "historic", "type": "castle", "lat": "1", "lon": "2"},
            {"category": "place", "type": "city", "name": "Астана", "display_name": "Астана, Казахстан", "lat": "51.1", "lon": "71.4"},
        ]
        with patch("backend.app.fetch_json", return_value=response):
            results = cities("Астана")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["name"], "Астана")

    def test_city_and_address_search_forward_unicode_and_language(self):
        query = "\u6771\u4eac"
        language = "ja-JP,en-US"
        city_response = [
            {
                "category": "place",
                "type": "city",
                "name": query,
                "display_name": query,
                "lat": "35.6762",
                "lon": "139.6503",
            }
        ]
        address_response = [
            {
                "display_name": "\u6771\u4eac\u99c5",
                "lat": "35.6812",
                "lon": "139.7671",
            }
        ]
        with patch("backend.app.fetch_json", side_effect=[city_response, address_response]) as fetch:
            self.assertEqual(cities(query, language)[0]["name"], query)
            self.assertEqual(geocode(query, language)[0]["name"], "\u6771\u4eac\u99c5")

        city_parameters = parse_qs(urlparse(fetch.call_args_list[0].args[0]).query)
        address_parameters = parse_qs(urlparse(fetch.call_args_list[1].args[0]).query)
        for parameters in (city_parameters, address_parameters):
            self.assertEqual(parameters["q"], [query])
            self.assertEqual(parameters["accept-language"], [language])

    def test_city_report_filter_requires_both_coordinates(self):
        with self.assertRaises(HTTPException):
            report_bounds(43.2, None, 25)

    def test_greenery_and_water_improve_route_comfort(self):
        route = {"distance": 2000, "duration": 1200}
        plain = route_comfort(route, 30, 0, 0)
        greener = route_comfort(route, 30, 5, 2)
        self.assertGreater(greener, plain)

    def test_missing_environment_data_uses_available_factors(self):
        score = route_comfort({"distance": 2000, "duration": 1200}, 30, None, None)
        self.assertGreaterEqual(score, 0)
        self.assertLessEqual(score, 100)

    def test_heat_reports_are_saved_and_aggregated(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "reports.db"
            with patch("backend.app.DATABASE_PATH", database_path):
                initialize_database()
                saved = create_report(
                    HeatReport(
                        latitude=43.2389,
                        longitude=76.8897,
                        category="hot",
                        note="   ",
                    )
                )
                create_report(
                    HeatReport(
                        latitude=51.1694,
                        longitude=71.4491,
                        category="hot",
                    )
                )
                self.assertEqual(saved["note"], "")
                self.assertEqual(len(list_reports()), 2)
                self.assertEqual(
                    len(list_reports(latitude=43.2389, longitude=76.8897, radius_km=25)),
                    1,
                )
                self.assertEqual(
                    city_insights(latitude=43.2389, longitude=76.8897, radius_km=25)["total_reports"],
                    1,
                )


if __name__ == "__main__":
    unittest.main()
