#!/bin/bash

# Database migration script using psql
# Executes SQL migration files directly using PostgreSQL's psql command

set -e

# Load database environment variables (safely handle special characters)
# Only load DB_* variables to avoid conflicts with other env vars
if [ -f .env ]; then
    # Read .env and export only DB_* variables
    while IFS='=' read -r key value || [ -n "$key" ]; do
        # Skip comments and empty lines
        [[ "$key" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$key" ]] && continue
        
        # Remove leading/trailing whitespace from key
        key=$(echo "$key" | xargs)
        
        # Only process DB_* variables
        if [[ "$key" =~ ^DB_ ]]; then
            # Remove quotes from value if present
            value=$(echo "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
            export "$key=$value"
        fi
    done < <(grep -E '^[[:space:]]*DB_' .env 2>/dev/null || true)
fi

# Get database connection details
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-hls_streaming}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-}"

# Check if psql is available
if ! command -v psql &> /dev/null; then
    echo "❌ Error: psql command not found. Please install PostgreSQL client tools."
    exit 1
fi

# Build connection string
if [ -n "$DB_PASSWORD" ]; then
    export PGPASSWORD="$DB_PASSWORD"
fi

# Migration directory
MIGRATIONS_DIR="${1:-./database/migrations}"

if [ ! -d "$MIGRATIONS_DIR" ]; then
    echo "❌ Error: Migration directory not found: $MIGRATIONS_DIR"
    exit 1
fi

echo "🚀 Starting database migrations..."
echo "   Host: $DB_HOST:$DB_PORT"
echo "   Database: $DB_NAME"
echo "   User: $DB_USER"
echo ""

# Create migrations table if it doesn't exist
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" <<EOF
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT NOW()
);
EOF

# Get list of applied migrations
APPLIED_MIGRATIONS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT version FROM schema_migrations ORDER BY version;" 2>/dev/null | xargs)

# Find migration files
MIGRATION_FILES=$(find "$MIGRATIONS_DIR" -name "*.sql" -type f | sort)

if [ -z "$MIGRATION_FILES" ]; then
    echo "⚠️  No migration files found in $MIGRATIONS_DIR"
    exit 0
fi

# Process each migration file
for MIGRATION_FILE in $MIGRATION_FILES; do
    FILENAME=$(basename "$MIGRATION_FILE")
    VERSION=$(echo "$FILENAME" | cut -d'_' -f1)
    
    # Check if already applied
    if echo "$APPLIED_MIGRATIONS" | grep -q "^$VERSION$"; then
        echo "⏭️  Skipping $FILENAME (already applied)"
        continue
    fi
    
    echo "📝 Running migration: $FILENAME"
    
    # Execute migration
    if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$MIGRATION_FILE" -v ON_ERROR_STOP=1; then
        # Mark as applied
        psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "INSERT INTO schema_migrations (version) VALUES ('$VERSION') ON CONFLICT DO NOTHING;" > /dev/null
        echo "✅ Migration $VERSION applied successfully"
    else
        echo "❌ Migration $VERSION failed"
        exit 1
    fi
done

echo ""
echo "✨ All migrations completed successfully"

