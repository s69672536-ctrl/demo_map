"""Small geo helpers shared by the tracking endpoints."""
import math


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Straight-line distance between two lat/lng points, in kilometers.

    This is distance 'as the crow flies' between consecutive GPS pings, not
    actual road distance - fine for a rough "km travelled today" figure
    since pings are frequent enough that the straight-line segments closely
    track the road path. For turn-by-turn road distance you'd sum OSRM route
    legs instead, which costs an API call per pair.
    """
    R = 6371.0  # Earth radius in km
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)

    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))
