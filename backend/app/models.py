import enum
from datetime import date as date_type

from sqlalchemy import (
    Column,
    Integer,
    String,
    Float,
    ForeignKey,
    Date,
    DateTime,
    Enum as SAEnum,
    Boolean,
    func,
)
from sqlalchemy.orm import relationship

from .database import Base


class CollectionStatus(str, enum.Enum):
    pending = "pending"
    collected = "collected"
    skipped = "skipped"
    absent = "absent"


# -------------------------------------------------------
# Route
# -------------------------------------------------------
class Route(Base):
    __tablename__ = "routes"

    id = Column(Integer, primary_key=True, index=True)

    route_name = Column(String(100), nullable=False)

    start_lat = Column(Float, nullable=False)
    start_lng = Column(Float, nullable=False)
    end_lat = Column(Float, nullable=False)
    end_lng = Column(Float, nullable=False)

    default_collector_id = Column(
        Integer,
        ForeignKey("collectors.id"),
        nullable=True,
    )

    created_at = Column(DateTime, server_default=func.now())

    customers = relationship(
        "Customer",
        back_populates="route",
        order_by="Customer.sequence",
        cascade="all, delete-orphan",
    )

    assignments = relationship(
        "RouteAssignment",
        back_populates="route",
    )


# -------------------------------------------------------
# Customer
# -------------------------------------------------------
class Customer(Base):
    __tablename__ = "customers"

    id = Column(Integer, primary_key=True, index=True)

    name = Column(String(100), nullable=False)

    phone = Column(String(15), nullable=True)

    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)

    route_id = Column(
        Integer,
        ForeignKey("routes.id"),
        nullable=False,
    )

    sequence = Column(Float, nullable=False)

    default_amount = Column(Float)

    active = Column(Boolean, default=True)

    house_image_path = Column(String(255))

    created_at = Column(DateTime, server_default=func.now())

    route = relationship(
        "Route",
        back_populates="customers",
    )

    collections = relationship(
        "DailyCollection",
        back_populates="customer",
    )


# -------------------------------------------------------
# Collector
# -------------------------------------------------------
class Collector(Base):
    __tablename__ = "collectors"

    id = Column(Integer, primary_key=True, index=True)

    name = Column(String(100), nullable=False)

    phone = Column(
        String(15),
        unique=True,
        nullable=False,
    )

    active = Column(Boolean, default=True)

    created_at = Column(DateTime, server_default=func.now())

    assignments = relationship(
        "RouteAssignment",
        back_populates="collector",
    )

    collections = relationship(
        "DailyCollection",
        back_populates="collector",
    )

    locations = relationship(
        "CollectorLocation",
        back_populates="collector",
    )


# -------------------------------------------------------
# Route Assignment
# -------------------------------------------------------
class RouteAssignment(Base):
    __tablename__ = "route_assignments"

    id = Column(Integer, primary_key=True, index=True)

    route_id = Column(
        Integer,
        ForeignKey("routes.id"),
        nullable=False,
    )

    collector_id = Column(
        Integer,
        ForeignKey("collectors.id"),
        nullable=False,
    )

    date = Column(
        Date,
        nullable=False,
        default=date_type.today,
    )

    route = relationship(
        "Route",
        back_populates="assignments",
    )

    collector = relationship(
        "Collector",
        back_populates="assignments",
    )


# -------------------------------------------------------
# Daily Collection
# -------------------------------------------------------
class DailyCollection(Base):
    __tablename__ = "collections"

    id = Column(Integer, primary_key=True, index=True)

    customer_id = Column(
        Integer,
        ForeignKey("customers.id"),
        nullable=False,
    )

    collector_id = Column(
        Integer,
        ForeignKey("collectors.id"),
        nullable=True,
    )

    date = Column(
        Date,
        nullable=False,
        default=date_type.today,
    )

    status = Column(
        SAEnum(CollectionStatus),
        default=CollectionStatus.pending,
        nullable=False,
    )

    amount_collected = Column(Float)

    collected_at = Column(DateTime)

    notes = Column(String(500))

    customer = relationship(
        "Customer",
        back_populates="collections",
    )

    collector = relationship(
        "Collector",
        back_populates="collections",
    )


# -------------------------------------------------------
# Collector Location
# -------------------------------------------------------
class CollectorLocation(Base):
    __tablename__ = "collector_locations"

    id = Column(Integer, primary_key=True, index=True)

    collector_id = Column(
        Integer,
        ForeignKey("collectors.id"),
        nullable=False,
    )

    latitude = Column(Float, nullable=False)

    longitude = Column(Float, nullable=False)

    recorded_at = Column(
        DateTime,
        server_default=func.now(),
    )

    collector = relationship(
        "Collector",
        back_populates="locations",
    )