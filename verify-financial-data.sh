#!/bin/bash

# Gambino Financial Data Verification Script
# Compares SQLite (Pi) data with MongoDB (Backend) data

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Configuration
PI_DB_PATH="$HOME/gambino-pi-app/data/gambino-pi.db"
BACKEND_URL="https://app.gambino.gold"
ENV_FILE="$HOME/gambino-pi-app/.env"

echo -e "${CYAN}"
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║      GAMBINO FINANCIAL DATA VERIFICATION                      ║"
echo "║      SQLite (Pi) vs MongoDB (Backend) Comparison              ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ============================================================================
# PART 1: SQLite Database Verification (Local Pi)
# ============================================================================

echo -e "${GREEN}▶ PART 1: SQLite Database (Pi Edge Device)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ ! -f "$PI_DB_PATH" ]; then
    echo -e "${RED}❌ ERROR: SQLite database not found at $PI_DB_PATH${NC}"
    exit 1
fi

echo -e "${CYAN}📁 Database Location:${NC} $PI_DB_PATH"
echo -e "${CYAN}📊 Database Size:${NC} $(du -h "$PI_DB_PATH" | cut -f1)"
echo ""

# Get all-time totals from SQLite
echo -e "${YELLOW}🔍 Querying SQLite for ALL-TIME totals...${NC}"
echo ""

SQLITE_MONEY_IN=$(sqlite3 "$PI_DB_PATH" "SELECT COALESCE(SUM(amount), 0) FROM events WHERE event_type = 'money_in';")
SQLITE_MONEY_OUT=$(sqlite3 "$PI_DB_PATH" "SELECT COALESCE(SUM(amount), 0) FROM events WHERE event_type IN ('money_out', 'voucher');")
SQLITE_NET=$(echo "$SQLITE_MONEY_IN - $SQLITE_MONEY_OUT" | bc)
SQLITE_MARGIN=$(echo "scale=2; ($SQLITE_NET / $SQLITE_MONEY_IN) * 100" | bc)

SQLITE_EVENT_COUNT=$(sqlite3 "$PI_DB_PATH" "SELECT COUNT(*) FROM events;")
SQLITE_SYNCED=$(sqlite3 "$PI_DB_PATH" "SELECT COUNT(*) FROM events WHERE synced = 1;")
SQLITE_UNSYNCED=$(sqlite3 "$PI_DB_PATH" "SELECT COUNT(*) FROM events WHERE synced = 0;")

echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}💰 SQLITE FINANCIAL SUMMARY (All Time)${NC}"
echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
printf "  Money IN:           \$%'0.2f\n" "$SQLITE_MONEY_IN"
printf "  Money OUT:          \$%'0.2f\n" "$SQLITE_MONEY_OUT"
printf "  Net Revenue:        \$%'0.2f\n" "$SQLITE_NET"
printf "  Profit Margin:      %.2f%%\n" "$SQLITE_MARGIN"
echo ""
echo -e "${CYAN}📈 Event Statistics:${NC}"
echo "  Total Events:       $SQLITE_EVENT_COUNT"
echo "  Synced to Backend:  $SQLITE_SYNCED"
echo "  Pending Sync:       $SQLITE_UNSYNCED"
echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Break down by event type
echo -e "${CYAN}📊 Events by Type:${NC}"
sqlite3 -header -column "$PI_DB_PATH" <<EOF
SELECT 
    event_type as "Event Type",
    COUNT(*) as "Count",
    printf('\$%,.2f', COALESCE(SUM(amount), 0)) as "Total Amount",
    printf('\$%,.2f', COALESCE(AVG(amount), 0)) as "Avg Amount"
FROM events 
GROUP BY event_type
ORDER BY COUNT(*) DESC;
EOF
echo ""

# Break down by machine
echo -e "${CYAN}🎰 Performance by Machine:${NC}"
sqlite3 -header -column "$PI_DB_PATH" <<EOF
SELECT 
    machine_id as "Machine",
    COUNT(*) as "Events",
    printf('\$%,.2f', COALESCE(SUM(CASE WHEN event_type = 'money_in' THEN amount ELSE 0 END), 0)) as "Money IN",
    printf('\$%,.2f', COALESCE(SUM(CASE WHEN event_type IN ('money_out', 'voucher') THEN amount ELSE 0 END), 0)) as "Money OUT",
    printf('\$%,.2f', 
        COALESCE(SUM(CASE WHEN event_type = 'money_in' THEN amount ELSE 0 END), 0) - 
        COALESCE(SUM(CASE WHEN event_type IN ('money_out', 'voucher') THEN amount ELSE 0 END), 0)
    ) as "Net"
