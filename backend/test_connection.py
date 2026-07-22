# from sqlalchemy import create_engine
# from sqlalchemy.engine import URL

# connection_url = URL.create(
#     "mssql+pyodbc",
#     username="sa",
#     password="Admin@123",      # Your new password
#     host="GIRITECH105",
#     database="collection",
#     query={
#         "driver": "ODBC Driver 17 for SQL Server",
#         "TrustServerCertificate": "yes",
#     },
# )

# try:
#     engine = create_engine(connection_url)

#     with engine.connect():
#         print("✅ Connected Successfully!")

# except Exception as e:
#     print("❌ Connection Failed")c
#     print(e)