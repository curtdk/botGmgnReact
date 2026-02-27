#!/bin/bash

# =========================
# 配置
# =========================

API_KEY="FeHxz2ceDCSkJTtmzEh9g9PhdEC1eEkT"
WALLET="4KuEoZ7QxZZbwZjXfuShhBGL3Ba6qrnycdVn95BCLj21"

# 超时秒（防止无限等待）
TIMEOUT=180

# =========================
# SQL（最快写法）
# =========================

SQL=$(cat <<EOF
SELECT
    MIN(block_time) AS first_block_time
FROM solana.account_activity
WHERE address = '$WALLET'
AND block_time IS NOT NULL
EOF
)

echo "Submitting query..."

REQUEST_BODY=$(jq -n \
  --arg sql "$SQL" \
  --arg perf "medium" \
  '{sql: $sql, performance: $perf}')

RESPONSE=$(curl -s -X POST "https://api.dune.com/api/v1/sql/execute" \
  -H "Content-Type: application/json" \
  -H "X-Dune-Api-Key: $API_KEY" \
  -d "$REQUEST_BODY")

EXEC_ID=$(echo "$RESPONSE" | jq -r '.execution_id')

if [ "$EXEC_ID" = "null" ] || [ -z "$EXEC_ID" ]; then
  echo "❌ execution create failed"
  echo "$RESPONSE"
  exit 1
fi

echo "execution_id: $EXEC_ID"

# =========================
# 等待执行
# =========================

START_TIME=$(date +%s)

while true
do
  STATUS=$(curl -s -X GET \
    "https://api.dune.com/api/v1/execution/$EXEC_ID/status" \
    -H "X-Dune-Api-Key: $API_KEY" | jq -r '.state')

  echo "status: $STATUS"

  if [ "$STATUS" = "QUERY_STATE_COMPLETED" ]; then
    break
  fi

  if [ "$STATUS" = "QUERY_STATE_FAILED" ]; then
    echo "❌ query failed"
    exit 1
  fi

  NOW=$(date +%s)
  ELAPSED=$((NOW - START_TIME))

  if [ $ELAPSED -gt $TIMEOUT ]; then
    echo "❌ timeout after ${TIMEOUT}s"
    exit 1
  fi

  sleep 2
done

# =========================
# 获取结果
# =========================

RESULT=$(curl -s -X GET \
  "https://api.dune.com/api/v1/execution/$EXEC_ID/results" \
  -H "X-Dune-Api-Key: $API_KEY")

FIRST_TIME=$(echo "$RESULT" | jq -r '.result.rows[0].first_block_time')

echo ""
echo "✅ FIRST TX TIME:"
echo "$FIRST_TIME"