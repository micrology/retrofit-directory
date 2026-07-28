# test script for retrofit directory Queries
curl -H "Content-Type: application/json" -X POST \
  -d '{"query":"How many organisations are located in Bristol?"}' \
  http://localhost:5001/api/query
curl -H "Content-Type: application/json" -X POST \
  -d '{"query":"Is there an architect in the database that is located in Hampshire?  If so, what is its name?"}' \
  http://localhost:5001/api/query
  curl -H "Content-Type: application/json" -X POST \
  -d '{"query":"Is there an architect in the database that is located in Hampshire?  If so, what is its name?"}' \
  https://retrofit-directory.org.uk/retrofit/query