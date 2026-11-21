use std::{collections::HashMap, sync::Arc, time::Duration};

use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex, Semaphore};

use crate::text_write::{self, Report, Request};

type Outcome = Result<Report, &'static str>;
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(5);

struct Pending {
    approve: oneshot::Sender<bool>,
    outcome: oneshot::Receiver<Outcome>,
}

pub(crate) struct Writer {
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    slots: Arc<Semaphore>,
}

impl Writer {
    pub(crate) fn new() -> Self {
        Self { pending: Arc::default(), slots: Arc::new(Semaphore::new(32)) }
    }

    pub(crate) async fn prepare(&self, nonce: &str, request: Request) -> Result<Value, &'static str> {
        let slot = self.slots.clone().try_acquire_owned().map_err(|_| "WRITE_BUSY")?;
        let (approve, approval) = oneshot::channel();
        let (ready, opened) = oneshot::channel();
        let (completed, outcome) = oneshot::channel();
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            let result = text_write::prepared_write(request, || {
                ready.send(()).map_err(|_| "WRITE_CANCELLED")?;
                if !matches!(approval.blocking_recv(), Ok(true)) {
                    return Err("WRITE_CANCELLED");
                }
                Ok(())
            });
            let _ = completed.send(result);
        });
        if opened.await.is_err() {
            return result(outcome).await;
        }
        let mut pending = self.pending.lock().await;
        if pending.contains_key(nonce) {
            return Err("WRITE_BUSY");
        }
        pending.insert(nonce.to_owned(), Pending { approve, outcome });
        drop(pending);

        let pending = self.pending.clone();
        let nonce = nonce.to_owned();
        tokio::spawn(async move {
            tokio::time::sleep(APPROVAL_TIMEOUT).await;
            pending.lock().await.remove(&nonce);
        });
        Ok(json!({"ready": true}))
    }

    pub(crate) async fn finish(&self, nonce: &str, commit: bool) -> Result<Value, &'static str> {
        let pending = self.pending.lock().await.remove(nonce).ok_or("WRITE_EXPIRED")?;
        pending.approve.send(commit).map_err(|_| "WRITE_CANCELLED")?;
        if !commit {
            let _ = pending.outcome.await;
            return Ok(json!({"cancelled": true}));
        }
        result(pending.outcome).await
    }
}

async fn result(outcome: oneshot::Receiver<Outcome>) -> Result<Value, &'static str> {
    let report = outcome.await.map_err(|_| "WRITE_UNCONFIRMED")??;
    serde_json::to_value(report).map_err(|_| "WRITE_UNCONFIRMED")
}