FROM events 
GROUP BY machine_id
ORDER BY machine_id;
EOF
echo ""

# Date range
echo -e "${CYAN}📅 Data Collection Period:${NC}"
sqlite3 -header -column "$PI_DB_PATH" <<EOF
SELECT 
    datetime(MIN(timestamp), 'localtime') as "First Event",
    datetime(MAX(timestamp), 'localtime') as "Last Event",
    CAST((julianday(MAX(timestamp)) - julianday(MIN(timestamp))) AS INTEGER) as "Days of Data"
FROM events;
EOF
echo ""

# ============================================================================
# PART 2: MongoDB Backend Verification (if accessible)
# ============================================================================

echo -e "${GREEN}▶ PART 2: MongoDB Backend Verification${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Extract credentials from .env
if [ -f "$ENV_FILE" ]; then
    MACHINE_TOKEN=$(grep MACHINE_TOKEN "$ENV_FILE" | cut -d'=' -f2 | tr -d '"' | tr -d "'")
    STORE_ID=$(grep STORE_ID "$ENV_FILE" | cut -d'=' -f2 | tr -d '"' | tr -d "'")
    
    if [ -z "$MACHINE_TOKEN" ]; then
        echo -e "${YELLOW}⚠️  WARNING: MACHINE_TOKEN not found in $ENV_FILE${NC}"
        echo -e "${YELLOW}   Cannot query backend API without authentication${NC}"
        BACKEND_ACCESSIBLE=false
    else
        echo -e "${CYAN}🔑 Using MACHINE_TOKEN from .env file${NC}"
        echo -e "${CYAN}🏪 Store ID:${NC} $STORE_ID"
        BACKEND_ACCESSIBLE=true
    fi
else
    echo -e "${YELLOW}⚠️  WARNING: .env file not found at $ENV_FILE${NC}"
    echo -e "${YELLOW}   Cannot query backend API without credentials${NC}"
    BACKEND_ACCESSIBLE=false
fi

echo ""

if [ "$BACKEND_ACCESSIBLE" = true ]; then
    echo -e "${YELLOW}🔍 Querying MongoDB backend via API...${NC}"
    echo ""
    
    # Test connection first
    HEARTBEAT_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BACKEND_URL/api/edge/heartbeat" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $MACHINE_TOKEN" \
        -d '{"status":"online"}' 2>&1)
    
    HTTP_CODE=$(echo "$HEARTBEAT_RESPONSE" | tail -n1)
    
    if [ "$HTTP_CODE" = "200" ]; then
        echo -e "${GREEN}✅ Backend Connection: SUCCESS${NC}"
        echo ""
        
        # Try to get store events (this endpoint may need to be created)
        echo -e "${YELLOW}📊 Fetching backend data for store: $STORE_ID${NC}"
        
        # Note: You may need to create this endpoint or use an existing one
        BACKEND_DATA=$(curl -s "$BACKEND_URL/api/admin/stores/$STORE_ID/events/summary" \
            -H "Authorization: Bearer $MACHINE_TOKEN" 2>&1)
        
        if echo "$BACKEND_DATA" | jq . &>/dev/null; then
            echo -e "${GREEN}✅ Backend data retrieved successfully${NC}"
            echo ""
            echo -e "${CYAN}Backend Response:${NC}"
            echo "$BACKEND_DATA" | jq .
        else
            echo -e "${YELLOW}⚠️  Backend data endpoint returned unexpected format${NC}"
            echo -e "${YELLOW}   This endpoint may need to be created on the backend${NC}"
            echo ""
            echo -e "${CYAN}Suggested Backend Endpoint:${NC}"
            echo "  GET /api/admin/stores/:storeId/events/summary"
            echo "  Should return: { moneyIn, moneyOut, netRevenue, eventCount, ... }"
        fi
        
    else
        echo -e "${RED}❌ Backend Connection: FAILED (HTTP $HTTP_CODE)${NC}"
        echo -e "${YELLOW}   The backend may be down or token may be invalid${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Skipping backend verification (credentials not available)${NC}"
fi

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ============================================================================
# PART 3: Data Integrity Checks
# ============================================================================

