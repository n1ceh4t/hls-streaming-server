#!/bin/bash

# PostgreSQL Setup Script for HLS Streaming Server
# This script installs PostgreSQL and sets up the database

set -e

echo "🚀 PostgreSQL Setup for HLS Streaming Server"
echo "=============================================="
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
   echo "❌ Please do not run this script as root. It will prompt for sudo when needed."
   exit 1
fi

# Step 1: Install PostgreSQL
echo "📦 Step 1: Installing PostgreSQL..."
if ! command -v psql &> /dev/null; then
    echo "PostgreSQL not found. Installing..."
    sudo apt-get update -qq
    sudo apt-get install -y postgresql postgresql-contrib
    echo "✅ PostgreSQL installed"
else
    echo "✅ PostgreSQL already installed"
fi

# Step 2: Start PostgreSQL service
echo ""
echo "🔄 Step 2: Starting PostgreSQL service..."
sudo systemctl start postgresql
sudo systemctl enable postgresql
echo "✅ PostgreSQL service started"

# Step 3: Create database user and database
echo ""
echo "🗄️  Step 3: Creating database and user..."

# Default values
DB_NAME="hls_streaming"
DB_USER="postgres"
NEW_DB_USER="hls_user"

# Check if we should create a new user or use postgres
read -p "Create a new database user? (Y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Nn]$ ]]; then
    USE_USER="postgres"
    echo "Using existing 'postgres' user"
else
    USE_USER="$NEW_DB_USER"
    
    # Prompt for password or generate one
    echo ""
    echo "Database password options:"
    echo "1. Generate a random secure password (recommended)"
    echo "2. Enter your own password"
    read -p "Choose option (1/2, default: 1): " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[2]$ ]]; then
        # Prompt for password (with hidden input if possible)
        read -sp "Enter password for $NEW_DB_USER (min 8 characters): " DB_PASSWORD
        echo
        if [ -z "$DB_PASSWORD" ] || [ ${#DB_PASSWORD} -lt 8 ]; then
            echo "⚠️  Password too short. Generating a secure random password instead..."
            DB_PASSWORD=$(openssl rand -base64 24 | tr -d "=+/" | cut -c1-24)
            echo "Generated password: $DB_PASSWORD"
        fi
    else
        # Generate secure random password
        if command -v openssl &> /dev/null; then
            DB_PASSWORD=$(openssl rand -base64 24 | tr -d "=+/" | cut -c1-24)
        elif command -v shasum &> /dev/null; then
            # macOS fallback
            DB_PASSWORD=$(date +%s | shasum -a 256 | base64 | head -c 24)
        elif command -v sha256sum &> /dev/null; then
            # Linux fallback
            DB_PASSWORD=$(date +%s | sha256sum | base64 | head -c 24)
        else
            # Last resort: use /dev/urandom if available
            if [ -c /dev/urandom ]; then
                DB_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -d "=+/" | head -c 24)
            else
                # Pure bash fallback (less secure but portable)
                DB_PASSWORD=$(echo "$(date +%s)$RANDOM" | openssl dgst -sha256 | cut -d' ' -f2 | head -c 24)
                if [ -z "$DB_PASSWORD" ]; then
                    echo "❌ Error: Could not generate password. Please enter one manually."
                    read -sp "Enter password for $NEW_DB_USER (min 8 characters): " DB_PASSWORD
                    echo
                    if [ -z "$DB_PASSWORD" ] || [ ${#DB_PASSWORD} -lt 8 ]; then
                        echo "❌ Password too short or empty. Exiting."
                        exit 1
                    fi
                fi
            fi
        fi
        echo "✅ Generated secure password: $DB_PASSWORD"
        echo "⚠️  IMPORTANT: Save this password! You'll need it for your .env file."
    fi
    
    # Create new user
    sudo -u postgres psql -c "CREATE USER $NEW_DB_USER WITH PASSWORD '$DB_PASSWORD';" 2>/dev/null || {
        echo "User may already exist. Attempting to update password..."
        sudo -u postgres psql -c "ALTER USER $NEW_DB_USER WITH PASSWORD '$DB_PASSWORD';" 2>/dev/null || echo "⚠️  Could not update existing user. Please set password manually."
    }
    echo "✅ Created/updated user: $NEW_DB_USER"
fi

# Create database
sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $USE_USER;" 2>/dev/null || echo "Database may already exist, continuing..."
echo "✅ Created database: $DB_NAME"

# Step 4: Update .env file
echo ""
echo "📝 Step 4: Updating .env file..."

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    echo "⚠️  .env file not found. Run 'npm run setup' first or create .env manually."
    exit 1
fi

# Check if database config exists
if grep -q "DB_HOST=" "$ENV_FILE"; then
    echo "Database configuration already exists in .env"
    read -p "Update database configuration? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing configuration"
        exit 0
    fi
fi

# Backup .env
cp "$ENV_FILE" "$ENV_FILE.backup"

# Update or add database configuration
if [ "$USE_USER" != "postgres" ]; then
    DB_USER_VALUE="$NEW_DB_USER"
    DB_PASSWORD_VALUE="$DB_PASSWORD"
    echo ""
    echo "⚠️  IMPORTANT: Save your database password!"
    echo "   Password: $DB_PASSWORD_VALUE"
    echo "   This password will be saved to your .env file."
else
    DB_USER_VALUE="postgres"
    DB_PASSWORD_VALUE=""
    echo "⚠️  Using 'postgres' user. You may need to set a password."
fi

# Remove existing DB_* lines if any
sed -i '/^DB_HOST=/d; /^DB_PORT=/d; /^DB_NAME=/d; /^DB_USER=/d; /^DB_PASSWORD=/d; /^DB_POOL_MIN=/d; /^DB_POOL_MAX=/d; /^DB_SSL=/d' "$ENV_FILE"

# Add database configuration
cat >> "$ENV_FILE" << EOF

# Database Configuration (auto-generated by setup-database.sh)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=$DB_NAME
DB_USER=$DB_USER_VALUE
DB_PASSWORD=$DB_PASSWORD_VALUE
DB_POOL_MIN=2
DB_POOL_MAX=10
DB_SSL=false
EOF

echo "✅ Updated .env file"

echo ""
echo "✅ Database setup complete!"
echo ""
echo "📋 Summary:"
echo "   Database: $DB_NAME"
echo "   User: $DB_USER_VALUE"
echo "   Host: localhost:5432"
echo ""
echo "🚀 Next steps:"
echo "   1. Review and update .env file if needed"
if [ "$USE_USER" != "postgres" ]; then
    echo "   2. ✅ Database password has been saved to .env"
    echo "      (Keep this password secure - it's already configured)"
fi
echo "   3. Run migrations: npm run migrate"
echo ""

