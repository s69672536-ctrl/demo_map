import os
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

load_dotenv()

# Defaults to a local SQLite file so the project runs out of the box with
# zero setup. Point DATABASE_URL at Postgres for real use, e.g.
# postgresql://vrp_user:vrp_password@localhost:5432/vrp_collection
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./vrp_collection.db")

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
