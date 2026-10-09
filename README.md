# Vinted Resale Bot

Controlla ogni 5 minuti i brand configurati in `brands.json`.

Per ridurre il consumo del piano gratuito, statistiche e profilo vengono salvati una volta all'ora; pulizia e verifica delle sezioni una volta al giorno. Le occasioni continuano a essere controllate ogni 5 minuti. Ogni invio dello scanner contiene un solo brand per rispettare i limiti di query.

Lo scanner legge fino a 100 annunci per brand (due pagine) senza prezzo minimo implicito. Le parole cartellino/etichetta non escludono articoli genuini. Sono necessari almeno tre annunci della stessa categoria per stimare una mediana; categorie sconosciute restano escluse, senza confrontarle con prodotti diversi.

Le occasioni oltre il limite di quattro invii per brand vengono conservate in `pending_deals` e inviate nelle scansioni successive se presenti nel catalogo recente e ancora convenienti. Annunci assenti restano sospesi. La disponibilità su Vinted può nel frattempo cambiare. Gli errori di un brand non interrompono gli invii degli altri, tranne la quota D1 condivisa esaurita. Il controllo del profilo viene dopo gli invii e non li blocca.

`SCAN_RESUME_AT` sospende solo il cron fino al ripristino della quota D1, alle 00:00 UTC del 2026-10-08; in seguito non richiede interventi. Il piano gratuito conserva limiti reali e non può garantire di catturare tutti gli annunci o invii illimitati.

Dopo `/nuovo`, la prima foto riceve automaticamente una proposta di copertina AI, fino a 10 al giorno per tutto il bot. Analisi e bozze hanno un limite complessivo di 100 richieste al giorno. Se il modello non è disponibile, viene conservato l'originale. Confrontare sempre risultato e originale prima dell'utilizzo.

- Il cron Cloudflare avvia ogni 5 minuti GitHub Actions, che interroga Vinted.
- Cloudflare Worker e D1 filtrano i prezzi, evitano duplicati e conservano lo stato.
- Telegram riceve soltanto i nuovi annunci con prezzo almeno il 45% sotto la mediana attiva.
- Il profilo Vinted `155300457` viene letto senza password: il bot registra annunci attivi, prezzi e preferiti e invia un report giornaliero.
- `/report` genera il report subito; `/trend`, `/trend7` e `/trend30` mostrano gli indici di tendenza stimati.
- Nel gruppo configurato, `/stato` mostra il riepilogo effettivo dell'ultima scansione, brand mancanti, notifiche confermate e coda. `/scarti` mostra i motivi di esclusione; `/scarti Stone Island` restringe il riepilogo a un brand.
- Il riepilogo diagnostico sostituisce una sola riga per scansione, non registra ogni articolo. I contatori si riferiscono agli annunci ricevuti, non all'intero catalogo. La quota mostrata è l'ultima verifica ufficiale salvata con data/ora, non un contatore live; una verifica del giorno UTC precedente non viene presentata come attuale.
- `/nuovo brand | tipo | taglia | condizione | prezzo` avvia l'assistente foto; invia le foto e usa `/genera` per ottenere una bozza da confermare manualmente.

I dati di vendita complessivi di Vinted non sono pubblici: i trend sono stime trasparenti basate sugli annunci osservati. Il bot non modifica né ripubblica annunci e non genera visualizzazioni o preferiti artificiali.

Le nuove stime di rivendita escludono l'articolo candidato e confrontano almeno tre altri annunci con prezzo articolo (senza commissioni), stessa categoria, marca nota, valuta e condizione nota. Modello e variante vengono avvicinati tramite il titolo: è una corrispondenza euristica, non un'identificazione certificata. Quando il tipo è esplicito, zip/girocollo/cappuccio o stivali/sneakers non vengono mescolati. Su campioni di almeno cinque prezzi vengono esclusi gli estremi tramite IQR.

La fascia proposta usa l'80% del primo quartile e l'85% della mediana dei prezzi richiesti: è una regola prudenziale, non una probabilità di vendita calibrata. Attendibilità bassa o media, mai vendita garantita; condizione sconosciuta resta a bassa attendibilità. Margini prima di spedizione e altri costi possono essere negativi. Le stime degli annunci in coda vengono ricalcolate prima dell'invio; se non esistono confronti mostrano stima non disponibile. Non si aggiungono richieste Vinted, AI o scritture di statistiche per questo calcolo.

Le chiavi `WORKER_URL` e `INGEST_SECRET` sono salvate nei GitHub Actions secrets. `GITHUB_ACTIONS_TOKEN` è salvato nei secret Cloudflare. Nessuna chiave è presente nel codice pubblico.

# Controlli disponibilità, guasti e stime generiche

