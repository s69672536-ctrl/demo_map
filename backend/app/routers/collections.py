from datetime import date as date_type, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..osrm import get_leg_route, OSRMError
from ..geo import haversine_km

router = APIRouter(prefix="/collections", tags=["collections"])


@router.get("/today", response_model=schemas.TodayRouteOut)
def get_today_route(
    collector_id: int,
    for_date: Optional[date_type] = Query(None, alias="date"),
    db: Session = Depends(get_db),
):
    """
    The single endpoint the Flutter app calls each morning. It resolves
    whichever route this collector is assigned to today, returns the fixed
    customer sequence, and creates today's pending collection records the
    first time it's called so status can be tracked/updated afterwards.
    """
    target_date = for_date or date_type.today()

    assignment = (
        db.query(models.RouteAssignment)
        .filter(
            models.RouteAssignment.collector_id == collector_id,
            models.RouteAssignment.date == target_date,
        )
        .first()
    )

    if assignment:
        route = db.query(models.Route).get(assignment.route_id)
    else:
        # No one-off assignment for today - fall back to whichever route
        # permanently belongs to this collector (see /routes/{id}/default-collector).
        route = (
            db.query(models.Route)
            .filter(models.Route.default_collector_id == collector_id)
            .first()
        )
        if not route:
            raise HTTPException(
                404,
                "No route assigned to this collector for that date, and no default route set for them.",
            )
    customers = (
        db.query(models.Customer)
        .filter(models.Customer.route_id == route.id, models.Customer.active.is_(True))
        .order_by(models.Customer.sequence)
        .all()
    )

    stops = []
    for customer in customers:
        collection = (
            db.query(models.DailyCollection)
            .filter(
                models.DailyCollection.customer_id == customer.id,
                models.DailyCollection.date == target_date,
            )
            .first()
        )
        if not collection:
            collection = models.DailyCollection(
                customer_id=customer.id,
                collector_id=collector_id,
                date=target_date,
                status=models.CollectionStatus.pending,
            )
            db.add(collection)
            db.flush()

        stops.append(
            schemas.TodayStop(
                customer_id=customer.id,
                name=customer.name,
                phone=customer.phone,
                latitude=customer.latitude,
                longitude=customer.longitude,
                sequence=customer.sequence,
                default_amount=customer.default_amount,
                status=collection.status,
                amount_collected=collection.amount_collected,
                house_image_path=customer.house_image_path,
            )
        )

    db.commit()

    return schemas.TodayRouteOut(
        route_id=route.id,
        route_name=route.route_name,
        date=target_date,
        start_lat=route.start_lat,
        start_lng=route.start_lng,
        end_lat=route.end_lat,
        end_lng=route.end_lng,
        stops=stops,
    )


@router.get("/current-leg", response_model=schemas.CurrentLegOut)
def get_current_leg(
    collector_id: int,
    for_date: Optional[date_type] = Query(None, alias="date"),
    db: Session = Depends(get_db),
):
    """
    The ONE active navigation segment for this collector right now - from
    wherever they last finished to the next pending stop. Deliberately never
    returns the whole route: the collector's map should only ever show one
    destination at a time (see house-image/current-leg feature notes in the
    README). Call this again after marking a stop done to get the next leg.
    """
    today_route = get_today_route(collector_id, for_date, db)  # reuses the resolution logic above
    stops = today_route.stops

    next_index = next((i for i, s in enumerate(stops) if s.status == models.CollectionStatus.pending), None)

    if next_index is None:
        # Every stop is done - route complete. Summarize instead of navigating.
        target_date = for_date or date_type.today()
        completed = [s for s in stops if s.status != models.CollectionStatus.pending]
        amount_collected = sum(s.amount_collected or 0 for s in completed)

        km = 0.0
        pings = (
            db.query(models.CollectorLocation)
            .filter(models.CollectorLocation.collector_id == collector_id)
            .order_by(models.CollectorLocation.recorded_at.asc())
            .all()
        )
        for prev, curr in zip(pings, pings[1:]):
            km += haversine_km(prev.latitude, prev.longitude, curr.latitude, curr.longitude)

        last_point = stops[-1] if stops else None
        return schemas.CurrentLegOut(
            from_point=schemas.LegPoint(
                label=last_point.name if last_point else today_route.route_name,
                latitude=last_point.latitude if last_point else today_route.end_lat,
                longitude=last_point.longitude if last_point else today_route.end_lng,
            ),
            route_completed=True,
            summary=schemas.RouteCompletedSummary(
                total_distance_km=round(km, 2),
                stops_completed=len(completed),
                stops_total=len(stops),
                amount_collected=amount_collected,
            ),
        )

    # "From" is the last completed stop, or the route's start point if
    # nothing has been collected yet today.
    if next_index == 0:
        from_label, from_lat, from_lng = "Start", today_route.start_lat, today_route.start_lng
    else:
        prev_stop = stops[next_index - 1]
        from_label, from_lat, from_lng = prev_stop.name, prev_stop.latitude, prev_stop.longitude

    to_stop = stops[next_index]

    geometry: list[list[float]] = []
    distance_km = None
    eta_minutes = None
    try:
        leg = get_leg_route((from_lat, from_lng), (to_stop.latitude, to_stop.longitude))
        geometry = leg["coordinates"]
        distance_km = leg["distance_km"]
        eta_minutes = leg["duration_min"]
    except OSRMError:
        # OSRM unreachable - fall back to a straight line + rough ETA so
        # navigation still works, just without road-following geometry.
        distance_km = round(haversine_km(from_lat, from_lng, to_stop.latitude, to_stop.longitude), 2)
        eta_minutes = round((distance_km / 25) * 60, 1)  # assumes ~25 km/h average
        geometry = [[from_lat, from_lng], [to_stop.latitude, to_stop.longitude]]

    return schemas.CurrentLegOut(
        from_point=schemas.LegPoint(label=from_label, latitude=from_lat, longitude=from_lng),
        to_customer_id=to_stop.customer_id,
        to_point=schemas.LegPoint(label=to_stop.name, latitude=to_stop.latitude, longitude=to_stop.longitude),
        to_phone=to_stop.phone,
        to_amount=to_stop.default_amount,
        to_house_image_path=to_stop.house_image_path,
        geometry=geometry,
        distance_km=distance_km,
        eta_minutes=eta_minutes,
        route_completed=False,
    )


