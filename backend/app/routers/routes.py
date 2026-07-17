from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..osrm import optimize_sequence, get_route_geometry as osrm_get_route_geometry, OSRMError

router = APIRouter(prefix="/routes", tags=["routes"])


@router.post("", response_model=schemas.RouteOut)
def create_route(route: schemas.RouteCreate, db: Session = Depends(get_db)):
    db_route = models.Route(**route.model_dump())
    db.add(db_route)
    db.commit()
    db.refresh(db_route)
    return db_route


@router.get("", response_model=list[schemas.RouteOut])
def list_routes(db: Session = Depends(get_db)):
    return db.query(models.Route).all()


@router.get("/{route_id}", response_model=schemas.RouteOut)
def get_route(route_id: int, db: Session = Depends(get_db)):
    route = db.query(models.Route).get(route_id)
    if not route:
        raise HTTPException(404, "Route not found")
    return route


@router.get("/{route_id}/customers", response_model=list[schemas.CustomerOut])
def list_route_customers(route_id: int, db: Session = Depends(get_db)):
    return (
        db.query(models.Customer)
        .filter(models.Customer.route_id == route_id, models.Customer.active.is_(True))
        .order_by(models.Customer.sequence)
        .all()
    )


@router.post("/{route_id}/customers", response_model=schemas.CustomerOut)
def add_customer_to_route(
    route_id: int, customer: schemas.CustomerCreate, db: Session = Depends(get_db)
):
    route = db.query(models.Route).get(route_id)
    if not route:
        raise HTTPException(404, "Route not found")

    # New customers get appended at the end of the sequence (gap of 10) so
    # they don't disturb the existing order. Re-run /optimize to fold them
    # into the best position, or drag-and-drop via /customers/reorder.
    max_seq = (
        db.query(models.Customer)
        .filter(models.Customer.route_id == route_id)
        .order_by(models.Customer.sequence.desc())
        .first()
    )
    next_seq = (max_seq.sequence + 10) if max_seq else 10

    db_customer = models.Customer(
        **customer.model_dump(), route_id=route_id, sequence=next_seq
    )
    db.add(db_customer)
    db.commit()
    db.refresh(db_customer)
    return db_customer


@router.post("/{route_id}/optimize", response_model=list[schemas.CustomerOut])
def optimize_route(route_id: int, db: Session = Depends(get_db)):
    """
    Calls OSRM once to compute the best visiting order for all active
    customers on this route, then saves that order as the fixed `sequence`.
    Run this after adding/removing customers - not on every collection day.
    """
    route = db.query(models.Route).get(route_id)
    if not route:
        raise HTTPException(404, "Route not found")

    customers = (
        db.query(models.Customer)
        .filter(models.Customer.route_id == route_id, models.Customer.active.is_(True))
        .all()
    )
    if not customers:
        raise HTTPException(400, "Route has no customers to optimize")

    customer_dicts = [
        {"id": c.id, "latitude": c.latitude, "longitude": c.longitude} for c in customers
    ]

    try:
        ordered = optimize_sequence(
            start=(route.start_lat, route.start_lng),
            end=(route.end_lat, route.end_lng),
            customers=customer_dicts,
        )
    except OSRMError as exc:
        raise HTTPException(502, str(exc)) from exc

    by_id = {c.id: c for c in customers}
    for i, item in enumerate(ordered):
        by_id[item["id"]].sequence = (i + 1) * 10

    db.commit()
    return (
        db.query(models.Customer)
        .filter(models.Customer.route_id == route_id, models.Customer.active.is_(True))
        .order_by(models.Customer.sequence)
        .all()
    )


