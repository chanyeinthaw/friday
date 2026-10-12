FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home wednesday \
    && mkdir /data && chown wednesday:wednesday /data

WORKDIR /app
COPY --chmod=0555 dist/wednesday /app/wednesday
USER wednesday
EXPOSE 3002
ENTRYPOINT ["/app/wednesday"]
