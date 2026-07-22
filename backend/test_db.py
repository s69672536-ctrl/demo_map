import pyodbc
conn_str = (
    "DRIVER={ODBC Driver 17 for SQL Server};"
    "SERVER=GIRITECH105;"
    "DATABASE=collection;"
    "UID=sa;"
    "PWD=admin;"
    "Encrypt=yes;"
    "TrustServerCertificate=yes;"
)
conn = pyodbc.connect(conn_str)
print("Connected successfully!")
conn.close()