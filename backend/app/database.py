import os
import sys
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

load_dotenv()

# When bundled into a single executable (PyInstaller), __file__ points
# inside a temp extraction folder that gets wiped between runs - so the
# database and uploads must live next to the .exe instead, or every
# restart would look like a fresh install with no data.
if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # backend/

DEFAULT_SQLITE_PATH = os.path.join(BASE_DIR, "vrp_collection.db")
DEFAULT_DATABASE_URL = f"sqlite:///{DEFAULT_SQLITE_PATH}"

# .env can still override this (e.g. to point at a shared Postgres/SQL
# Server for a multi-machine setup), but out of the box this now just
# works with zero setup - a local SQLite file next to the app.
DATABASE_URL = os.getenv("DATABASE_URL") or DEFAULT_DATABASE_URL

connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    # SQLite objects to being used across the different worker threads
    # FastAPI/Starlette hands requests to by default - this allows it.
    connect_args = {"check_same_thread": False}

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    connect_args=connect_args,
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
