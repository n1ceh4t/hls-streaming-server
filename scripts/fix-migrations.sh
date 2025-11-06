#!/bin/bash

# Fix migration tracking - mark migrations as applied if tables exist
# This handles cases where migrations were run manually or partially

set -e

# Load database environment variables
if [ -f .env ]; then
    while IFS='=' read -r key value || [ -n "$key" ]; do
        [[ "$key" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$key" ]] && continue
        key=$(echo "$key" | xargs)
        if [[ "$key" =~ ^DB_ ]]; then
            value=$(echo "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
            export "$key=$value"
        fi
    done < <(grep -E '^[[:space:]]*DB_' .env 2>/dev/null || true)
fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-hls_streaming}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-}"

if [ -n "$DB_PASSWORD" ]; then
    export PGPASSWORD="$DB_PASSWORD"
fi

echo "🔧 Checking migration status..."

# Check if migration 002 tables exist
if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'media_buckets');" | grep -q t; then
    echo "✅ Migration 002 tables exist"
    # Mark as applied if not already
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "INSERT INTO schema_migrations (version) VALUES ('002') ON CONFLICT DO NOTHING;" > /dev/null
    echo "✅ Marked migration 002 as applied"
fi

# Check if migration 003 tables exist
if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'library_folders');" | grep -q t; then
    echo "✅ Migration 003 tables exist"
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "INSERT INTO schema_migrations (version) VALUES ('003') ON CONFLICT DO NOTHING;" > /dev/null
    echo "✅ Marked migration 003 as applied"
fi

# Check if migration 004 tables exist
if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'admin_users');" | grep -q t; then
    echo "✅ Migration 004 tables exist"
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "INSERT INTO schema_migrations (version) VALUES ('004') ON CONFLICT DO NOTHING;" > /dev/null
    echo "✅ Marked migration 004 as applied"
fi

echo ""
echo "✨ Migration status fixed!"

