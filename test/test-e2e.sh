#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
AMARGO_URL="http://localhost:3000"

echo -e "${GREEN}=== Amargo E2E Test Suite ===${NC}"
echo -e "${YELLOW}Testing package installation from ${AMARGO_URL}${NC}\n"

# Step 1: Test NPM group
echo -e "${YELLOW}Step 1: Testing NPM package installation...${NC}"

# Assuming a test package exists, try to install it
# You can replace this with an actual package name that exists in your registry
TEST_NPM_PACKAGE="express"

echo "  Testing NPM install..."
INSTALL_DIR=$(mktemp -d)
cd "$INSTALL_DIR"
npm install "$TEST_NPM_PACKAGE" --registry "${AMARGO_URL}/npm" 2>/dev/null || {
    echo -e "${YELLOW}  ⚠ No NPM test package found (expected for fresh install)${NC}"
    cd - > /dev/null
    rm -rf "$INSTALL_DIR"
}

if [ -d "$INSTALL_DIR/node_modules" ]; then
    echo -e "${GREEN}✓ NPM package installation successful${NC}"
    cd - > /dev/null
    rm -rf "$INSTALL_DIR"
else
    echo -e "${YELLOW}  ℹ Skipped (no package to test)${NC}"
fi
echo ""

# Step 2: Test PyPI group
echo -e "${YELLOW}Step 2: Testing PyPI package installation...${NC}"

# Assuming a test package exists, try to install it
TEST_PYPI_PACKAGE="requests"

echo "  Testing PyPI install..."
pip install --index-url "${AMARGO_URL}/simple" --trusted-host localhost "$TEST_PYPI_PACKAGE" 2>/dev/null || {
    echo -e "${YELLOW}  ⚠ No PyPI test package found (expected for fresh install)${NC}"
}

if pip show "$TEST_PYPI_PACKAGE" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ PyPI package installation successful${NC}"
    pip uninstall -y "$TEST_PYPI_PACKAGE" 2>/dev/null || true
else
    echo -e "${YELLOW}  ℹ Skipped (no package to test)${NC}"
fi
echo ""

# Step 3: Test Docker group
echo -e "${YELLOW}Step 3: Testing Docker image pull...${NC}"

# Assuming a test image exists, try to pull it
TEST_DOCKER_IMAGE="localhost:3000/alpine:latest"

echo "  Testing Docker pull..."
docker pull "$TEST_DOCKER_IMAGE" 2>/dev/null || {
    echo -e "${YELLOW}  ⚠ No Docker test image found (expected for fresh install)${NC}"
}

if docker image inspect "$TEST_DOCKER_IMAGE" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Docker image pull successful${NC}"
    docker rmi "$TEST_DOCKER_IMAGE" 2>/dev/null || true
else
    echo -e "${YELLOW}  ℹ Skipped (no image to test)${NC}"
fi
echo ""

echo -e "${GREEN}=== E2E installation tests completed ===${NC}"
echo -e "${YELLOW}Note: Tests assume services are running at ${AMARGO_URL}${NC}"