@router.put("/{route_id}/default-collector", response_model=schemas.RouteOut)
def set_default_collector(
    route_id: int, body: schemas.SetDefaultCollector, db: Session = Depends(get_db)
):
    """
    Permanently ties this route/area to one collector (e.g. "Ramesh always
    does Nungambakkam"). From now on, that collector automatically gets this
    route every day via /collections/today - no daily re-assignment needed.
    A one-off /collectors/assignments entry for a specific date still
    overrides this (e.g. covering for an absent collector for one day).
    """
    route = db.query(models.Route).get(route_id)
    if not route:
        raise HTTPException(404, "Route not found")
    collector = db.query(models.Collector).get(body.collector_id)
    if not collector:
        raise HTTPException(404, "Collector not found")

    # A collector should only ever have ONE permanent route. Without this,
    # re-assigning a collector to a new permanent route left their old
    # route(s) still pointing at them too, and /collections/today (which
    # picks the first match) could resolve to whichever stale route came
    # first - the collector's app would then show the wrong stops entirely,
    # with no obvious sign anything was wrong on the admin side.
    other_routes = (
        db.query(models.Route)
        .filter(models.Route.default_collector_id == body.collector_id, models.Route.id != route_id)
        .all()
    )
    for r in other_routes:
        r.default_collector_id = None

    route.default_collector_id = body.collector_id
    db.commit()
    db.refresh(route)
    return route


@router.delete("/{route_id}")
def delete_route(route_id: int, db: Session = Depends(get_db)):
    """
    Deletes a route and all of its customers (cascade). Needed so duplicate
    or test routes created while building things out can actually be
    cleaned up - previously there was no way to remove a route from the
    backend at all, only from the admin dashboard's local on-screen list,
    so deleted-looking routes kept coming back after a page refresh.
    """
    route = db.query(models.Route).get(route_id)
    if not route:
        raise HTTPException(404, "Route not found")

    customer_ids = [c.id for c in route.customers]
    if customer_ids:
        db.query(models.DailyCollection).filter(
            models.DailyCollection.customer_id.in_(customer_ids)
        ).delete(synchronize_session=False)
    db.query(models.RouteAssignment).filter(
        models.RouteAssignment.route_id == route_id
    ).delete(synchronize_session=False)

    db.delete(route)  # cascades to route.customers via the relationship
    db.commit()
    return {"ok": True, "deleted_route_id": route_id}


@router.delete("/{route_id}/default-collector", response_model=schemas.RouteOut)
def clear_default_collector(route_id: int, db: Session = Depends(get_db)):
    """Removes the permanent owner - the route will need a manual daily
    assignment again until a new default is set."""
    route = db.query(models.Route).get(route_id)
    if not route:
        raise HTTPException(404, "Route not found")
    route.default_collector_id = None
    db.commit()
    db.refresh(route)
    return route


@router.get("/{route_id}/geometry")
def get_route_geometry(route_id: int, db: Session = Depends(get_db)):
    """
    Returns the actual road-following path through this route's stops in
    sequence order - what the admin dashboard draws as the black route line.
    Run /optimize first so the sequence reflects the shortest visiting order.
    """
    route = db.query(models.Route).get(route_id)
    if not route:
        raise HTTPException(404, "Route not found")

    customers = (
        db.query(models.Customer)
        .filter(models.Customer.route_id == route_id, models.Customer.active.is_(True))
        .order_by(models.Customer.sequence)
        .all()
    )
    if not customers:
        return {"route_id": route_id, "coordinates": []}

    points = [(route.start_lat, route.start_lng)]
    points += [(c.latitude, c.longitude) for c in customers]
    points.append((route.end_lat, route.end_lng))

    try:
        coordinates = osrm_get_route_geometry(points)
    except OSRMError as exc:
        raise HTTPException(502, str(exc)) from exc

    return {"route_id": route_id, "coordinates": coordinates}


@router.put("/{route_id}/customers/reorder", response_model=list[schemas.CustomerOut])
def reorder_customers(
    route_id: int, moves: list[schemas.CustomerReorder], db: Session = Depends(get_db)
):
    """Manual override for sequence numbers, e.g. after admin drag-and-drop."""
    for move in moves:
        customer = db.query(models.Customer).get(move.customer_id)
        if not customer or customer.route_id != route_id:
            raise HTTPException(400, f"Customer {move.customer_id} not on this route")
        customer.sequence = move.sequence
    db.commit()
    return (
        db.query(models.Customer)
        .filter(models.Customer.route_id == route_id, models.Customer.active.is_(True))
        .order_by(models.Customer.sequence)
        .all()
    )
