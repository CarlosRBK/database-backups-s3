# Build Stage
FROM node:24-alpine3.24 AS build

WORKDIR /root

COPY package*.json ./

RUN npm ci --omit=dev

# Final Stage
FROM golang:1.26.9-alpine3.24 AS mongo-build

RUN apk add --no-cache git
WORKDIR /src/mongo-tools
RUN git init && git remote add origin https://github.com/mongodb/mongo-tools.git && \
    git fetch --depth 1 origin 4111a8b26819b0592f5f937d271e0155ef335c62 && git checkout --detach FETCH_HEAD
# Patch the stable tools release rather than using Alpine's vulnerable binary.
RUN go get golang.org/x/crypto@v0.57.0 golang.org/x/net@v0.60.0 golang.org/x/text@v0.42.0 && \
    CGO_ENABLED=0 go build -mod=mod -o /out/mongodump ./mongodump/main && \
    CGO_ENABLED=0 go build -mod=mod -o /out/mongorestore ./mongorestore/main

FROM alpine:3.24

WORKDIR /root

# Include only the Node runtime, not npm or its dependencies.
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=mongo-build /out/mongodump /out/mongorestore /usr/local/bin/

# Copy from build stage
COPY --from=build /root/node_modules ./node_modules

# Copy application code
COPY ./ /root

# Install runtime libraries and the PostgreSQL and MongoDB clients.

RUN apk upgrade --no-cache && apk add --no-cache libstdc++ ca-certificates postgresql-client


ENTRYPOINT ["node", "index.js"]
