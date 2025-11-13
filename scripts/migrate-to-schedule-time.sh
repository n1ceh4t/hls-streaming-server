#!/bin/bash
# Migration script: Replace VirtualTimeService with ScheduleTimeService
# This script performs bulk find-replace operations to complete the migration

set -e

CHANNEL_SERVICE="src/services/channel/ChannelService.ts"

echo "🔄 Starting migration to ScheduleTimeService..."
echo "📝 Backing up ChannelService.ts..."

# Create backup
cp "$CHANNEL_SERVICE" "$CHANNEL_SERVICE.backup-$(date +%s)"

echo "🔧 Performing replacements..."

# 1. Remove/simplify virtual time initialization
sed -i 's/await this\.virtualTimeService\.initializeVirtualTimeline(channelId)/await this.scheduleTimeService.initializeScheduleTime(channelId)/g' "$CHANNEL_SERVICE"

echo "  ✓ Replaced initializeVirtualTimeline calls"

# 2. Remove virtual time advance calls (no longer needed - we calculate on-demand)
# Replace with comment explaining why it's removed
sed -i '/await this\.virtualTimeService\.advanceVirtualTime(/,/);/c\        // NOTE: No longer advancing virtual time - position calculated on-demand from schedule_start_time' "$CHANNEL_SERVICE"

echo "  ✓ Removed advanceVirtualTime calls"

# 3. Remove pause virtual time calls (no longer needed)
sed -i '/await this\.virtualTimeService\.pauseVirtualTime(/,/);/c\        // NOTE: No longer pausing virtual time - not needed with schedule-based approach' "$CHANNEL_SERVICE"

echo "  ✓ Removed pauseVirtualTime calls"

# 4. Remove resume virtual time calls (no longer needed)
sed -i '/await this\.virtualTimeService\.resumeVirtualTime(/,/);/c\        // NOTE: No longer resuming virtual time - position calculated on-demand' "$CHANNEL_SERVICE"

echo "  ✓ Removed resumeVirtualTime calls"

# 5. Replace calculateCurrentVirtualPosition with getCurrentPosition
sed -i 's/this\.virtualTimeService\.calculateCurrentVirtualPosition(/this.scheduleTimeService.getCurrentPosition(/g' "$CHANNEL_SERVICE"
sed -i 's/virtualTime,/channelId,/g' "$CHANNEL_SERVICE"

echo "  ✓ Replaced calculateCurrentVirtualPosition calls"

# 6. Clean up virtual time fallback logic - replace with schedule time fallback
sed -i "s/'EPG could not determine position, falling back to virtual time calculation'/'EPG could not determine position, falling back to schedule time calculation'/g" "$CHANNEL_SERVICE"
sed -i "s/'Resuming from virtual time position (EPG fallback)'/'Resuming from schedule time position (EPG fallback)'/g" "$CHANNEL_SERVICE"

echo "  ✓ Updated fallback log messages"

# 7. Replace virtual time session tracking with elapsed seconds
# For playback sessions, we'll just use elapsed seconds from schedule start instead of totalVirtualSeconds
sed -i 's/const virtualTimeAtStart = virtualTimeState?.totalVirtualSeconds || 0/const schedulePosition = await this.scheduleTimeService.getCurrentPosition(channelId, []); const elapsedSecondsAtStart = schedulePosition?.elapsedSeconds || 0/g' "$CHANNEL_SERVICE"
sed -i 's/const virtualTimeAtEnd = virtualTimeState?.totalVirtualSeconds || 0/const schedulePosition = await this.scheduleTimeService.getCurrentPosition(channelId, []); const elapsedSecondsAtEnd = schedulePosition?.elapsedSeconds || 0/g' "$CHANNEL_SERVICE"
sed -i 's/virtualTimeAtStart/elapsedSecondsAtStart/g' "$CHANNEL_SERVICE"
sed -i 's/virtualTimeAtEnd/elapsedSecondsAtEnd/g' "$CHANNEL_SERVICE"

echo "  ✓ Updated session tracking"

# 8. Remove virtual time state variable declarations that are no longer used
sed -i '/const virtualTimeState = await this\.scheduleTimeService\.getChannelVirtualTime(channelId);/d' "$CHANNEL_SERVICE"

echo "  ✓ Removed unused virtual time state fetches"

echo ""
echo "✅ Migration complete!"
echo ""
echo "📊 Summary of changes:"
echo "  - Replaced initializeVirtualTimeline → initializeScheduleTime"
echo "  - Removed advanceVirtualTime calls (calculate on-demand now)"
echo "  - Removed pauseVirtualTime calls (not needed)"
echo "  - Removed resumeVirtualTime calls (not needed)"
echo "  - Updated session tracking to use elapsed seconds"
echo ""
echo "⚠️  Manual review recommended for:"
echo "  - Lines with 'position' object usage (verify field names)"
echo "  - Session repository calls (may need schema updates)"
echo ""
echo "📁 Backup saved to: $CHANNEL_SERVICE.backup-$(date +%s)"
echo ""
echo "🔍 Next steps:"
echo "  1. Review the changes: git diff $CHANNEL_SERVICE"
echo "  2. Fix any remaining compilation errors"
echo "  3. Run migration: npm run migrate"
echo "  4. Test the channel service"