@router.get("/today/geometry")
def get_today_route_geometry(
    collector_id: int,
    for_date: Optional[date_type] = Query(None, alias="date"),
    db: Session = Depends(get_db),
):
    """
    Same route this collector is on today, but as an ordered list of
    {lat, lng, status} for each stop (plus start/end) - used by the admin
    dashboard's Live Tracking panel to color the completed portion of the
    route differently from what's still ahead, and to know which stop is
    the "next leg" destination.
    """
    today_route = get_today_route(collector_id, for_date, db)  # reuses the logic above

    points = [{"lat": today_route.start_lat, "lng": today_route.start_lng, "status": "start"}]
    for stop in today_route.stops:
        points.append({"lat": stop.latitude, "lng": stop.longitude, "status": stop.status})
    points.append({"lat": today_route.end_lat, "lng": today_route.end_lng, "status": "end"})

    return {"route_id": today_route.route_id, "route_name": today_route.route_name, "points": points}


@router.post("/{customer_id}/mark")

def mark_collection(
    customer_id: int,
    body: schemas.MarkCollectedRequest,
    for_date: Optional[date_type] = Query(None, alias="date"),
    db: Session = Depends(get_db),
):
    """Collector taps 'Paid' / 'Skip' for a stop. Only today's status changes -
    the underlying route sequence is untouched."""
    target_date = for_date or date_type.today()

    collection = (
        db.query(models.DailyCollection)
        .filter(
            models.DailyCollection.customer_id == customer_id,
            models.DailyCollection.date == target_date,
        )
        .first()
    )
    if not collection:
        raise HTTPException(404, "No collection record for this customer/date. Call /collections/today first.")

    collection.status = body.status
    collection.amount_collected = body.amount_collected
    collection.notes = body.notes
    if body.status == models.CollectionStatus.collected:
        collection.collected_at = datetime.utcnow()

    db.commit()
    return {"ok": True, "customer_id": customer_id, "status": body.status}


@router.get("/report")
def daily_report(
    route_id: Optional[int] = None,
    for_date: Optional[date_type] = Query(None, alias="date"),
    db: Session = Depends(get_db),
):
    """Simple daily rollup: collected / skipped / pending counts and totals."""
    target_date = for_date or date_type.today()

    query = (
        db.query(models.DailyCollection)
        .join(models.Customer)
        .filter(models.DailyCollection.date == target_date)
    )
    if route_id:
        query = query.filter(models.Customer.route_id == route_id)

    records = query.all()
    summary = {"date": str(target_date), "total_stops": len(records), "collected": 0,
               "skipped": 0, "pending": 0, "absent": 0, "total_amount_collected": 0.0}
    for r in records:
        summary[r.status.value] += 1
        if r.amount_collected:
            summary["total_amount_collected"] += r.amount_collected
    return summary
