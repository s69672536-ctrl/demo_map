from __future__ import annotations

from datetime import date, datetime
from typing import Optional, List
from pydantic import BaseModel, ConfigDict
from .models import CollectionStatus


# ---------- Route ----------

class RouteCreate(BaseModel):
    route_name: str
    start_lat: float
    start_lng: float
    end_lat: float
    end_lng: float


class RouteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    route_name: str
    start_lat: float
    start_lng: float
    end_lat: float
    end_lng: float
    default_collector_id: Optional[int] = None


class SetDefaultCollector(BaseModel):
    collector_id: int


# ---------- Customer ----------

class CustomerCreate(BaseModel):
    name: str
    phone: Optional[str] = None
    latitude: float
    longitude: float
    default_amount: Optional[float] = None


class CustomerUpdate(BaseModel):
    """Used for PATCH /customers/{id}. All fields optional so a client only
    needs to send what's actually changing - combine with
    model_dump(exclude_unset=True) in the router so omitted fields are left
    untouched instead of being overwritten with None."""
    name: Optional[str] = None
    phone: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    default_amount: Optional[float] = None


class CustomerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    phone: Optional[str]
    latitude: float
    longitude: float
    route_id: int
    sequence: float
    default_amount: Optional[float]
    active: bool
    house_image_path: Optional[str] = None


class CustomerReorder(BaseModel):
    customer_id: int
    sequence: float


# ---------- Collector ----------

class CollectorCreate(BaseModel):
    name: str
    phone: str

class CollectorUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    active: Optional[bool] = None

    
class CollectorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    phone: str
    active: bool


class RouteAssignmentCreate(BaseModel):
    route_id: int
    collector_id: int
    date: Optional[date] = None


# ---------- Daily collection / today's route ----------

class TodayStop(BaseModel):
    customer_id: int
    name: str
    phone: Optional[str]
    latitude: float
    longitude: float
    sequence: float
    default_amount: Optional[float]
    status: CollectionStatus
    amount_collected: Optional[float] = None
    house_image_path: Optional[str] = None


class TodayRouteOut(BaseModel):
    route_id: int
    route_name: str
    date: date
    start_lat: float
    start_lng: float
    end_lat: float
    end_lng: float
    stops: List[TodayStop]


class RouteCompletedSummary(BaseModel):
    total_distance_km: float
    stops_completed: int
    stops_total: int
    amount_collected: float


class LegPoint(BaseModel):
    label: str
    latitude: float
    longitude: float


class CurrentLegOut(BaseModel):
    """Single active navigation segment - from wherever the collector last
    finished to the next pending stop. This is deliberately NOT the whole
    route, so the collector's map only ever shows one destination at a time."""
    from_point: LegPoint
    to_customer_id: Optional[int] = None
    to_point: Optional[LegPoint] = None
    to_phone: Optional[str] = None
    to_amount: Optional[float] = None
    to_house_image_path: Optional[str] = None
    geometry: List[List[float]] = []
    distance_km: Optional[float] = None
    eta_minutes: Optional[float] = None
    route_completed: bool = False
    summary: Optional[RouteCompletedSummary] = None


class MarkCollectedRequest(BaseModel):
    status: CollectionStatus
    amount_collected: Optional[float] = None
    notes: Optional[str] = None


# ---------- GPS ----------

class LocationPing(BaseModel):
    latitude: float
    longitude: float


class LocationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    collector_id: int
    latitude: float
    longitude: float
    recorded_at: datetime


class CollectorTrackingSummary(BaseModel):
    collector_id: int
    collector_name: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    last_updated: Optional[datetime] = None
    distance_km_today: float
    route_name: Optional[str] = None