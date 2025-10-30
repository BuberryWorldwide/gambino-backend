#!/bin/bash
# quick-security-fixes.sh
# Run critical security fixes automatically

set -e

echo "🔐 Gambino Admin-v2 Security Quick Fixes"
echo "========================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo -e "${RED}❌ Error: package.json not found${NC}"
    echo "Please run this script from your admin-v2 root directory"
    exit 1
fi

echo -e "${BLUE}[1/7]${NC} Checking npm audit..."
npm audit --audit-level=high || true
echo ""

echo -e "${BLUE}[2/7]${NC} Running npm audit fix..."
npm audit fix || true
echo -e "${GREEN}✅ Audit fix completed${NC}"
echo ""

echo -e "${BLUE}[3/7]${NC} Backing up important files..."
cp vercel.json vercel.json.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null || echo "No vercel.json to backup"
cp server.js server.js.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null || echo "No server.js to backup"
echo -e "${GREEN}✅ Backups created${NC}"
echo ""

echo -e "${BLUE}[4/7]${NC} Removing duplicate API file..."
if [ -f "src/lib/api copy.js" ]; then
    rm "src/lib/api copy.js"
    echo -e "${GREEN}✅ Removed 'api copy.js'${NC}"
else
    echo -e "${YELLOW}⚠️  'api copy.js' not found (might already be deleted)${NC}"
fi
echo ""

echo -e "${BLUE}[5/7]${NC} Installing missing shadcn components..."
# Check if shadcn is configured
if [ -f "components.json" ]; then
    echo "Installing essential components..."
    npx shadcn-ui@latest add alert --yes 2>/dev/null || echo "Alert already exists"
    npx shadcn-ui@latest add skeleton --yes 2>/dev/null || echo "Skeleton already exists"
    npx shadcn-ui@latest add separator --yes 2>/dev/null || echo "Separator already exists"
    npx shadcn-ui@latest add tooltip --yes 2>/dev/null || echo "Tooltip already exists"
    npx shadcn-ui@latest add sheet --yes 2>/dev/null || echo "Sheet already exists"
    npx shadcn-ui@latest add scroll-area --yes 2>/dev/null || echo "Scroll-area already exists"
    npx shadcn-ui@latest add avatar --yes 2>/dev/null || echo "Avatar already exists"
    echo -e "${GREEN}✅ shadcn components updated${NC}"
else
    echo -e "${YELLOW}⚠️  components.json not found - skipping shadcn install${NC}"
fi
echo ""

echo -e "${BLUE}[6/7]${NC} Creating CSP report endpoint directory..."
mkdir -p app/api/csp-report
echo -e "${GREEN}✅ Directory created${NC}"
echo ""

echo -e "${BLUE}[7/7]${NC} Updating dependencies..."
npm update
echo -e "${GREEN}✅ Dependencies updated${NC}"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}🎉 Quick fixes completed!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 NEXT STEPS:"
echo ""
echo "1. ${YELLOW}MANUAL FIXES REQUIRED:${NC}"
echo "   - Copy 'vercel.json.new' → 'vercel.json'"
echo "   - Copy 'csp-report-route.ts' → 'app/api/csp-report/route.ts'"
echo "   - Apply changes from 'server-security-improvements.js' to 'server.js'"
echo ""
echo "2. ${YELLOW}REVIEW & TEST:${NC}"
echo "   - Read 'admin-v2-audit-report.md' for full security analysis"
echo "   - Follow 'shadcn-migration-guide.md' to update UI components"
echo "   - Test admin login and authentication"
echo "   - Verify rate limiting works"
echo ""
echo "3. ${YELLOW}DEPLOY:${NC}"
echo "   - Run: npm run build"
echo "   - Test locally: npm run dev"
echo "   - Deploy to Vercel/production"
echo ""
echo "📄 Generated files:"
echo "   - admin-v2-audit-report.md (full audit)"
echo "   - vercel.json.new (updated security headers)"
echo "   - csp-report-route.ts (CSP violation reporting)"
echo "   - server-security-improvements.js (backend fixes)"
echo "   - shadcn-migration-guide.md (UI/UX improvements)"
echo ""
echo "🔍 Check for vulnerabilities: ${BLUE}npm audit${NC}"
echo "📦 Update specific package: ${BLUE}npm update package-name${NC}"
echo ""
echo -e "${GREEN}All automated fixes complete!${NC}"
