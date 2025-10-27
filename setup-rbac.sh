#!/bin/bash

# RBAC Setup & Migration Runner
# Automates the complete migration process

set -e  # Exit on any error

echo "🎯 Gambino RBAC Migration Setup"
echo "==============================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BACKUP_SUFFIX="pre-rbac-backup"
NODE_MODULES_CHECK=true
DRY_RUN=false
SKIP_TESTS=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --skip-tests)
      SKIP_TESTS=true
      shift
      ;;
    --no-backup)
      BACKUP_SUFFIX=""
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo "Options:"
      echo "  --dry-run     Show what would be done without making changes"
      echo "  --skip-tests  Skip running the test suite"
      echo "  --no-backup   Don't create backup files"
      echo "  --help        Show this help message"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      exit 1
      ;;
  esac
done

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

check_prerequisites() {
    log_step "Checking prerequisites..."
    
    # Check if Node.js is available
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed. Please install Node.js first."
        exit 1
    fi
    
    # Check if npm is available
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed. Please install npm first."
        exit 1
    fi
    
    # Check if required files exist
    required_files=("server.js" "package.json")
    for file in "${required_files[@]}"; do
        if [[ ! -f "$file" ]]; then
            log_error "Required file not found: $file"
            exit 1
        fi
    done
    
    log_info "✅ Prerequisites check passed"
}

install_dependencies() {
    log_step "Installing additional dependencies..."
    
    # Check if axios is installed (needed for tests)
    if ! npm list axios &> /dev/null; then
        log_info "Installing axios for testing..."
        npm install axios
    fi
    
    # Check if bcrypt is installed (should be there already)
    if ! npm list bcrypt &> /dev/null; then
        log_warn "bcrypt not found - this might cause issues"
    fi
    
    log_info "✅ Dependencies checked"
}

create_directory_structure() {
    log_step "Creating directory structure..."
    
    # Create directories if they don't exist
    directories=("src/middleware" "src/routes")
    for dir in "${directories[@]}"; do
        if [[ ! -d "$dir" ]]; then
            log_info "Creating directory: $dir"
            if [[ "$DRY_RUN" == "false" ]]; then
                mkdir -p "$dir"
            fi
        fi
    done
    
    log_info "✅ Directory structure ready"
}