echo -e "${GREEN}▶ PART 3: Data Integrity Checks${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check for duplicate events
DUPLICATES=$(sqlite3 "$PI_DB_PATH" "SELECT COUNT(*) FROM (SELECT timestamp, machine_id, event_type, amount, COUNT(*) as cnt FROM events GROUP BY timestamp, machine_id, event_type, amount HAVING cnt > 1);")

if [ "$DUPLICATES" -eq 0 ]; then
    echo -e "${GREEN}✅ No duplicate events found${NC}"
else
    echo -e "${RED}⚠️  Found $DUPLICATES potential duplicate events${NC}"
fi

# Check for suspicious amounts
SUSPICIOUS=$(sqlite3 "$PI_DB_PATH" "SELECT COUNT(*) FROM events WHERE amount > 10000 OR amount < 0;")

if [ "$SUSPICIOUS" -eq 0 ]; then
    echo -e "${GREEN}✅ All amounts appear reasonable${NC}"
else
    echo -e "${YELLOW}⚠️  Found $SUSPICIOUS events with suspicious amounts (>$10,000 or negative)${NC}"
fi

# Check for missing timestamps
MISSING_TIMESTAMPS=$(sqlite3 "$PI_DB_PATH" "SELECT COUNT(*) FROM events WHERE timestamp IS NULL OR timestamp = '';")

if [ "$MISSING_TIMESTAMPS" -eq 0 ]; then
    echo -e "${GREEN}✅ All events have timestamps${NC}"
else
    echo -e "${RED}⚠️  Found $MISSING_TIMESTAMPS events with missing timestamps${NC}"
fi

# Check sync status
if [ "$SQLITE_UNSYNCED" -eq 0 ]; then
    echo -e "${GREEN}✅ All events synced to backend${NC}"
else
    echo -e "${YELLOW}⚠️  $SQLITE_UNSYNCED events pending sync to backend${NC}"
fi

echo ""

# ============================================================================
# PART 4: Historical Trends
# ============================================================================

echo -e "${GREEN}▶ PART 4: Historical Trends (Last 7 Days)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

echo -e "${CYAN}📈 Daily Revenue Breakdown:${NC}"
sqlite3 -header -column "$PI_DB_PATH" <<EOF
SELECT 
    date(timestamp) as "Date",
    COUNT(*) as "Events",
    printf('\$%,.2f', COALESCE(SUM(CASE WHEN event_type = 'money_in' THEN amount ELSE 0 END), 0)) as "Money IN",
    printf('\$%,.2f', COALESCE(SUM(CASE WHEN event_type IN ('money_out', 'voucher') THEN amount ELSE 0 END), 0)) as "Money OUT",
    printf('\$%,.2f', 
        COALESCE(SUM(CASE WHEN event_type = 'money_in' THEN amount ELSE 0 END), 0) - 
        COALESCE(SUM(CASE WHEN event_type IN ('money_out', 'voucher') THEN amount ELSE 0 END), 0)
    ) as "Net Revenue"
FROM events 
WHERE date(timestamp) >= date('now', '-7 days')
GROUP BY date(timestamp)
ORDER BY date(timestamp) DESC;
EOF
echo ""

# ============================================================================
# Summary
# ============================================================================

echo -e "${CYAN}"
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║                    VERIFICATION SUMMARY                       ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${GREEN}SQLite Database (Pi):${NC}"
printf "  Money IN:       \$%'0.2f\n" "$SQLITE_MONEY_IN"
printf "  Money OUT:      \$%'0.2f\n" "$SQLITE_MONEY_OUT"
printf "  Net Revenue:    \$%'0.2f\n" "$SQLITE_NET"
printf "  Profit Margin:  %.2f%%\n" "$SQLITE_MARGIN"
echo "  Total Events:   $SQLITE_EVENT_COUNT"
echo "  Sync Status:    $SQLITE_SYNCED synced, $SQLITE_UNSYNCED pending"
echo ""

if [ "$BACKEND_ACCESSIBLE" = true ] && [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✅ Backend API is accessible and responding${NC}"
else
    echo -e "${YELLOW}⚠️  Backend API verification incomplete${NC}"
fi

echo ""
echo -e "${CYAN}These numbers represent:${NC}"
echo "  • Real financial transactions from gaming machines"
echo "  • Data collected via Raspberry Pi edge devices"
echo "  • Synced to MongoDB backend at app.gambino.gold"
echo "  • Displayed in the Gambino Admin dashboard"
echo ""

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Verification Complete!${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
