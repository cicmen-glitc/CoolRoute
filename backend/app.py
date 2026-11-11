from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import unicodedata
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Annotated, Generator, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"
DATA_DIR = ROOT / "data"
DATABASE_PATH = Path(os.environ.get("COOLROUTE_DATABASE", DATA_DIR / "coolroute.db"))
USER_AGENT = "CoolRoute/1.0 (community urban heat mapping prototype)"
LANGUAGE_TAGS = re.compile(r"^[A-Za-z0-9,*;=._ -]{1,100}$")


def fetch_json(url: str, *, timeout: int = 12) -> object:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=502,
            detail="Внешний картографический сервис временно недоступен. Попробуйте ещё раз позже.",
        ) from exc


@contextmanager
def connect_database() -> Generator[sqlite3.Connection, None, None]:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_database() -> None:
    with connect_database() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS heat_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                category TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


app = FastAPI(
    title="CoolRoute",
    description="Пешеходные и велосипедные маршруты с учётом жары и городских зелёных зон.",
    version="1.0.0",
    lifespan=lifespan,
)
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


class HeatReport(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    category: str = Field(pattern="^(hot|no_shade|no_water)$")
    note: str = Field(default="", max_length=240)


def parse_coordinate(value: str, name: str) -> tuple[float, float]:
    try:
        longitude, latitude = (float(part) for part in value.split(",", maxsplit=1))
    except (ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Координаты {name} должны иметь формат долгота,широта.",
        ) from exc
    if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
        raise HTTPException(status_code=422, detail=f"Координаты {name} вне допустимого диапазона.")
    return longitude, latitude


def route_environment(geometry: list[list[float]]) -> dict[str, int]:
    if not geometry:
        raise HTTPException(status_code=502, detail="Маршрутизатор не вернул геометрию маршрута.")
    sample_count = min(8, len(geometry))
    sample_indexes = (
        [0]
        if sample_count == 1
        else [round(index * (len(geometry) - 1) / (sample_count - 1)) for index in range(sample_count)]
    )
    samples = [geometry[index] for index in sample_indexes]
    clauses = []
    for longitude, latitude in samples:
        clauses.extend(
            [
                f'nwr(around:100,{latitude},{longitude})["leisure"="park"];',
                f'nwr(around:100,{latitude},{longitude})["landuse"~"forest|grass|meadow"];',
                f'node(around:45,{latitude},{longitude})["natural"="tree"];',
                f'nwr(around:100,{latitude},{longitude})["amenity"~"fountain|drinking_water"];',
            ]
        )
    query = "[out:json][timeout:10];(" + "".join(clauses) + ");out center 150;"
    payload = fetch_json("https://overpass-api.de/api/interpreter?" + urlencode({"data": query}), timeout=14)
    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
        raise HTTPException(status_code=502, detail="Сервис данных OpenStreetMap вернул некорректный ответ.")

    green_objects: set[tuple[str, int]] = set()
    water_objects: set[tuple[str, int]] = set()
    for element in payload["elements"]:
        if not isinstance(element, dict) or not isinstance(element.get("tags"), dict):
            continue
        identity = (str(element.get("type", "")), int(element.get("id", 0)))
        tags = element["tags"]
        if tags.get("leisure") == "park" or tags.get("landuse") in {"forest", "grass", "meadow"} or tags.get("natural") == "tree":
            green_objects.add(identity)
        if tags.get("amenity") in {"fountain", "drinking_water"}:
            water_objects.add(identity)
    return {"green_points": len(green_objects), "water_points": len(water_objects)}


def route_comfort(
    route: dict[str, object],
    temperature: float | None,
    green_points: int | None,
    water_points: int | None,
) -> int:
    distance_km = float(route["distance"]) / 1000
    duration_minutes = float(route["duration"]) / 60
    distance_score = max(0, 100 - round(distance_km * 4))
    time_score = max(0, 100 - round(duration_minutes * 1.2))
    heat_score = max(0, 100 - round((temperature - 24) * 4)) if temperature is not None else 75
    if green_points is None or water_points is None:
        score = distance_score * 0.5 + time_score * 0.4 + heat_score * 0.1
    else:
        green_score = min(100, green_points * 12)
        water_score = min(100, water_points * 25)
        score = (
            distance_score * 0.35
            + time_score * 0.25
            + green_score * 0.25
            + water_score * 0.1
            + heat_score * 0.05
        )
    return max(0, min(100, round(score)))


def build_routing_url(
    start_lon: float,
    start_lat: float,
    end_lon: float,
    end_lat: float,
    mode: Literal["foot", "bike"],
) -> str:
    coordinates = f"{start_lon},{start_lat};{end_lon},{end_lat}"
    options = urlencode(
        {
            "alternatives": "3",
            "overview": "full",
            "geometries": "geojson",
            "steps": "false",
        }
    )
    return f"https://routing.openstreetmap.de/routed-{mode}/route/v1/driving/{coordinates}?{options}"


def build_nominatim_url(
    query: str,
    *,
    limit: int,
    language: str | None,
    featuretype: str | None = None,
    namedetails: bool = False,
) -> str:
    parameters: dict[str, str] = {
        "q": query,
        "format": "jsonv2",
        "limit": str(limit),
        "addressdetails": "1",
    }
    if language:
        if not LANGUAGE_TAGS.fullmatch(language):
            raise HTTPException(status_code=422, detail="Некорректный язык поиска.")
        parameters["accept-language"] = language
    if featuretype:
        parameters["featuretype"] = featuretype
    if namedetails:
        parameters["namedetails"] = "1"
    return "https://nominatim.openstreetmap.org/search?" + urlencode(parameters)


def normalize_search_text(value: str) -> str:
    return "".join(
        character
        for character in unicodedata.normalize("NFKC", value).casefold()
        if character.isalnum()
    )


@app.get("/", include_in_schema=False)
def home() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/api/geocode")
def geocode(
    q: Annotated[str, Query(min_length=2, max_length=120)],
    language: Annotated[str | None, Query(max_length=100)] = None,
) -> list[dict[str, str]]:
    url = build_nominatim_url(q, limit=5, language=language)
    results = fetch_json(url)
    if not isinstance(results, list):
        raise HTTPException(status_code=502, detail="Не удалось обработать ответ поиска адреса.")
    return [
        {
            "name": item.get("display_name", "Неизвестное место"),
            "latitude": item["lat"],
            "longitude": item["lon"],
        }
        for item in results
        if isinstance(item, dict) and "lat" in item and "lon" in item
    ]


@app.get("/api/cities")
def cities(
    q: Annotated[str, Query(min_length=2, max_length=120)],
    language: Annotated[str | None, Query(max_length=100)] = None,
) -> list[dict[str, str]]:
    url = build_nominatim_url(
        q,
        limit=10,
        featuretype="city",
        language=language,
        namedetails=True,
    )
    results = fetch_json(url)
    if not isinstance(results, list):
        raise HTTPException(status_code=502, detail="Не удалось обработать ответ поиска города.")

    supported_types = {"city", "town", "village", "municipality"}
    found = []
    seen: set[tuple[float, float]] = set()
    normalized_query = normalize_search_text(q)
    for item in results:
        if (
            not isinstance(item, dict)
            or item.get("category") != "place"
            or item.get("type") not in supported_types
            or "lat" not in item
            or "lon" not in item
        ):
            continue
        try:
            latitude = float(item["lat"])
            longitude = float(item["lon"])
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(latitude) and math.isfinite(longitude)):
            continue
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            continue
        location = (latitude, longitude)
        if location in seen:
            continue
        seen.add(location)
        name = item.get("name") or item.get("display_name", "Город")
        display_name = item.get("display_name", name)
        candidates = [name, display_name.split(",", maxsplit=1)[0]]
        name_details = item.get("namedetails")
        if isinstance(name_details, dict):
            candidates.extend(
                alias for alias in name_details.values()
                if isinstance(alias, str)
            )
        exact_match = any(
            normalized_query == normalize_search_text(candidate)
            for candidate in candidates
            if isinstance(candidate, str)
        )
        found.append(
            {
                "name": name,
                "display_name": display_name,
                "latitude": str(latitude),
                "longitude": str(longitude),
                "match_type": "exact" if exact_match else "similar",
            }
        )
    found.sort(key=lambda city: city["match_type"] != "exact")
    return found


