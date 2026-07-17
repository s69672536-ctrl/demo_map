"""
Thin wrapper around OSRM's Trip service, used to compute the best visiting
order for a route's customers once, up front (see README for the workflow).

Docs: http://project-osrm.org/docs/master/api/#trip-service

We call it with the office as a fixed source and fixed destination
(source=first&destination=last&roundtrip=false) and let OSRM reorder
everything in between.
"""
import os
import httpx

OSRM_BASE_URL = os.getenv("OSRM_BASE_URL", "https://router.project-osrm.org")


class OSRMError(Exception):
    pass


def get_route_geometry(
    ordered_points: list[tuple[float, float]],
    profile: str = "driving",
) -> list[list[float]]:
    """
    Fetches the actual road-following path through an already-ordered list
    of stops (start, customers in sequence, end - all as (lat, lng)).
    Used to draw the real route line on the admin map, not just straight
    lines between pins.

    Returns a list of [lat, lng] pairs tracing the road path.
    """
    if len(ordered_points) < 2:
        return []

    coords = ";".join(f"{lng},{lat}" for lat, lng in ordered_points)
    url = f"{OSRM_BASE_URL}/route/v1/{profile}/{coords}"
    params = {"overview": "full", "geometries": "geojson"}

    try:
        resp = httpx.get(url, params=params, timeout=20.0)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise OSRMError(f"Failed to reach OSRM: {exc}") from exc

    if data.get("code") != "Ok":
        raise OSRMError(f"OSRM returned an error: {data.get('message', data.get('code'))}")

    # GeoJSON gives [lng, lat] pairs - flip to [lat, lng] for Leaflet.
    coordinates = data["routes"][0]["geometry"]["coordinates"]
    return [[lat, lng] for lng, lat in coordinates]


def get_leg_route(start: tuple[float, float], end: tuple[float, float], profile: str = "driving") -> dict:
    """
    Road-following path + distance/duration for a single two-point leg -
    used for one-destination-at-a-time navigation (current stop only),
    as opposed to get_route_geometry() which traces the whole multi-stop route.
    Returns {"coordinates": [[lat,lng],...], "distance_km": float, "duration_min": float}.
    """
    coords = f"{start[1]},{start[0]};{end[1]},{end[0]}"
    url = f"{OSRM_BASE_URL}/route/v1/{profile}/{coords}"
    params = {"overview": "full", "geometries": "geojson"}

    try:
        resp = httpx.get(url, params=params, timeout=15.0)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise OSRMError(f"Failed to reach OSRM: {exc}") from exc

    if data.get("code") != "Ok":
        raise OSRMError(f"OSRM returned an error: {data.get('message', data.get('code'))}")

    route = data["routes"][0]
    coordinates = [[lat, lng] for lng, lat in route["geometry"]["coordinates"]]
    return {
        "coordinates": coordinates,
        "distance_km": round(route["distance"] / 1000, 2),
        "duration_min": round(route["duration"] / 60, 1),
    }


def optimize_sequence(
    start: tuple[float, float],
    end: tuple[float, float],
    customers: list[dict],
    profile: str = "driving",
) -> list[dict]:
    """
    start / end: (lat, lng)
    customers: list of {"id": int, "latitude": float, "longitude": float}

    Returns the same customer dicts, reordered into the optimized visiting
    sequence (start and end are not included in the returned list).
    """
    if not customers:
        return []

    # OSRM wants lng,lat order.
    coords = [f"{start[1]},{start[0]}"]
    coords += [f"{c['longitude']},{c['latitude']}" for c in customers]
    coords.append(f"{end[1]},{end[0]}")
    coord_str = ";".join(coords)

    url = f"{OSRM_BASE_URL}/trip/v1/{profile}/{coord_str}"
    params = {
        "source": "first",
        "destination": "last",
        "roundtrip": "false",
        "overview": "false",
    }

    try:
        resp = httpx.get(url, params=params, timeout=20.0)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller as OSRMError
        raise OSRMError(f"Failed to reach OSRM: {exc}") from exc

    if data.get("code") != "Ok":
        raise OSRMError(f"OSRM returned an error: {data.get('message', data.get('code'))}")

    waypoints = data["waypoints"]
    # waypoints[0] is the start, waypoints[-1] is the end. Everything in
    # between maps 1:1 (by input order) to `customers`, but each carries a
    # `waypoint_index` telling us its position in the optimized trip.
    customer_waypoints = waypoints[1:-1]

    ordered = sorted(
        zip(customer_waypoints, customers),
        key=lambda pair: pair[0]["waypoint_index"],
    )
    return [customer for _wp, customer in ordered]