check_rbac_files() {
    log_step "Checking RBAC files..."
    
    required_rbac_files=("src/middleware/rbac.js" "src/routes/auth.js")
    missing_files=()
    
    for file in "${required_rbac_files[@]}"; do
        if [[ ! -f "$file" ]]; then
            missing_files+=("$file")
        fi
    done
    
    if [[ ${#missing_files[@]} -gt 0 ]]; then
        log_error "Missing RBAC files:"
        for file in "${missing_files[@]}"; do
            echo "  - $file"
        done
        log_error "Please create these files using the provided artifacts before running migration."
        exit 1
    fi
    
    log_info "✅ RBAC files found"
}

backup_files() {
    if [[ -z "$BACKUP_SUFFIX" ]]; then
        log_info "Skipping backup (--no-backup specified)"
        return
    fi
    
    log_step "Creating backups..."
    
    files_to_backup=("server.js")
    if [[ -f "src/lib/auth.js" ]]; then
        files_to_backup+=("src/lib/auth.js")
    fi
    if [[ -f "src/lib/api.js" ]]; then
        files_to_backup+=("src/lib/api.js")
    fi
    
    for file in "${files_to_backup[@]}"; do
        if [[ -f "$file" ]]; then
            backup_file="${file}.$BACKUP_SUFFIX"
            log_info "Backing up $file to $backup_file"
            if [[ "$DRY_RUN" == "false" ]]; then
                cp "$file" "$backup_file"
            fi
        fi
    done
    
    log_info "✅ Backups created"
}

run_migration() {
    log_step "Running RBAC migration..."
    
    migration_args=""
    if [[ "$DRY_RUN" == "true" ]]; then
        migration_args="--dry-run"
        log_info "Running in dry-run mode..."
    fi
    
    if [[ -f "migrate-to-rbac.js" ]]; then
        log_info "Running migration script..."
        if node migrate-to-rbac.js $migration_args --backup; then
            log_info "✅ Migration completed successfully"
        else
            log_error "❌ Migration failed"
            return 1
        fi
    else
        log_error "Migration script not found: migrate-to-rbac.js"
        log_error "Please save the migration script as migrate-to-rbac.js"
        return 1
    fi
}

validate_migration() {
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "Skipping validation in dry-run mode"
        return
    fi
    
    log_step "Validating migration..."
    
    # Check if the migrated server.js has the expected changes
    if grep -q "require('./src/middleware/rbac')" server.js; then
        log_info "✅ RBAC imports found"
    else
        log_warn "⚠️ RBAC imports not found in server.js"
    fi
    
    if grep -q "app.use('/api/auth'" server.js; then
        log_info "✅ Auth routes mounting found"
    else
        log_warn "⚠️ Auth routes mounting not found in server.js"
    fi
    
    # Check if old middleware is removed
    if ! grep -q "const authenticateToken =" server.js; then
        log_info "✅ Old authenticateToken middleware removed"
    else
        log_warn "⚠️ Old authenticateToken middleware still present"
    fi
    
    log_info "✅ Basic validation completed"
}

run_tests() {
    if [[ "$SKIP_TESTS" == "true" ]]; then
        log_info "Skipping tests (--skip-tests specified)"
        return
    fi
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "Skipping tests in dry-run mode"
        return
    fi
    
    log_step "Running test suite..."
    
    # Check if test script exists
    if [[ ! -f "test-rbac-migration.js" ]]; then
        log_warn "Test script not found: test-rbac-migration.js"
        log_warn "Skipping automated tests"
        return
    fi
    
    # Check if server is running
    log_info "Checking if server is running..."
    if ! curl -s http://localhost:3001/health > /dev/null 2>&1; then
        log_warn "Server not running on http://localhost:3001"
        log_warn "Please start your server and run tests manually:"
        log_warn "  node test-rbac-migration.js --create-users --test-all"
        return
    fi
    
    # Run tests
    log_info "Running RBAC tests..."
    if node test-rbac-migration.js --create-users --test-all; then
        log_info "✅ All tests passed"
    else
        log_warn "⚠️ Some tests failed - check output above"
    fi
}

print_next_steps() {
    echo ""
    echo -e "${BLUE}🎉 Migration Setup Complete!${NC}"
    echo ""
    echo "Next Steps:"
    echo "1. Review the migrated code in server.js"
    echo "2. Test your application thoroughly"
    echo "3. Start your server and verify all endpoints work"
    echo "4. Run the test suite if you haven't already:"
    echo "   node test-rbac-migration.js --create-users --test-all"
    echo ""
    if [[ -n "$BACKUP_SUFFIX" ]]; then
        echo "Backup files created with suffix: .$BACKUP_SUFFIX"
        echo "Remove them after confirming everything works."
        echo ""
    fi
    echo "If issues occur, you can:"
    if [[ -n "$BACKUP_SUFFIX" ]]; then
        echo "- Restore from backup: cp server.js.$BACKUP_SUFFIX server.js"
    fi
    echo "- Check the migration comments in server.js"
    echo "- Run migration with --dry-run first to preview changes"
    echo ""
}

print_summary() {
    echo ""
    echo -e "${BLUE}📋 Migration Summary${NC}"
    echo "===================="
    echo "✅ Prerequisites verified"
    echo "✅ Directory structure created"
    echo "✅ RBAC files validated"
    if [[ -n "$BACKUP_SUFFIX" ]]; then
        echo "✅ Backup files created"
    fi
    if [[ "$DRY_RUN" == "false" ]]; then
        echo "✅ Migration executed"
        echo "✅ Basic validation completed"
        if [[ "$SKIP_TESTS" == "false" ]]; then
            echo "✅ Test suite attempted"
        fi
    else
        echo "ℹ️ Dry run completed (no changes made)"
    fi
}

# Main execution
main() {
    echo "Starting RBAC migration setup..."
    echo ""
    
    # Run all setup steps
    check_prerequisites
    install_dependencies
    create_directory_structure
    check_rbac_files
    backup_files
    
    # Run migration
    if run_migration; then
        validate_migration
        run_tests
        print_next_steps
    else
        log_error "Migration failed. Check errors above."
        exit 1
    fi
    
    print_summary
    
    echo ""
    echo -e "${GREEN}🚀 Setup completed successfully!${NC}"
}

# Handle script interruption
trap 'echo -e "\n${RED}Setup interrupted by user${NC}"; exit 1' INT

# Run main function
main "$@"