@app.get("/api/weather")
def weather(
    latitude: Annotated[float, Query(ge=-90, le=90)],
    longitude: Annotated[float, Query(ge=-180, le=180)],
) -> dict[str, object]:
    url = "https://api.open-meteo.com/v1/forecast?" + urlencode(
        {
            "latitude": latitude,
            "longitude": longitude,
            "current": "temperature_2m,apparent_temperature",
            "timezone": "auto",
        }
    )
    payload = fetch_json(url)
    if not isinstance(payload, dict) or not isinstance(payload.get("current"), dict):
        raise HTTPException(status_code=502, detail="Погодный сервис вернул некорректный ответ.")
    current = payload["current"]
    return {
        "temperature": current.get("temperature_2m"),
        "apparent_temperature": current.get("apparent_temperature"),
        "time": current.get("time"),
    }


@app.get("/api/routes")
def routes(
    start: Annotated[str, Query()],
    end: Annotated[str, Query()],
    mode: Literal["foot", "bike"] = Query(default="foot"),
) -> dict[str, object]:
    start_lon, start_lat = parse_coordinate(start, "начала")
    end_lon, end_lat = parse_coordinate(end, "конца")
    url = build_routing_url(start_lon, start_lat, end_lon, end_lat, mode)
    payload = fetch_json(url, timeout=20)
    if not isinstance(payload, dict) or payload.get("code") != "Ok":
        raise HTTPException(
            status_code=422,
            detail="Не удалось построить пешеходный маршрут. Проверьте точки и попробуйте снова.",
        )
    raw_routes = payload.get("routes")
    if not isinstance(raw_routes, list) or not raw_routes:
        raise HTTPException(status_code=422, detail="Для выбранных точек маршрут не найден.")

    temperature: float | None = None
    weather_warning = None
    try:
        conditions = weather(latitude=start_lat, longitude=start_lon)
        raw_temperature = conditions.get("temperature")
        temperature = float(raw_temperature) if raw_temperature is not None else None
    except HTTPException as exc:
        weather_warning = exc.detail

    prepared = []
    environment_warning = None
    for index, route in enumerate(raw_routes):
        if not isinstance(route, dict):
            raise HTTPException(status_code=502, detail="Маршрутизатор вернул некорректный вариант маршрута.")
        route_geometry = route.get("geometry")
        geometry = route_geometry.get("coordinates") if isinstance(route_geometry, dict) else None
        distance = route.get("distance")
        duration = route.get("duration")
        if (
            not isinstance(geometry, list)
            or not geometry
            or any(
                not isinstance(point, list)
                or len(point) < 2
                or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in point[:2])
                for point in geometry
            )
            or not isinstance(distance, (int, float))
            or not math.isfinite(distance)
            or distance < 0
            or not isinstance(duration, (int, float))
            or not math.isfinite(duration)
            or duration < 0
        ):
            raise HTTPException(status_code=502, detail="Маршрутизатор вернул некорректные данные маршрута.")
        green_points = None
        water_points = None
        try:
            environment = route_environment(geometry)
            green_points = environment["green_points"]
            water_points = environment["water_points"]
        except HTTPException as exc:
            environment_warning = exc.detail
        prepared.append(
            {
                "id": index,
                "distance": round(distance),
                "duration": round(duration),
                "comfort": route_comfort(route, temperature, green_points, water_points),
                "green_points": green_points,
                "water_points": water_points,
                "geometry": geometry,
                "temperature": temperature,
            }
        )
    if not prepared:
        raise HTTPException(status_code=502, detail="Маршрутизатор вернул некорректные данные.")
    ordinary = prepared[0]
    shortest = min(prepared, key=lambda route: route["distance"])
    cool = max(prepared, key=lambda route: route["comfort"])
    return {
        "routes": prepared,
        "mode": mode,
        "ordinary_route_id": ordinary["id"],
        "short_route_id": shortest["id"],
        "normal_route_id": shortest["id"],
        "cool_route_id": cool["id"],
        "temperature": temperature,
        "temperature_source": "Open-Meteo" if temperature is not None else None,
        "weather_warning": weather_warning,
        "environment_warning": environment_warning,
    }


