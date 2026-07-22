#!/usr/bin/env bash
# Exit on error
set -o errexit

echo "Installing Microsoft ODBC Driver 18 for SQL Server..."

# Add Microsoft's repository for ODBC
curl -sSL https://packages.microsoft.com/keys/microsoft.asc | apt-key add -
curl -sSL https://packages.microsoft.com/config/ubuntu/22.04/prod.list > /etc/apt/sources.list.d/mssql-release.list

# Update packages and install the driver
apt-get update
ACCEPT_EULA=Y apt-get install -y msodbcsql18

# Install your Python dependencies
pip install -r requirements.txt