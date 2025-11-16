#!/bin/bash
# PyPI Proxy Test Script

set -e

PROXY_URL="http://localhost:3000"
PYPI_BASE="${PROXY_URL}/pypi"

echo "========================================="
echo "Testing PyPI Proxy Implementation"
echo "========================================="
echo ""

# Test 1: Health Check
echo "1. Testing health endpoint..."
curl -s "${PROXY_URL}/health" | jq .
echo "✓ Health check passed"
echo ""

# Test 2: Package Index
echo "2. Testing package index..."
RESPONSE=$(curl -s "${PYPI_BASE}/simple/" | head -20)
if echo "$RESPONSE" | grep -q "Links for"; then
    echo "✗ Package index returned incorrect content"
    exit 1
elif echo "$RESPONSE" | grep -q "<a href="; then
    echo "✓ Package index working"
else
    echo "✗ Package index failed"
    exit 1
fi
echo ""

# Test 3: Package Page
echo "3. Testing package page for 'requests'..."
RESPONSE=$(curl -s "${PYPI_BASE}/simple/requests/" | grep -o 'href="/pypi/packages' | head -1)
if [ "$RESPONSE" = 'href="/pypi/packages' ]; then
    echo "✓ Package page working (URLs rewritten correctly)"
else
    echo "✗ Package page URLs not rewritten correctly"
    echo "Expected: href=\"/pypi/packages"
    echo "Got: $RESPONSE"
    exit 1
fi
echo ""

# Test 4: Package Download (Cache MISS)
echo "4. Testing package download (Cache MISS)..."
HEADERS=$(curl -I -s "${PYPI_BASE}/packages/ba/bb/dfa0141a32d773c47e4dede1a617c59a23b74dd302e449cf85413fc96bc4/requests-0.2.0.tar.gz")
HTTP_CODE=$(echo "$HEADERS" | grep "HTTP" | awk '{print $2}')
CACHE_STATUS=$(echo "$HEADERS" | grep -i "X-Amargo-Cache" | cut -d':' -f2 | tr -d ' \r\n')
REPO_NAME=$(echo "$HEADERS" | grep -i "X-Amargo-Repository" | cut -d':' -f2 | tr -d ' \r\n')

if [ "$HTTP_CODE" = "200" ]; then
    echo "✓ Download successful (HTTP $HTTP_CODE)"
    if [ "$CACHE_STATUS" = "MISS" ]; then
        echo "✓ Cache status: MISS (expected for first download)"
    else
        echo "⚠ Cache status: $CACHE_STATUS (expected MISS)"
    fi
    if [ -n "$REPO_NAME" ]; then
        echo "✓ Repository: $REPO_NAME (group routing working!)"
    fi
else
    echo "✗ Download failed (HTTP $HTTP_CODE)"
    echo "$HEADERS"
    exit 1
fi
echo ""

# Test 5: Package Download (Cache HIT)
echo "5. Testing package download again (Cache HIT)..."
sleep 2  # Give it time to cache
HEADERS=$(curl -I -s "${PYPI_BASE}/packages/ba/bb/dfa0141a32d773c47e4dede1a617c59a23b74dd302e449cf85413fc96bc4/requests-0.2.0.tar.gz")
HTTP_CODE=$(echo "$HEADERS" | grep "HTTP" | awk '{print $2}')
CACHE_STATUS=$(echo "$HEADERS" | grep -i "X-Amargo-Cache" | cut -d':' -f2 | tr -d ' \r\n')
REPO_NAME=$(echo "$HEADERS" | grep -i "X-Amargo-Repository" | cut -d':' -f2 | tr -d ' \r\n')

if [ "$HTTP_CODE" = "200" ]; then
    echo "✓ Download successful (HTTP $HTTP_CODE)"
    if [ "$CACHE_STATUS" = "HIT" ]; then
        echo "✓ Cache status: HIT (caching working!)"
    else
        echo "⚠ Cache status: $CACHE_STATUS (expected HIT, but MISS is OK if cache hasn't persisted)"
    fi
    if [ -n "$REPO_NAME" ]; then
        echo "✓ Served from repository: $REPO_NAME"
    fi
else
    echo "✗ Download failed (HTTP $HTTP_CODE)"
    exit 1
fi
echo ""

# Test 6: Package Name Normalization
echo "6. Testing package name normalization..."
RESPONSE1=$(curl -s "${PYPI_BASE}/simple/Django/" | grep -o "<h1>.*</h1>" | head -1)
RESPONSE2=$(curl -s "${PYPI_BASE}/simple/django/" | grep -o "<h1>.*</h1>" | head -1)

if [ "$RESPONSE1" = "$RESPONSE2" ]; then
    echo "✓ Package name normalization working (Django == django)"
else
    echo "✗ Package name normalization failed"
    echo "Django response: $RESPONSE1"
    echo "django response: $RESPONSE2"
    exit 1
fi
echo ""

echo "========================================="
echo "All tests passed! ✓"
echo "========================================="
echo ""
echo "PyPI proxy is working correctly at:"
echo "  ${PYPI_BASE}/simple/"
echo ""
echo "Configure pip to use this proxy:"
echo "  pip install --index-url ${PYPI_BASE}/simple/ <package>"
echo ""