@app.get("/api/places")
def places(
    latitude: Annotated[float, Query(ge=-90, le=90)],
    longitude: Annotated[float, Query(ge=-180, le=180)],
) -> list[dict[str, object]]:
    query = (
        f'[out:json][timeout:10];('
        f'nwr(around:5000,{latitude},{longitude})["leisure"~"park|garden"];'
        f'nwr(around:5000,{latitude},{longitude})["landuse"~"forest|grass|meadow"];'
        f'node(around:5000,{latitude},{longitude})["natural"="tree"];'
        f'nwr(around:5000,{latitude},{longitude})["amenity"~"fountain|drinking_water"];'
        ");out center 120;"
    )
    payload = fetch_json("https://overpass-api.de/api/interpreter?" + urlencode({"data": query}), timeout=14)
    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
        raise HTTPException(status_code=502, detail="Сервис данных OpenStreetMap вернул некорректный ответ.")

    items = []
    seen: set[tuple[str, int]] = set()
    for element in payload["elements"]:
        if not isinstance(element, dict) or not isinstance(element.get("tags"), dict):
            continue
        identity = (str(element.get("type", "")), int(element.get("id", 0)))
        if identity in seen:
            continue
        seen.add(identity)
        tags = element["tags"]
        location = element.get("center", element)
        if not isinstance(location, dict) or "lat" not in location or "lon" not in location:
            continue
        is_water = tags.get("amenity") in {"fountain", "drinking_water"}
        items.append(
            {
                "latitude": location["lat"],
                "longitude": location["lon"],
                "type": "water" if is_water else "green",
                "name": tags.get("name") or ("Фонтан или питьевая вода" if is_water else "Зелёная зона"),
            }
        )
    return items


