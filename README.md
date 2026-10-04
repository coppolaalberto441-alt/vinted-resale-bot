# Vinted Resale Bot

Controlla ogni 5 minuti i brand configurati in `brands.json`.

- GitHub Actions interroga Vinted.
- Cloudflare Worker e D1 filtrano i prezzi, evitano duplicati e conservano lo stato.
- Telegram riceve soltanto i nuovi annunci con prezzo almeno il 45% sotto la mediana attiva.

Le chiavi `WORKER_URL` e `INGEST_SECRET` sono salvate nei GitHub Actions secrets e non sono presenti nel codice pubblico.
