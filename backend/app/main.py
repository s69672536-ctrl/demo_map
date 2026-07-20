# import os
# from fastapi import FastAPI
# from fastapi.middleware.cors import CORSMiddleware
# from fastapi.staticfiles import StaticFiles

# from . import models
# from .database import engine
# from .routers import routes, customers, collectors, collections, tracking

# models.Base.metadata.create_all(bind=engine)

# UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "..", "static", "uploads")
# os.makedirs(UPLOADS_DIR, exist_ok=True)

# app = FastAPI(
#     title="Puthusu",
#     description="Puthusu - fixed-sequence VRP backend for field collection agents "
#                  "(microfinance / bill collection / meter reading style routes).",
#     version="1.0.0",
# )

# # Wide open for local dev / the bundled admin dashboard. Lock this down
# # (specific origins) before deploying.
# # app.add_middleware(
# #     CORSMiddleware,
# #     allow_origins=[
# #         "https://collection-admin.onrender.com",
# #         "https://collection-web.onrender.com",
# #     ],
# #     allow_credentials=True,
# #     allow_methods=["*"],
# #     allow_headers=["*"],
# # )
# # In main.py - replace the CORS middleware section

# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=[
#         "https://collection-web.onrender.com",      # Collector app
#         "https://collection-admin.onrender.com",    # Admin dashboard
#         "https://collection-backend-akng.onrender.com",  # Backend itself
#         "http://localhost:8000",                    # Local backend
#         "http://localhost:3000",                    # Local frontend
#         "http://127.0.0.1:8000",
#         "http://127.0.0.1:3000",
#     ],
#     allow_credentials=True,
#     allow_methods=["*"],  # Allow all HTTP methods
#     allow_headers=["*"],  # Allow all headers
#     expose_headers=["*"],
# )

# app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "..", "static")), name="static")

# app.include_router(routes.router)
# app.include_router(customers.router)
# app.include_router(collectors.router)
# app.include_router(collections.router)
# app.include_router(tracking.router)


# @app.get("/admin")
# def root():
#     return {"status": "ok", "docs": "/docs"}


import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import models
from .database import engine
from .routers import routes, customers, collectors, collections, tracking

models.Base.metadata.create_all(bind=engine)

UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "..", "static", "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)

app = FastAPI(
    title="Puthusu",
    description="Puthusu - fixed-sequence VRP backend for field collection agents "
                 "(microfinance / bill collection / meter reading style routes).",
    version="1.0.0",
)

# ===== CORS CONFIGURATION =====
# For production, use specific origins. For testing, use ["*"] to allow all.
# If the specific origins don't work, uncomment the ["*"] line below.

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://collection-web.onrender.com",           # Collector app
        "https://collection-admin.onrender.com",         # Admin dashboard
        "https://collection-backend-akng.onrender.com",  # Backend itself
        "http://localhost:8000",                         # Local backend
        "http://localhost:3000",                         # Local frontend
        "http://127.0.0.1:8000",
        "http://127.0.0.1:3000",
        # Uncomment the line below if the above still doesn't work:
        # "*",  # Allow ALL origins (for testing only)
    ],
    allow_credentials=True,
    allow_methods=["*"],   # Allow all HTTP methods (GET, POST, PUT, DELETE, etc.)
    allow_headers=["*"],   # Allow all headers
    expose_headers=["*"],  # Expose all headers to the client
)

# ===== ALTERNATIVE: If the above doesn't work, use this instead =====
# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=["*"],  # Allow ALL origins (temporary fix)
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
# )

app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "..", "static")), name="static")

app.include_router(routes.router)
app.include_router(customers.router)
app.include_router(collectors.router)
app.include_router(collections.router)
app.include_router(tracking.router)


@app.get("/admin")
def root():
    return {"status": "ok", "docs": "/docs"}