def report_bounds(
    latitude: float | None,
    longitude: float | None,
    radius_km: float,
) -> tuple[float, float, float, float] | None:
    if latitude is None and longitude is None:
        return None
    if latitude is None or longitude is None:
        raise HTTPException(status_code=422, detail="Для фильтра по городу передайте широту и долготу.")
    latitude_delta = radius_km / 111.32
    longitude_delta = min(
        180,
        radius_km / max(111.32 * abs(math.cos(math.radians(latitude))), 0.01),
    )
    return (
        max(-90, latitude - latitude_delta),
        min(90, latitude + latitude_delta),
        max(-180, longitude - longitude_delta),
        min(180, longitude + longitude_delta),
    )


@app.get("/api/reports")
def list_reports(
    latitude: Annotated[float | None, Query(ge=-90, le=90)] = None,
    longitude: Annotated[float | None, Query(ge=-180, le=180)] = None,
    radius_km: Annotated[float, Query(ge=1, le=50)] = 25,
) -> list[dict[str, object]]:
    bounds = report_bounds(latitude, longitude, radius_km)
    with connect_database() as connection:
        query = """
            SELECT id, latitude, longitude, category, note, created_at
            FROM heat_reports
        """
        parameters: tuple[float, ...] = ()
        if bounds is not None:
            query += " WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?"
            parameters = bounds
        query += " ORDER BY id DESC LIMIT 200"
        rows = connection.execute(query, parameters).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/reports", status_code=201)
def create_report(report: HeatReport) -> dict[str, object]:
    with connect_database() as connection:
        cursor = connection.execute(
            """
            INSERT INTO heat_reports (latitude, longitude, category, note)
            VALUES (?, ?, ?, ?)
            """,
            (report.latitude, report.longitude, report.category, report.note.strip()),
        )
        saved = connection.execute(
            """
            SELECT id, latitude, longitude, category, note, created_at
            FROM heat_reports WHERE id = ?
            """,
            (cursor.lastrowid,),
        ).fetchone()
    if saved is None:
        raise HTTPException(status_code=500, detail="Не удалось сохранить сообщение.")
    return dict(saved)


@app.get("/api/city-insights")
def city_insights(
    latitude: Annotated[float | None, Query(ge=-90, le=90)] = None,
    longitude: Annotated[float | None, Query(ge=-180, le=180)] = None,
    radius_km: Annotated[float, Query(ge=1, le=50)] = 25,
) -> dict[str, object]:
    bounds = report_bounds(latitude, longitude, radius_km)
    with connect_database() as connection:
        where = ""
        parameters: tuple[float, ...] = ()
        if bounds is not None:
            where = " WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?"
            parameters = bounds
        total = connection.execute(f"SELECT COUNT(*) FROM heat_reports{where}", parameters).fetchone()[0]
        hotspots = connection.execute(
            f"""
            SELECT ROUND(latitude, 3) AS latitude,
                ROUND(longitude, 3) AS longitude,
                COUNT(*) AS reports,
                SUM(CASE WHEN category = 'hot' THEN 1 ELSE 0 END) AS hot_reports
            FROM heat_reports
            {where}
            GROUP BY ROUND(latitude, 3), ROUND(longitude, 3)
            ORDER BY reports DESC, hot_reports DESC
            LIMIT 5
            """,
            parameters,
        ).fetchall()
    return {"total_reports": total, "hotspots": [dict(row) for row in hotspots]}
