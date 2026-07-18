from datetime import date as date_type, datetime, time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..geo import haversine_km

router = APIRouter(prefix="/tracking", tags=["tracking"])


@router.post("/{collector_id}/ping")
def ping_location(collector_id: int, location: schemas.LocationPing, db: Session = Depends(get_db)):
    """Collector app calls this every ~10-15 seconds while a route is active."""
    collector = db.get(models.Collector, collector_id)
    if not collector:
        raise HTTPException(404, "Collector not found")

    db.add(models.CollectorLocation(
        collector_id=collector_id,
        latitude=location.latitude,
        longitude=location.longitude,
    ))
    db.commit()
    return {"ok": True}


@router.get("/live", response_model=list[schemas.LocationOut])
def live_locations(db: Session = Depends(get_db)):
    """Latest known position for every collector. Prefer /tracking/summary
    for the admin dashboard - this is kept for simple map-only use cases."""
    collectors = db.query(models.Collector).filter(models.Collector.active == True).all()
    latest = []
    for c in collectors:
        loc = (
            db.query(models.CollectorLocation)
            .filter(models.CollectorLocation.collector_id == c.id)
            .order_by(models.CollectorLocation.recorded_at.desc())
            .first()
        )
        if loc:
            latest.append(loc)
    return latest


def _distance_km_for_day(db: Session, collector_id: int, target_date: date_type) -> float:
    """Sums straight-line distance between consecutive GPS pings for one
    collector on one day. See geo.haversine_km for the accuracy caveat."""
    start = datetime.combine(target_date, time.min)
    end = datetime.combine(target_date, time.max)

    pings = (
        db.query(models.CollectorLocation)
        .filter(
            models.CollectorLocation.collector_id == collector_id,
            models.CollectorLocation.recorded_at >= start,
            models.CollectorLocation.recorded_at <= end,
        )
        .order_by(models.CollectorLocation.recorded_at.asc())
        .all()
    )

    total = 0.0
    for prev, curr in zip(pings, pings[1:]):
        total += haversine_km(prev.latitude, prev.longitude, curr.latitude, curr.longitude)
    return round(total, 2)


@router.get("/{collector_id}/distance")
def get_distance_travelled(
    collector_id: int,
    for_date: Optional[date_type] = Query(None, alias="date"),
    db: Session = Depends(get_db),
):
    """Total km travelled by this collector on the given day (default: today),
    computed from their GPS ping history."""
    collector = db.get(models.Collector, collector_id)
    if not collector:
        raise HTTPException(404, "Collector not found")

    target_date = for_date or date_type.today()
    km = _distance_km_for_day(db, collector_id, target_date)
    return {"collector_id": collector_id, "date": str(target_date), "distance_km": km}


@router.get("/summary", response_model=list[schemas.CollectorTrackingSummary])
def tracking_summary(
    for_date: Optional[date_type] = Query(None, alias="date"),
    db: Session = Depends(get_db),
):
    """
    One row per active collector: their latest known position and total km
    travelled today. This is what the admin dashboard's live tracking panel
    polls every few seconds.
    """
    target_date = for_date or date_type.today()
    collectors = db.query(models.Collector).filter(models.Collector.active == True).all()

    summary = []
    for c in collectors:
        latest = (
            db.query(models.CollectorLocation)
            .filter(models.CollectorLocation.collector_id == c.id)
            .order_by(models.CollectorLocation.recorded_at.desc())
            .first()
        )

        # Whichever route they're actually on today (per-date assignment,
        # falling back to their permanent default route) - just for display.
        assignment = (
            db.query(models.RouteAssignment)
            .filter(
                models.RouteAssignment.collector_id == c.id,
                models.RouteAssignment.date == target_date,
            )
            .first()
        )
        if assignment:
            route = db.get(models.Route, assignment.route_id)
        else:
            route = (
                db.query(models.Route)
                .filter(models.Route.default_collector_id == c.id)
                .first()
            )

        summary.append(schemas.CollectorTrackingSummary(
            collector_id=c.id,
            collector_name=c.name,
            latitude=latest.latitude if latest else None,
            longitude=latest.longitude if latest else None,
            last_updated=latest.recorded_at if latest else None,
            distance_km_today=_distance_km_for_day(db, c.id, target_date),
            route_name=route.route_name if route else None,
        ))

    return summary