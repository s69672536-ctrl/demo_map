import enum
from datetime import date as date_type

from sqlalchemy import (
    Column, Integer, String, Float, ForeignKey, Date, DateTime,
    Enum as SAEnum, Boolean, func
)
from sqlalchemy.orm import relationship

from .database import Base


class CollectionStatus(str, enum.Enum):
    pending = "pending"
    collected = "collected"
    skipped = "skipped"
    absent = "absent"


class Route(Base):
    """A fixed, named route (e.g. one per neighbourhood)."""
    __tablename__ = "routes"

    id = Column(Integer, primary_key=True, index=True)
    route_name = Column(String, nullable=False)

    start_lat = Column(Float, nullable=False)
    start_lng = Column(Float, nullable=False)
    end_lat = Column(Float, nullable=False)
    end_lng = Column(Float, nullable=False)

    # The collector who owns this route every day by default (e.g. "Ramesh
    # always does Nungambakkam"). Set once via /routes/{id}/default-collector.
    # A per-date RouteAssignment always overrides this for that one day
    # (e.g. a substitute covering for an absent collector), but if no
    # assignment exists for today, this is who gets it automatically.
    default_collector_id = Column(Integer, ForeignKey("collectors.id"), nullable=True)

    created_at = Column(DateTime, server_default=func.now())

    customers = relationship(
        "Customer", back_populates="route",
        order_by="Customer.sequence", cascade="all, delete-orphan"
    )
    assignments = relationship("RouteAssignment", back_populates="route")


class Customer(Base):
    """A stop on a route. `sequence` is what fixes the visiting order.

    Sequence uses a float with gaps (10, 20, 30 ...) so a new customer can be
    inserted between two existing ones without renumbering the whole route.
    """
    __tablename__ = "customers"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    phone = Column(String, nullable=True)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)

    route_id = Column(Integer, ForeignKey("routes.id"), nullable=False)
    sequence = Column(Float, nullable=False)

    default_amount = Column(Float, nullable=True)
    active = Column(Boolean, default=True)

    # Path (served via /static) to a photo of the house/shop front, so the
    # collector can recognize the place before they arrive. Set separately
    # via POST /customers/{id}/house-image after the customer is created.
    house_image_path = Column(String, nullable=True)

    created_at = Column(DateTime, server_default=func.now())

    route = relationship("Route", back_populates="customers")
    collections = relationship("DailyCollection", back_populates="customer")


class Collector(Base):
    """A field agent who executes routes. Auth is intentionally minimal here
    (see routers/collectors.py) - swap in real auth (JWT/OAuth) for production.
    """
    __tablename__ = "collectors"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    phone = Column(String, unique=True, nullable=False)
    active = Column(Boolean, default=True)

    created_at = Column(DateTime, server_default=func.now())

    assignments = relationship("RouteAssignment", back_populates="collector")
    collections = relationship("DailyCollection", back_populates="collector")
    locations = relationship("CollectorLocation", back_populates="collector")


class RouteAssignment(Base):
    """Which collector is running which route on a given date.

    This is what lets a substitute collector pick up an absent agent's exact
    route with zero reconfiguration - just assign them for that date.
    """
    __tablename__ = "route_assignments"

    id = Column(Integer, primary_key=True, index=True)
    route_id = Column(Integer, ForeignKey("routes.id"), nullable=False)
    collector_id = Column(Integer, ForeignKey("collectors.id"), nullable=False)
    date = Column(Date, nullable=False, default=date_type.today)

    route = relationship("Route", back_populates="assignments")
    collector = relationship("Collector", back_populates="assignments")


class DailyCollection(Base):
    """Per-day execution state for a customer stop. The route/sequence never
    changes here - only status, so history and reporting stay clean.
    """
    __tablename__ = "collections"

    id = Column(Integer, primary_key=True, index=True)
    customer_id = Column(Integer, ForeignKey("customers.id"), nullable=False)
    collector_id = Column(Integer, ForeignKey("collectors.id"), nullable=True)
    date = Column(Date, nullable=False, default=date_type.today)

    status = Column(SAEnum(CollectionStatus), default=CollectionStatus.pending, nullable=False)
    amount_collected = Column(Float, nullable=True)
    collected_at = Column(DateTime, nullable=True)
    notes = Column(String, nullable=True)

    customer = relationship("Customer", back_populates="collections")
    collector = relationship("Collector", back_populates="collections")


class CollectorLocation(Base):
    """Latest + historical GPS pings, written every few seconds by the app."""
    __tablename__ = "collector_locations"

    id = Column(Integer, primary_key=True, index=True)
    collector_id = Column(Integer, ForeignKey("collectors.id"), nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    recorded_at = Column(DateTime, server_default=func.now())

    collector = relationship("Collector", back_populates="locations")
