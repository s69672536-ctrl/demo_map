import os
import uuid
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db

router = APIRouter(prefix="/customers", tags=["customers"])

UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "static", "uploads")
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic"}


@router.get("/{customer_id}", response_model=schemas.CustomerOut)
def get_customer(customer_id: int, db: Session = Depends(get_db)):
    customer = db.query(models.Customer).get(customer_id)
    if not customer:
        raise HTTPException(404, "Customer not found")
    return customer


@router.patch("/{customer_id}", response_model=schemas.CustomerOut)
def update_customer(
    customer_id: int, customer_update: schemas.CustomerCreate, db: Session = Depends(get_db)
):
    customer = db.query(models.Customer).get(customer_id)
    if not customer:
        raise HTTPException(404, "Customer not found")
    for field, value in customer_update.model_dump().items():
        setattr(customer, field, value)
    db.commit()
    db.refresh(customer)
    return customer


@router.delete("/{customer_id}")
def deactivate_customer(customer_id: int, db: Session = Depends(get_db)):
    """Soft-delete: keeps history intact, just drops them off future routes."""
    customer = db.query(models.Customer).get(customer_id)
    if not customer:
        raise HTTPException(404, "Customer not found")
    customer.active = False
    db.commit()
    return {"ok": True}


@router.post("/{customer_id}/house-image", response_model=schemas.CustomerOut)
async def upload_house_image(
    customer_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)
):
    """
    Attaches a photo of the house/shop front so the collector can recognize
    it before arriving. Shown in the customer detail view and (once wired
    into the collector app) before navigation starts.
    """
    customer = db.query(models.Customer).get(customer_id)
    if not customer:
        raise HTTPException(404, "Customer not found")

    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(400, f"Unsupported image type: {file.content_type}")

    os.makedirs(UPLOADS_DIR, exist_ok=True)
    ext = os.path.splitext(file.filename or "")[1] or ".jpg"
    filename = f"customer_{customer_id}_{uuid.uuid4().hex[:8]}{ext}"
    filepath = os.path.join(UPLOADS_DIR, filename)

    contents = await file.read()
    with open(filepath, "wb") as f:
        f.write(contents)

    customer.house_image_path = f"/static/uploads/{filename}"
    db.commit()
    db.refresh(customer)
    return customer
