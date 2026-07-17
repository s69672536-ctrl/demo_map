import re
from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db

router = APIRouter(prefix="/collectors", tags=["collectors"])


def normalize_phone(phone: str) -> str:
    """
    Reduce a phone number to just its digits, and drop a leading Indian
    country code (91) or trunk-prefix zero, so that "9342280907",
    "+91 93422 80907", "091342280907", and "934-228-0907" all normalize to
    the same value. This is what makes login/lookup format-tolerant instead
    of requiring an exact byte-for-byte string match.
    """
    if not phone:
        return ""
    digits = re.sub(r"\D", "", phone)
    if len(digits) > 10 and digits.startswith("0"):
        digits = digits.lstrip("0")
    if len(digits) > 10 and digits.startswith("91"):
        digits = digits[-10:]
    return digits


@router.post("", response_model=schemas.CollectorOut)
def create_collector(collector: schemas.CollectorCreate, db: Session = Depends(get_db)):
    data = collector.model_dump()
    normalized = normalize_phone(data["phone"])
    if normalized:
        existing = db.query(models.Collector).filter(models.Collector.active.is_(True)).all()
        if any(normalize_phone(c.phone) == normalized for c in existing):
            raise HTTPException(400, "Another collector already uses that phone number")
        data["phone"] = normalized
    db_collector = models.Collector(**data)
    db.add(db_collector)
    db.commit()
    db.refresh(db_collector)
    return db_collector


@router.get("", response_model=list[schemas.CollectorOut])
def list_collectors(db: Session = Depends(get_db)):
    return db.query(models.Collector).filter(models.Collector.active.is_(True)).all()


@router.post("/login", response_model=schemas.CollectorOut)
def login(phone: str, db: Session = Depends(get_db)):
    """
    NOTE: this is a placeholder for demo purposes only - it identifies a
    collector by phone number with no password/OTP check. Swap this for real
    auth (OTP + JWT, or your existing auth system) before going to production.

    Matching is done on normalized digits (see normalize_phone) rather than
    an exact string match, so "+91 93422 80907", "934-228-0907", and
    "9342280907" all resolve to the same collector regardless of how the
    number was originally typed in on either side (admin dashboard vs the
    collector's own phone).
    """
    target = normalize_phone(phone)
    if not target:
        raise HTTPException(400, "Enter a phone number")

    collectors = db.query(models.Collector).filter(models.Collector.active.is_(True)).all()
    for c in collectors:
        if normalize_phone(c.phone) == target:
            return c

    raise HTTPException(404, "No active collector with that phone number")


@router.post("/assignments")
def assign_route(assignment: schemas.RouteAssignmentCreate, db: Session = Depends(get_db)):
    """
    Assigns a collector to a route for a given date (defaults to today).
    This is the mechanism that lets a substitute collector take over an
    absent agent's exact route with zero reconfiguration - just create a
    new assignment for the same route/date pointing at a different collector.
    """
    route = db.query(models.Route).get(assignment.route_id)
    collector = db.query(models.Collector).get(assignment.collector_id)
    if not route or not collector:
        raise HTTPException(404, "Route or collector not found")

    assign_date = assignment.date or date_type.today()

    db_assignment = models.RouteAssignment(
        route_id=assignment.route_id,
        collector_id=assignment.collector_id,
        date=assign_date,
    )
    db.add(db_assignment)
    db.commit()
    return {"ok": True, "route_id": route.id, "collector_id": collector.id, "date": str(assign_date)}
@router.put("/{collector_id}", response_model=schemas.CollectorOut)
def update_collector(collector_id: int, update: schemas.CollectorUpdate, db: Session = Depends(get_db)):
    collector = db.query(models.Collector).get(collector_id)
    if not collector:
        raise HTTPException(404, "Collector not found")

    data = update.model_dump(exclude_unset=True)

    if "phone" in data and data["phone"]:
        normalized = normalize_phone(data["phone"])
        existing = db.query(models.Collector).filter(models.Collector.id != collector_id).all()
        if any(normalize_phone(c.phone) == normalized for c in existing):
            raise HTTPException(400, "Another collector already uses that phone number")
        data["phone"] = normalized

    for field, value in data.items():
        setattr(collector, field, value)

    db.commit()
    db.refresh(collector)
    return collector


@router.delete("/{collector_id}")
def deactivate_collector(collector_id: int, db: Session = Depends(get_db)):
    """Soft-delete: keeps their collection history intact, just stops them
    from showing up in the admin's collector list or being able to log in.
    Mirrors deactivate_customer() in routers/customers.py."""
    collector = db.query(models.Collector).get(collector_id)
    if not collector:
        raise HTTPException(404, "Collector not found")
    collector.active = False
    db.commit()
    return {"ok": True}