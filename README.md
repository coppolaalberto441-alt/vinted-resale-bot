# Vinted Resale Bot

Controlla ogni 5 minuti i brand configurati in `brands.json`.

Per ridurre il consumo del piano gratuito, statistiche e profilo vengono salvati una volta all'ora; pulizia e verifica delle sezioni una volta al giorno. Le occasioni continuano a essere controllate ogni 5 minuti. Ogni invio dello scanner contiene un solo brand per rispettare i limiti di query.

Dopo `/nuovo`, la prima foto riceve automaticamente una proposta di copertina AI, fino a 10 al giorno per tutto il bot. Analisi e bozze hanno un limite complessivo di 100 richieste al giorno. Se il modello non è disponibile, viene conservato l'originale. Confrontare sempre risultato e originale prima dell'utilizzo.

- Il cron Cloudflare avvia ogni 5 minuti GitHub Actions, che interroga Vinted.
- Cloudflare Worker e D1 filtrano i prezzi, evitano duplicati e conservano lo stato.
- Telegram riceve soltanto i nuovi annunci con prezzo almeno il 45% sotto la mediana attiva.
- Il profilo Vinted `155300457` viene letto senza password: il bot registra annunci attivi, prezzi e preferiti e invia un report giornaliero.
- `/report` genera il report subito; `/trend`, `/trend7` e `/trend30` mostrano gli indici di tendenza stimati.
- `/nuovo brand | tipo | taglia | condizione | prezzo` avvia l'assistente foto; invia le foto e usa `/genera` per ottenere una bozza da confermare manualmente.

I dati di vendita complessivi di Vinted non sono pubblici: i trend sono stime trasparenti basate sugli annunci osservati. Il bot non modifica né ripubblica annunci e non genera visualizzazioni o preferiti artificiali.

Le chiavi `WORKER_URL` e `INGEST_SECRET` sono salvate nei GitHub Actions secrets. `GITHUB_ACTIONS_TOKEN` è salvato nei secret Cloudflare. Nessuna chiave è presente nel codice pubblico.
