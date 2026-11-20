//! Isolated MCP stdio/HTTP pilot. Never opens or modifies Motor/Sistema/Base except
//! reading connector discovery in the explicitly supplied --base test directory.
use std::{collections::HashMap,io::Read,path::{Path,PathBuf},process::Stdio,sync::{Arc,atomic::{AtomicBool,Ordering}},time::Duration};
use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::StreamExt;
use hmac::{Hmac,Mac};
use sha2::{Digest,Sha256};
use serde_json::{json,Value};
use tokio::{io::{AsyncBufReadExt,AsyncReadExt,AsyncWriteExt,BufReader},process::{Child,ChildStdin,Command},sync::{Mutex,oneshot},task::JoinSet,time::{sleep,timeout,Instant}};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;
use crate::MAX_MESSAGE;
const LOST:&str="Se perdió la conexión con el Motor de Mind mientras ejecutaba la operación; no se sabe si terminó. Compruébalo antes de repetirla.";
#[derive(Clone,Debug)] struct Failure {code:&'static str,message:String,delivered:bool}
impl Failure {fn new(code:&'static str,message:impl Into<String>)->Self{Self{code,message:message.into(),delivered:false}}}
type Result<T>=std::result::Result<T,Failure>;
#[derive(Clone)] struct Config {base:PathBuf,cwd:String,paths:Value,launch:String,args:Vec<String>,relaunch:Option<String>,reargs:Vec<String>,version:String,revision:u64}
impl Config {
    fn parse(args:&[String])->std::result::Result<Self,String>{
        let mut options=HashMap::<String,String>::new();let mut launchargs=Vec::new();let mut reargs=Vec::new();let mut i=0;
        while i<args.len(){let name=&args[i];i+=1;let value=args.get(i).ok_or_else(||format!("Missing value for {name}"))?.clone();i+=1;
            match name.as_str(){"--launch-arg"=>launchargs.push(value),"--relaunch-arg"=>reargs.push(value),"--base"|"--cwd"|"--paths"|"--launch-command"|"--relaunch-command"|"--motor-version"|"--package-revision"=>{if options.insert(name.clone(),value).is_some(){return Err(format!("Repeated {name}"))}},_=>return Err(format!("Unknown argument {name}"))}
        }
        let base=options.remove("--base").ok_or("--base is required")?;let cwd=options.remove("--cwd").ok_or("--cwd is required")?;
        let paths:Value=serde_json::from_str(&options.remove("--paths").unwrap_or("[]".into())).map_err(|e|e.to_string())?;
        if !paths.as_array().is_some_and(|v|v.iter().all(|p|p.as_str().is_some_and(|s|Path::new(s).is_absolute()))){return Err("--paths must be an array of absolute strings".into())}
        let launch=options.remove("--launch-command").ok_or("--launch-command is required")?;
        if !Path::new(&base).is_absolute()||!Path::new(&cwd).is_absolute()||!Path::new(&launch).is_absolute(){return Err("base, cwd and launch-command must be absolute".into())}
        let relaunch=options.remove("--relaunch-command");if relaunch.as_ref().is_some_and(|p|!Path::new(p).is_absolute()){return Err("relaunch-command must be absolute".into())}
        Ok(Self{base:PathBuf::from(base),cwd,paths,launch,args:launchargs,relaunch,reargs,version:options.remove("--motor-version").unwrap_or("1.0.4".into()),revision:options.remove("--package-revision").unwrap_or("2".into()).parse().map_err(|_|"Invalid revision")?})
    }
}
#[derive(Clone)] struct Remote {port:u16,token:String,session:String,generation:Uuid}
struct Connector {port:u16,token:String,health:Value}
struct Reply {status:u16,session:Option<String>,body:Option<Value>}
struct Relay {child:Child,input:ChildStdin,pending:Arc<Mutex<HashMap<String,Value>>>}
struct Bridge {config:Config,client:reqwest::Client,output:Mutex<tokio::io::Stdout>,remote:Mutex<Option<Remote>>,connecting:Mutex<()>,init:Mutex<Option<Value>>,initialized:AtomicBool,had:AtomicBool,reduced:AtomicBool,closed:AtomicBool,connection:Uuid,relay:Mutex<Option<Relay>>,relay_attempted:AtomicBool}
fn rpc(id:Value,result:Value)->Value{json!({"jsonrpc":"2.0","id":id,"result":result})}
fn rpc_error(id:Value,code:i32,message:&str)->Value{json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})}
fn request_id(v:&Value)->Option<&Value>{v.get("id").filter(|id|id.is_string()||id.as_i64().is_some_and(|n|(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n)))}
fn is_reply(v:&Value)->bool{v.get("jsonrpc")==Some(&json!("2.0"))&&(v.get("result").is_some()||v.get("error").is_some())}
fn repeatable(v:&Value)->bool {
    match v.get("method").and_then(Value::as_str){Some("initialize"|"ping"|"tools/list")=>true,Some("tools/call")=>{
        let name=v.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
        matches!(name,"estado"|"buscar"|"explorar"|"leer"|"eliminados"|"continuidad_consultar"|"conversaciones_buscar"|"conversacion_leer"|"conversacion_preferencias"|"destinos_consultar"|"actualizacion_consultar"|"papelera"|"propiedades"|"indices_personalizados"|"funciones"|"historial_funcion")||(name=="destino_resolver"&&v.pointer("/params/arguments/preparar")!=Some(&Value::Bool(true)))
    },_=>false}
}
fn regular_json(path:&Path)->Option<Value>{
    let mut options=std::fs::OpenOptions::new();options.read(true);
    #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.custom_flags(0x00200000);}
    #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC);}
    let file=options.open(path).ok()?;let metadata=file.metadata().ok()?;
    if !metadata.is_file()||metadata.len()>65536{return None}
    #[cfg(windows)] {use std::os::windows::fs::MetadataExt;if metadata.file_attributes()&0x400!=0{return None}}
    let mut bytes=Vec::new();file.take(65537).read_to_end(&mut bytes).ok()?;if bytes.len()>65536{return None}serde_json::from_slice(&bytes).ok()
}
fn base_id(path:&Path)->Option<String>{
    let canonical=std::fs::canonicalize(path).ok()?;let mut text=canonical.to_str()?.to_owned();
    #[cfg(windows)] {if let Some(p)=text.strip_prefix("\\\\?\\"){text=p.to_owned();}}
    text=text.nfc().collect();
    #[cfg(any(windows,target_os="macos"))] {text=text.to_lowercase();}
    Some(format!("{:x}",Sha256::digest(text.as_bytes()))[..16].to_owned())
}
struct Events{buffer:Vec<u8>,data:Vec<Vec<u8>>,size:usize}
impl Events {
    fn new()->Self{Self{buffer:Vec::new(),data:Vec::new(),size:0}}
    fn push(&mut self,chunk:&[u8])->Result<Vec<Value>>{
        if self.buffer.len()+chunk.len()>MAX_MESSAGE{return Err(Failure::new("MOTOR_BAD_RESPONSE","SSE frame exceeds 16 MiB"))}
        self.buffer.extend_from_slice(chunk);let mut messages=Vec::new();
        while let Some(pos)=self.buffer.iter().position(|b|*b==b'\n'){
            let mut line:Vec<u8>=self.buffer.drain(..=pos).collect();line.pop();if line.last()==Some(&b'\r'){line.pop();}
            if line.is_empty(){
                if !self.data.is_empty(){let joined=self.data.join(&b'\n');if let Ok(v)=serde_json::from_slice::<Value>(&joined){messages.push(v)}self.data.clear();self.size=0;}
            }else if let Some(raw)=line.strip_prefix(b"data:") {let data=raw.strip_prefix(b" ").unwrap_or(raw);self.size+=data.len();if self.size>MAX_MESSAGE{return Err(Failure::new("MOTOR_BAD_RESPONSE","SSE data exceeds 16 MiB"))}self.data.push(data.to_vec());}
        }
        Ok(messages)
    }
}
impl Bridge {
    async fn write(&self,value:Value){if self.closed.load(Ordering::SeqCst){return}let mut out=self.output.lock().await;if let Ok(mut data)=serde_json::to_vec(&value){data.push(b'\n');let _=out.write_all(&data).await;let _=out.flush().await;}}
    async fn health(&self)->Option<Connector>{
        let state=regular_json(&self.config.base.join("conector.json"))?;let secret=regular_json(&self.config.base.join("conector-secreto.json"))?;
        if state.get("version")?.as_u64()!=Some(1)||secret.get("version")?.as_u64()!=Some(1){return None}
        let port=u16::try_from(state.get("port")?.as_u64()?).ok()?;if port==0{return None}
        let expected=base_id(&self.config.base)?;if state.get("baseId")?.as_str()?!=expected{return None}
        let token=secret.get("token")?.as_str()?;if token.len()<32{return None}
        let nonce=Uuid::new_v4().simple().to_string();
        let response=self.client.get(format!("http://127.0.0.1:{port}/health?nonce={nonce}")).timeout(Duration::from_millis(800)).send().await.ok()?;
        if response.status()!=200{return None}let mut stream=response.bytes_stream();let mut bytes=Vec::new();while let Some(chunk)=stream.next().await{let chunk=chunk.ok()?;if bytes.len()+chunk.len()>65536{return None}bytes.extend_from_slice(&chunk);}
        let health:Value=serde_json::from_slice(&bytes).ok()?;
        if health.get("ok")?.as_bool()!=Some(true)||health.get("port")?.as_u64()!=Some(port as u64)||health.get("baseId")?.as_str()?!=expected{return None}
        let mut mac=Hmac::<Sha256>::new_from_slice(token.as_bytes()).ok()?;mac.update(format!("mind-health-v1\n{nonce}\n{expected}\n{port}").as_bytes());
        let proof=health.get("proof")?.as_str()?;if proof.len()!=64||!proof.bytes().all(|b|b.is_ascii_hexdigit()){return None}
        let proof_bytes:Option<Vec<u8>>=(0..64).step_by(2).map(|i|u8::from_str_radix(&proof[i..i+2],16).ok()).collect();mac.verify_slice(&proof_bytes?).ok()?;
        Some(Connector{port,token:token.to_owned(),health})
    }
    async fn wake(&self)->Result<Connector>{
        if let Some(c)=self.health().await{return Ok(c)}
        let mut command=std::process::Command::new(&self.config.launch);command.args(&self.config.args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000200);}
        let mut child=command.spawn().map_err(|e|Failure::new("MOTOR_START_FAILED",format!("Mind no pudo iniciarse: {e}")))?;
        let until=Instant::now()+Duration::from_secs(25);
        loop{if let Some(c)=self.health().await{return Ok(c)}if let Ok(Some(status))=child.try_wait(){if !status.success(){return Err(Failure::new("MOTOR_START_FAILED",format!("Mind no pudo iniciarse (salida {status}).")))}}
            if Instant::now()>=until{return Err(Failure::new("MOTOR_START_TIMEOUT","El Motor no respondió después de iniciarse."))}sleep(Duration::from_millis(50)).await;
        }
    }
    fn auth(&self,remote:&Remote,method:reqwest::Method)->reqwest::RequestBuilder{
        let request=self.client.request(method,format!("http://127.0.0.1:{}/mcp",remote.port)).bearer_auth(&remote.token);
        if remote.session.is_empty(){request}else{request.header("Mcp-Session-Id",&remote.session)}
    }
    async fn post(&self,remote:&Remote,message:&Value,workspace:bool)->Result<Reply>{
        let mut request=self.auth(remote,reqwest::Method::POST).header("Accept","application/json, text/event-stream").header("Content-Type","application/json; charset=utf-8").body(serde_json::to_vec(message).unwrap());
        if workspace{let declared=json!({"cwd":self.config.cwd,"paths":self.config.paths,"conexion":self.connection.to_string()});request=request.header("X-Mind-Workspace",URL_SAFE_NO_PAD.encode(serde_json::to_vec(&declared).unwrap()));}
        if matches!(message.get("method").and_then(Value::as_str),Some("initialize"|"notifications/initialized"|"ping")){request=request.timeout(Duration::from_secs(25));}
        let response=request.send().await.map_err(|e|Failure{code:"MOTOR_CONNECTION_LOST",message:LOST.into(),delivered:!e.is_connect()})?;
        let status=response.status().as_u16();let session=response.headers().get("mcp-session-id").and_then(|x|x.to_str().ok()).map(str::to_owned);
        if [401,404,503].contains(&status){return Ok(Reply{status,session,body:None})}
        let sse=response.headers().get("content-type").and_then(|v|v.to_str().ok()).is_some_and(|v|v.starts_with("text/event-stream"));
        let mut stream=response.bytes_stream();let mut bytes=Vec::new();let mut events=Events::new();
        while let Some(chunk)=stream.next().await {let chunk=chunk.map_err(|_|Failure{code:"MOTOR_CONNECTION_LOST",message:LOST.into(),delivered:true})?;
            if sse {for event in events.push(&chunk).map_err(|mut e|{e.delivered=true;e})?{if is_reply(&event)&&event.get("id")==message.get("id"){return Ok(Reply{status,session,body:Some(event)})}self.write(event).await;}}
            else {if bytes.len()+chunk.len()>MAX_MESSAGE{return Err(Failure{code:"MOTOR_BAD_RESPONSE",message:"HTTP body exceeds 16 MiB".into(),delivered:true})}bytes.extend_from_slice(&chunk);}
        }
        if sse&&request_id(message).is_some(){return Err(Failure{code:"MOTOR_CONNECTION_LOST",message:LOST.into(),delivered:true})}
        let body=if bytes.is_empty(){None}else{Some(serde_json::from_slice(&bytes).map_err(|_|Failure{code:"MOTOR_BAD_RESPONSE",message:"El Motor respondió con JSON inválido.".into(),delivered:true})?)};
        Ok(Reply{status,session,body})
    }
    async fn invalidate(&self,generation:Uuid){let mut remote=self.remote.lock().await;if remote.as_ref().is_some_and(|r|r.generation==generation){*remote=None}}
    async fn initialized_remote(&self,remote:&Remote)->Result<()>{let response=self.post(remote,&json!({"jsonrpc":"2.0","method":"notifications/initialized"}),false).await?;if ![200,202].contains(&response.status){return Err(Failure::new("MOTOR_UNAVAILABLE","No se pudo inicializar la sesión."))}Ok(())}
    async fn connect(self:&Arc<Self>)->Result<(Remote,Value)>{
        let _guard=self.connecting.lock().await;
        if let Some(remote)=self.remote.lock().await.clone(){return Ok((remote,Value::Null))}
        let connector=self.wake().await?;
        let changed=connector.health.get("motorVersion").and_then(Value::as_str).is_some_and(|v|v!=self.config.version)||connector.health.get("packageRevision").and_then(Value::as_u64).is_some_and(|r|r!=self.config.revision);
        if self.had.load(Ordering::SeqCst)&&changed&&self.config.relaunch.is_some()&&!self.relay_attempted.load(Ordering::SeqCst){return Err(Failure::new("BRIDGE_OUTDATED","El puente debe ceder a la revisión instalada."))}
        let mut remote=Remote{port:connector.port,token:connector.token,session:String::new(),generation:Uuid::new_v4()};
        let message=self.init.lock().await.clone().ok_or_else(||Failure::new("NOT_INITIALIZED","La sesión no se inicializó."))?;
        let response=self.post(&remote,&message,true).await?;
        let body=response.body.filter(is_reply).ok_or_else(||Failure::new("MOTOR_BAD_RESPONSE","El Motor no devolvió initialize."))?;
        if response.status!=200{return Err(Failure::new("MOTOR_BAD_RESPONSE","initialize recibió un estado inesperado."))}
        remote.session=response.session.filter(|s|!s.is_empty()).ok_or_else(||Failure::new("MOTOR_BAD_RESPONSE","Falta Mcp-Session-Id."))?;
        if self.initialized.load(Ordering::SeqCst){self.initialized_remote(&remote).await?;}
        *self.remote.lock().await=Some(remote.clone());self.had.store(true,Ordering::SeqCst);
        self.start_sse(remote.clone());
        if self.reduced.swap(false,Ordering::SeqCst){self.write(json!({"jsonrpc":"2.0","method":"notifications/tools/list_changed"})).await;}
        Ok((remote,body))
    }
    fn start_sse(self:&Arc<Self>,remote:Remote){let this=self.clone();tokio::spawn(async move{
        let mut wait=1;
        loop {
            if this.closed.load(Ordering::SeqCst)||!this.remote.lock().await.as_ref().is_some_and(|r|r.generation==remote.generation){return}
            if let Ok(response)=this.auth(&remote,reqwest::Method::GET).header("Accept","text/event-stream").send().await {
                let status=response.status().as_u16();if [401,404,503].contains(&status){this.invalidate(remote.generation).await;return}
                if status==405{return}
                if status==200 {
                    let mut stream=response.bytes_stream();let mut parser=Events::new();
                    while let Some(chunk)=stream.next().await {
                        if this.closed.load(Ordering::SeqCst){return}
                        match chunk{Ok(bytes)=>{match parser.push(&bytes){Ok(events)=>{for event in events{this.write(event).await;}},Err(_)=>break}},Err(_)=>break}
                    }
                }
            }
            sleep(Duration::from_secs(wait)).await;wait=(wait*2).min(30);
            if let Some(healthy)=this.health().await{if healthy.port==remote.port&&healthy.token==remote.token{continue}}
            this.invalidate(remote.generation).await;return
        }
    });}
    async fn error(&self,message:&Value,error:Failure,startup:bool){
        let id=message.get("id").cloned().unwrap_or(Value::Null);let method=message.get("method").and_then(Value::as_str);
        let reply=if startup&&method==Some("initialize") {
            self.reduced.store(true,Ordering::SeqCst);
            rpc(id,json!({"protocolVersion":message.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("2025-11-25"),"capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"mind","title":"Mind","version":self.config.version},"instructions":format!("[{}] {} Mind lo intentará de nuevo en la próxima llamada.",error.code,error.message)}))
        }else if startup&&method==Some("tools/list") {
            self.reduced.store(true,Ordering::SeqCst);rpc(id,json!({"tools":[{"name":"estado","title":"Estado de Mind","description":"Estado del Motor y motivo por el que no pudo iniciarse.","inputSchema":{"type":"object","additionalProperties":false}}]}))
        }else if method==Some("tools/call") {let data=json!({"error":{"codigo":error.code,"mensaje":error.message}});rpc(id,json!({"isError":true,"structuredContent":data,"content":[{"type":"text","text":data.to_string()}]}))}
        else {json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":error.message,"data":{"codigo":error.code}}})};self.write(reply).await;
    }
    async fn start_relay(self:&Arc<Self>)->bool {
        let mut holder=self.relay.lock().await;
        if holder.is_some(){return true}
        if self.relay_attempted.swap(true,Ordering::SeqCst){return false}
        let Some(command)=&self.config.relaunch else{return false};
        let depth=std::env::var("MIND_BRIDGE_RELAYED").ok().and_then(|x|x.parse::<u8>().ok()).unwrap_or(0);
        if depth>=3{return false}
        let mut command=Command::new(command);
        command.args(&self.config.reargs).env("MIND_BRIDGE_RELAYED",(depth+1).to_string()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)] command.creation_flags(0x08000000);
        let Ok(mut child)=command.spawn() else{return false};
        let mut input=child.stdin.take().unwrap();
        let output=child.stdout.take().unwrap();
        let mut initial=self.init.lock().await.clone().unwrap();
        initial["id"]=json!("mind-relevo-initialize");
        if input.write_all(format!("{}\n",initial).as_bytes()).await.is_err(){let _=child.kill().await;return false}
        let (send,receive)=oneshot::channel();
        let this=self.clone();
        let pending=Arc::new(Mutex::new(HashMap::<String,Value>::new()));
        let pending_reader=pending.clone();
        tokio::spawn(async move {
            let mut send=Some(send);let mut reader=BufReader::new(output);let mut line=Vec::new();
            'reading: loop {
                line.clear();
                loop {
                    let Ok(available)=reader.fill_buf().await else{break 'reading};
                    if available.is_empty(){if line.is_empty(){break 'reading}break}
                    let count=available.iter().position(|b|*b==b'\n').map(|n|n+1).unwrap_or(available.len());
                    if line.len()+count>MAX_MESSAGE{break 'reading}
                    let ended=available[count-1]==b'\n';line.extend_from_slice(&available[..count]);reader.consume(count);if ended{break}
                }
                if let Ok(value)=serde_json::from_slice::<Value>(&line) {
                    if value.get("id")==Some(&json!("mind-relevo-initialize"))&&is_reply(&value) {
                        if let Some(sender)=send.take(){let _=sender.send(());}continue
                    }
                    if is_reply(&value){if let Some(id)=value.get("id"){pending_reader.lock().await.remove(&id.to_string());}}
                    this.write(value).await;
                }
            }
            let lost:Vec<Value>=pending_reader.lock().await.drain().map(|(_,v)|v).collect();
            for message in lost{this.error(&message,Failure{code:"MOTOR_CONNECTION_LOST",message:LOST.into(),delivered:true},false).await;}
        });
        if !timeout(Duration::from_secs(25),receive).await.is_ok_and(|r|r.is_ok()){let _=child.kill().await;return false}
        if self.initialized.load(Ordering::SeqCst){let _=input.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n").await;}
        *holder=Some(Relay{child,input,pending});
        eprintln!("Mind se actualizó: el puente cede el trabajo al programa instalado");true
    }
    async fn forward_relay(&self,message:&Value)->bool {
        let mut relay=self.relay.lock().await;
        let Some(relay)=relay.as_mut() else{return false};
        let key=request_id(message).map(Value::to_string);
        if let Some(key)=&key{relay.pending.lock().await.insert(key.clone(),message.clone());}
        if relay.input.write_all(format!("{}\n",message).as_bytes()).await.is_err(){
            if let Some(key)=key{if relay.pending.lock().await.remove(&key).is_some(){self.error(message,Failure{code:"MOTOR_CONNECTION_LOST",message:LOST.into(),delivered:true},false).await;}}
        }
        true
    }
    async fn handle(self:Arc<Self>,message:Value){
        if !message.is_object()||message.get("jsonrpc")!=Some(&json!("2.0")){self.write(rpc_error(message.get("id").cloned().unwrap_or(Value::Null),-32600,"Mensaje JSON-RPC no válido.")).await;return}
        if message.get("method").is_some() && message.get("id").is_some() && request_id(&message).is_none(){self.write(rpc_error(Value::Null,-32600,"ID debe ser texto o entero seguro.")).await;return}
        if self.forward_relay(&message).await{return}
        let method=message.get("method").and_then(Value::as_str);let id=request_id(&message).cloned();
        if method==Some("initialize")&&id.is_some(){
            *self.remote.lock().await=None;*self.init.lock().await=Some(message.clone());self.initialized.store(false,Ordering::SeqCst);
            match self.connect().await{Ok((_,mut reply))=>{reply["id"]=id.unwrap();self.write(reply).await;},Err(error)=>self.error(&message,error,true).await}return
        }
        if method==Some("notifications/initialized"){
            self.initialized.store(true,Ordering::SeqCst);let remote=self.remote.lock().await.clone();if let Some(remote)=remote{if self.initialized_remote(&remote).await.is_err(){self.invalidate(remote.generation).await;}}return
        }
        if id.is_none()||method.is_none(){let remote=self.remote.lock().await.clone();if let Some(remote)=remote{let _=self.post(&remote,&message,false).await;}return}
        if method==Some("ping"){self.write(rpc(id.unwrap(),json!({}))).await;return}
        if self.init.lock().await.is_none(){self.write(rpc_error(id.unwrap(),-32600,"La sesión no se inicializó.")).await;return}
        let mut retries=0;let mut reset_retries=0;
        loop {
            let current=self.remote.lock().await.clone();let remote=match current{Some(r)=>r,None=>match self.connect().await{
                Ok((r,_))=>r,Err(error)=>{if error.code=="BRIDGE_OUTDATED"{if self.start_relay().await{self.forward_relay(&message).await;return}continue}self.error(&message,error,true).await;return}
            }};
            match self.post(&remote,&message,false).await{
                Ok(reply)=>{
                    if [401,404,503].contains(&reply.status){self.invalidate(remote.generation).await;if retries<1{retries+=1;continue}
                        let error=if reply.status==401{Failure::new("MOTOR_UNAUTHORIZED","El Motor de Mind rechazó las credenciales locales.")}else{Failure::new("MOTOR_UNAVAILABLE","El Motor de Mind no está disponible.")};self.error(&message,error,false).await;return}
                    if let Some(body)=reply.body{if is_reply(&body){self.write(body).await;return}if let Some(array)=body.as_array(){let mut any=false;for reply in array.iter().filter(|v|is_reply(v)){self.write(reply.clone()).await;any=true}if any{return}}}
                    self.error(&message,Failure::new("MOTOR_BAD_RESPONSE","El Motor respondió sin una respuesta JSON-RPC."),false).await;return
                }
                Err(error)=>{
                    if !error.delivered {self.invalidate(remote.generation).await;if retries<1{retries+=1;continue}}
                    else if repeatable(&message)&&reset_retries<1{reset_retries+=1;continue}
                    self.error(&message,error,false).await;return
                }
            }
        }
    }
    async fn close(&self){let remote=self.remote.lock().await.take();if let Some(remote)=remote{let _=self.auth(&remote,reqwest::Method::DELETE).timeout(Duration::from_secs(2)).send().await;}
        let relay=self.relay.lock().await.take();if let Some(mut relay)=relay{let _=relay.input.shutdown().await;drop(relay.input);if timeout(Duration::from_secs(2),relay.child.wait()).await.is_err(){let _=relay.child.kill().await;}}
        self.closed.store(true,Ordering::SeqCst);
    }
}
pub async fn run(args:&[String])->std::result::Result<(),String>{
    let config=Config::parse(args)?;let client=reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).pool_max_idle_per_host(0).connect_timeout(Duration::from_secs(2)).build().map_err(|e|e.to_string())?;
    let bridge=Arc::new(Bridge{config,client,output:Mutex::new(tokio::io::stdout()),remote:Mutex::new(None),connecting:Mutex::new(()),init:Mutex::new(None),initialized:AtomicBool::new(false),had:AtomicBool::new(false),reduced:AtomicBool::new(false),closed:AtomicBool::new(false),connection:Uuid::new_v4(),relay:Mutex::new(None),relay_attempted:AtomicBool::new(false)});
    let mut tasks=JoinSet::new();let mut input=tokio::io::stdin();let mut chunk=[0u8;8192];let mut frame=Vec::new();let mut dropping=false;
    loop {
        let n=input.read(&mut chunk).await.map_err(|e|e.to_string())?;if n==0{break}
        for byte in &chunk[..n]{
            if *byte==b'\n'{
                if dropping{bridge.write(rpc_error(Value::Null,-32600,"El mensaje supera 16 MiB.")).await;dropping=false;frame.clear();continue}
                if frame.iter().all(u8::is_ascii_whitespace){frame.clear();continue}
                match serde_json::from_slice::<Value>(&frame){Ok(value)=>{
                    let messages=match value{Value::Array(items)=>items,value=>vec![value]};
                    for message in messages{let method=message.get("method").and_then(Value::as_str);let barrier=matches!(method,Some("initialize"|"notifications/initialized"));
                        if barrier{bridge.clone().handle(message).await;}else{tasks.spawn(bridge.clone().handle(message));}
                    }
                },Err(_)=>bridge.write(rpc_error(Value::Null,-32700,"JSON no válido.")).await}frame.clear();
            }else if !dropping{if frame.len()==MAX_MESSAGE{dropping=true;frame.clear();}else{frame.push(*byte);}}
        }
        while tasks.try_join_next().is_some(){}
    }
    if !frame.is_empty()&&!dropping{if let Ok(message)=serde_json::from_slice::<Value>(&frame){tasks.spawn(bridge.clone().handle(message));}}
    let _=timeout(Duration::from_secs(25),async{while tasks.join_next().await.is_some(){}}).await;tasks.abort_all();bridge.close().await;Ok(())
}