- Prima di pubblicare, anche per gli annunci in coda, l'articolo deve comparire nel catalogo della scansione corrente (timestamp massimo 15 minuti). I flag espliciti venduto/chiuso/prenotato/non visibile sono esclusi dal lettore. L'assenza non significa vendita: l'annuncio resta in coda. Questo controllo non garantisce disponibilità al momento del clic e può sospendere articoli ancora disponibili usciti dalle prime due pagine.
- Il cron segnala nell'Assistente annunci 3 cicli incompleti consecutivi o 20 minuti senza un ciclo completo, una volta per incidente, con messaggio al ripristino. Richiede cron, Telegram e D1 funzionanti: non è un monitor esterno e non può garantire avvisi quando Cloudflare o la quota del database impediscono il salvataggio dello stato.
- Quando mancano confronti precisi, la stima ripiega sui prezzi richiesti osservati per marca e categoria, anche con un solo confronto, mostrando attendibilità **molto bassa**. Modello/condizione possono differire. Senza neppure un confronto non viene inventato un prezzo. Non sono prezzi di vendite concluse né garanzie di vendita.

## Filtri, priorità e risultati

Nel gruppo corrente, `/strumenti` mostra i nuovi comandi:

- `/filtri`: legge i filtri condivisi. Solo amministratori non anonimi possono modificarli con `/filtri max=80 margine=15 taglie=M,L condizioni=very_good,new_with_tags`. `max` è il totale noto, non include spedizione; `margine` usa il limite inferiore della stima prima della spedizione. Condizioni ammesse: `new_with_tags,new_without_tags,very_good,good,satisfactory`. Taglie esatte dal catalogo (es. `42,43`); taglie o condizioni sconosciute non passano filtri attivi. `/filtri taglie=* condizioni=*` rimuove solo questi limiti; `/filtri reset` azzera tutto. Gli altri valori persistono quando si modifica un'opzione.
- Le offerte presenti nel catalogo sono ordinate **all'interno di ciascun brand** per attendibilità, poi margine conservativo, poi numero di confronti. Non è una graduatoria globale fra tutti i brand. I filtri non eliminano gli annunci dalla coda e non modificano le stime di mercato.
- `/acquisto 123 | Stone Island | 25,50` registra un costo totale in EUR (spedizione e commissioni comprese). `/vendita 123 | 45` registra l'incasso netto effettivo. Puoi usare un ID Vinted o un riferimento alfanumerico unico. Marca: nome esatto della sezione. Acquisti duplicati o vendite già chiuse non vengono sovrascritti.
- `/registro` elenca gli ultimi 20 acquisti; `/risultati` mostra vendite, risultato realizzato e capitale negli invenduti per brand. Ogni utente ha il proprio registro nel gruppo; le risposte sono visibili nel gruppo. Gli invenduti non contano come profitto. Costi omessi e imposte non sono inclusi. Il bot non deduce vendite automaticamente e non accede all'account Vinted.

La tabella aggiuntiva si crea con `wrangler d1 execute vinted-resale-bot --remote --file migrations/0001_resale_trades.sql` prima del rilascio. Migrazione additiva e ripetibile, senza cancellazioni. Filtri e registrazioni scrivono solo su comando; ordinamento e scansioni non aggiungono chiamate AI o richieste Vinted.

## Consiglio di rivendita dopo l'acquisto

`/acquisto 123 | 5MC2 | 13,50` conserva il costo totale e risponde anche con un prezzo di partenza, fascia indicativa, margine e avviso di possibile perdita. Se l'ID non è presente nel campione recente, specifica il tipo: `/acquisto 123 | 5MC2 | 13,50 | felpa`. Per un acquisto già registrato: `/stima 123 | felpa`. La stima usa sempre il costo salvato, anche se un comando duplicato dichiara un importo diverso.

Non viene stimato il tipo di articolo dalla sola marca. Il costo determina il pareggio e il margine, non il valore di mercato: una cattiva spesa può produrre un consiglio di vendita in perdita. Quando il tipo è fornito manualmente la condizione è sconosciuta e l'attendibilità rimane bassa. Si confrontano prezzi richiesti, non vendite concluse, senza garanzia di vendita.

Per contenere il consumo, si conserva solo l'ultimo campione di massimo 100 articoli per brand **una volta all'ora**, insieme alle statistiche già esistenti: fino a 960 aggiornamenti della cache al giorno per 40 brand, non una scrittura per articolo. La cache usa lo stesso lettore, senza nuove richieste Vinted né AI. I consigli fanno poche letture solo su comando, senza nuova tabella o cron. Dati più vecchi di 24 ore non sono usati; in mancanza di confronti si può usare l'ultima mediana oraria della stessa marca/categoria, esplicitamente etichettata come dato aggregato a bassissima attendibilità. La cache comincia a popolarsi al prossimo aggiornamento orario.

Nessun autobuy è implementato: manca un'integrazione autorizzata per eseguire acquisti. Nessun cookie, credenziale Vinted o dato di pagamento viene richiesto o archiviato.
