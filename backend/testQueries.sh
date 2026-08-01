# test script for retrofit directory Queries
#
# The /api/query endpoint expects the same envelope the website sends
# (see website/js/app.mjs):
#   { "messages": [ { "role": "user", "content": [ { "query": "..." } ] } ] }

LOCAL=http://localhost:5001/api/query
REMOTE=https://retrofit-directory.org.uk/retrofit/query

echo '== valid queries (local) =='
curl -H "Content-Type: application/json" -X POST \
  -d '{"messages":[{"role":"user","content":[{"query":"How many organisations are located in Bristol?"}]}]}' \
  $LOCAL
echo
curl -H "Content-Type: application/json" -X POST \
  -d '{"messages":[{"role":"user","content":[{"query":"Is there an architect in the database that is located in Hampshire?  If so, what is its name?"}]}]}' \
  $LOCAL
echo

echo '== multi-turn history: only the last message is answered (local) =='
curl -H "Content-Type: application/json" -X POST \
  -d '{"messages":[{"role":"user","content":[{"query":"How many organisations are located in Bristol?"}]},{"role":"assistant","content":[{"text":"There are 3 matching records."}]},{"role":"user","content":[{"query":"Which organisations are located in Hampshire?"}]}]}' \
  $LOCAL
echo

echo '== malformed bodies should return 400, not 500 (local) =='
# missing 'messages' envelope (the old flat format)
curl -H "Content-Type: application/json" -X POST \
  -d '{"query":"How many organisations are located in Bristol?"}' \
  $LOCAL
echo
# message without a 'content' array
curl -H "Content-Type: application/json" -X POST \
  -d '{"messages":[{"query":"How many organisations are located in Bristol?"}]}' \
  $LOCAL
echo
# empty messages array
curl -H "Content-Type: application/json" -X POST \
  -d '{"messages":[]}' \
  $LOCAL
echo
# content entry without a 'query' field
curl -H "Content-Type: application/json" -X POST \
  -d '{"messages":[{"role":"user","content":[{"text":"not a query"}]}]}' \
  $LOCAL
echo

echo '== valid query (remote) =='
curl -H "Content-Type: application/json" -X POST \
  -d '{"messages":[{"role":"user","content":[{"query":"Is there an architect in the database that is located in Hampshire?  If so, what is its name?"}]}]}' \
  $REMOTE
echo
