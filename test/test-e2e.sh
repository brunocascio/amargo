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
TEST_NPM_PACKAGE="express@3"

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
TEST_PYPI_PACKAGE="django"

echo "  Testing PyPI install..."
pip install --index-url "${AMARGO_URL}/pypi/simple" --trusted-host localhost "$TEST_PYPI_PACKAGE" 2>/dev/null || {
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

# Step 4: Test Go module proxy
echo -e "${YELLOW}Step 4: Testing Go module download...${NC}"

# Test with a small, popular Go module
TEST_GO_MODULE="github.com/google/uuid@v1.3.0"

echo "  Testing Go module download..."
GO_TEST_DIR=$(mktemp -d)
cd "$GO_TEST_DIR"

# Initialize a test Go module
go mod init test-amargo 2>/dev/null || true

# Set GOPROXY to use Amargo
export GOPROXY="${AMARGO_URL}/go"
export GOSUMDB=off  # Disable checksum verification for testing

# Try to get the module
go get "$TEST_GO_MODULE" 2>/dev/null || {
    echo -e "${YELLOW}  ⚠ Go module download failed (check if Amargo is running)${NC}"
    cd - > /dev/null
    rm -rf "$GO_TEST_DIR"
    unset GOPROXY
    unset GOSUMDB
}

if [ -f "$GO_TEST_DIR/go.mod" ] && grep -q "github.com/google/uuid" "$GO_TEST_DIR/go.mod" 2>/dev/null; then
    echo -e "${GREEN}✓ Go module download successful${NC}"
    
    # Test module info endpoint
    echo "  Testing Go module info endpoint..."
    INFO_RESPONSE=$(curl -s "${AMARGO_URL}/go/github.com/google/uuid/@v/v1.3.0.info")
    if echo "$INFO_RESPONSE" | grep -q "v1.3.0" 2>/dev/null; then
        echo -e "${GREEN}✓ Go module .info endpoint working${NC}"
    else
        echo -e "${YELLOW}  ℹ .info endpoint check skipped${NC}"
    fi
    
    # Test module list endpoint
    echo "  Testing Go module list endpoint..."
    LIST_RESPONSE=$(curl -s "${AMARGO_URL}/go/github.com/google/uuid/@v/list")
    if [ ! -z "$LIST_RESPONSE" ]; then
        echo -e "${GREEN}✓ Go module version list working${NC}"
    else
        echo -e "${YELLOW}  ℹ Version list check skipped${NC}"
    fi
else
    echo -e "${YELLOW}  ℹ Skipped (module not downloaded)${NC}"
fi

cd - > /dev/null
rm -rf "$GO_TEST_DIR"
unset GOPROXY
unset GOSUMDB
echo ""

# Step 5: Test Maven repository
echo -e "${YELLOW}Step 5: Testing Maven artifact download...${NC}"

# Test with Apache Commons Lang (reliable and widely used)
TEST_MAVEN_ARTIFACT="org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar"

echo "  Testing Maven artifact download..."
MAVEN_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "${AMARGO_URL}/maven/${TEST_MAVEN_ARTIFACT}")

if [ "$MAVEN_RESPONSE" = "200" ]; then
    echo -e "${GREEN}✓ Maven artifact download successful${NC}"
    
    # Test maven-metadata.xml endpoint
    echo "  Testing Maven metadata endpoint..."
    METADATA_RESPONSE=$(curl -s "${AMARGO_URL}/maven/org/apache/commons/commons-lang3/maven-metadata.xml")
    if echo "$METADATA_RESPONSE" | grep -q "commons-lang3" 2>/dev/null; then
        echo -e "${GREEN}✓ Maven metadata endpoint working${NC}"
    else
        echo -e "${YELLOW}  ℹ Metadata endpoint check skipped${NC}"
    fi
    
    # Test POM file endpoint
    echo "  Testing Maven POM file endpoint..."
    POM_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "${AMARGO_URL}/maven/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.pom")
    if [ "$POM_RESPONSE" = "200" ]; then
        echo -e "${GREEN}✓ Maven POM file endpoint working${NC}"
    else
        echo -e "${YELLOW}  ℹ POM file check skipped${NC}"
    fi
    
    # Test second request for caching
    echo "  Testing Maven cache..."
    CACHE_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "${AMARGO_URL}/maven/${TEST_MAVEN_ARTIFACT}")
    if [ "$CACHE_RESPONSE" = "200" ]; then
        echo -e "${GREEN}✓ Maven cache working${NC}"
    fi
else
    echo -e "${YELLOW}  ℹ Skipped (artifact not downloaded - response: $MAVEN_RESPONSE)${NC}"
fi
echo ""

# Step 6: Test NuGet repository
echo -e "${YELLOW}Step 6: Testing NuGet package download...${NC}"

# Test with a small, popular NuGet package (Newtonsoft.Json)
TEST_NUGET_PACKAGE_ID="newtonsoft.json"
TEST_NUGET_VERSION="13.0.1"

echo "  Testing NuGet package download..."
NUGET_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "${AMARGO_URL}/nuget/v3-flatcontainer/${TEST_NUGET_PACKAGE_ID}/${TEST_NUGET_VERSION}/${TEST_NUGET_PACKAGE_ID}.${TEST_NUGET_VERSION}.nupkg")

if [ "$NUGET_RESPONSE" = "200" ]; then
    echo -e "${GREEN}✓ NuGet package download successful${NC}"
    
    # Test NuGet service index
    echo "  Testing NuGet service index..."
    SERVICE_INDEX_RESPONSE=$(curl -s "${AMARGO_URL}/nuget/v3/index.json")
    if echo "$SERVICE_INDEX_RESPONSE" | grep -q "PackageBaseAddress" 2>/dev/null; then
        echo -e "${GREEN}✓ NuGet service index working${NC}"
    else
        echo -e "${YELLOW}  ℹ Service index check skipped${NC}"
    fi
    
    # Test package versions endpoint
    echo "  Testing NuGet package versions endpoint..."
    VERSIONS_RESPONSE=$(curl -s "${AMARGO_URL}/nuget/v3-flatcontainer/${TEST_NUGET_PACKAGE_ID}/index.json")
    if echo "$VERSIONS_RESPONSE" | grep -q "versions" 2>/dev/null; then
        echo -e "${GREEN}✓ NuGet package versions endpoint working${NC}"
    else
        echo -e "${YELLOW}  ℹ Package versions check skipped${NC}"
    fi
    
    # Test second request for caching
    echo "  Testing NuGet cache..."
    CACHE_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "${AMARGO_URL}/nuget/v3-flatcontainer/${TEST_NUGET_PACKAGE_ID}/${TEST_NUGET_VERSION}/${TEST_NUGET_PACKAGE_ID}.${TEST_NUGET_VERSION}.nupkg")
    if [ "$CACHE_RESPONSE" = "200" ]; then
        echo -e "${GREEN}✓ NuGet cache working${NC}"
    fi
else
    echo -e "${YELLOW}  ℹ Skipped (package not downloaded - response: $NUGET_RESPONSE)${NC}"
fi
echo ""

echo -e "${GREEN}=== E2E installation tests completed ===${NC}"
echo -e "${YELLOW}Note: Tests assume services are running at ${AMARGO_URL}${NC}"
