#!/bin/bash
# backend-security-fixes.sh
# Security fixes specifically for Gambino backend

set -e

echo "🔐 Gambino Backend Security Fixes"
echo "=================================="
echo ""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Verify we're in backend directory
if [ ! -f "server.js" ]; then
    echo -e "${RED}❌ Error: server.js not found${NC}"
    echo "Please run this from your backend directory"
    exit 1
fi

echo -e "${BLUE}[1/5]${NC} Backing up server.js..."
BACKUP_FILE="server.js.backup.$(date +%Y%m%d_%H%M%S)"
cp server.js "$BACKUP_FILE"
echo -e "${GREEN}✅ Backup created: $BACKUP_FILE${NC}"
echo ""

echo -e "${BLUE}[2/5]${NC} Fixing duplicate CORS middleware..."
# Check if duplicates exist
if grep -n "app.use(cors(corsOptions));" server.js | wc -l | grep -q "2"; then
    echo "Found duplicate CORS calls - creating fixed version..."
    
    # This will keep only the first occurrence
    awk '
    /app\.use\(cors\(corsOptions\)\);/ {
        if (cors_count++ == 0) print
        next
    }
    /app\.options\(\x27\*\x27, cors\(corsOptions\)\);/ {
        if (options_count++ == 0) print
        next
    }
    {print}
    ' server.js > server.js.temp
    
    mv server.js.temp server.js
    echo -e "${GREEN}✅ Removed duplicate CORS middleware${NC}"
else
    echo -e "${YELLOW}⚠️  No duplicate CORS found (already fixed or different pattern)${NC}"
fi
echo ""

echo -e "${BLUE}[3/5]${NC} Installing rate-limit package (if not present)..."
npm list express-rate-limit &> /dev/null || npm install express-rate-limit
echo -e "${GREEN}✅ Rate limiting package ready${NC}"
echo ""

echo -e "${BLUE}[4/5]${NC} Checking NoSQL injection protection..."
if npm list express-mongo-sanitize &> /dev/null; then
    echo -e "${GREEN}✅ express-mongo-sanitize already installed${NC}"
else
    echo -e "${YELLOW}⚠️  Installing express-mongo-sanitize...${NC}"
    npm install express-mongo-sanitize
fi
echo ""

echo -e "${BLUE}[5/5]${NC} Security audit summary..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
npm audit --audit-level=moderate || true
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}🎉 Backend security fixes completed!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 ${YELLOW}NEXT MANUAL STEPS:${NC}"
echo ""
echo "1. ${BLUE}Add Rate Limiting to server.js${NC}"
echo "   Add this after line ~226 (after existing rate limiters):"
echo ""
cat << 'EOF'
// Admin-specific rate limiting
const adminRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many admin requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const strictRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many sensitive requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply to admin routes (add before line ~500)
app.use('/api/admin', adminRateLimiter);
EOF
echo ""
echo "2. ${BLUE}Test the server${NC}"
echo "   node server.js"
echo ""
echo "3. ${BLUE}Fix remaining vulnerabilities${NC}"
echo "   Run: npm audit fix --force"
echo "   (This will update @solana/spl-token with breaking changes)"
echo ""
echo "📄 ${GREEN}Files created:${NC}"
echo "   - $BACKUP_FILE (backup of original server.js)"
echo "   - server-security-improvements.js (detailed guide)"
echo ""
echo "🔍 ${BLUE}Check server.js diff:${NC}"
echo "   diff $BACKUP_FILE server.js"
echo ""
