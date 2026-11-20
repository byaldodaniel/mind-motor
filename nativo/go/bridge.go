package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptrace"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/unicode/norm"
)

const messageLimit = 16 * 1024 * 1024

type rpcMessage map[string]any
type bridgeConfig struct {
	Base, Cwd                      string
	Paths                          []string
	LaunchCommand, RelaunchCommand string
	LaunchArgs, RelaunchArgs       repeatArgs
	MotorVersion                   string
	PackageRevision                int
}
type bridgeError struct{ Code, Message string }

func (e *bridgeError) Error() string { return e.Code + ": " + e.Message }
func fail(code, msg string) error    { return &bridgeError{code, msg} }

var errRelay = errors.New("relaid to installed bridge")

type remoteState struct {
	Port             int
	Token, SessionID string
	cancel           context.CancelFunc
}
type healthState struct {
	OK              bool   `json:"ok"`
	BaseID          string `json:"baseId"`
	Port            int    `json:"port"`
	Proof           string `json:"proof"`
	MotorVersion    string `json:"motorVersion"`
	PackageRevision *int   `json:"packageRevision"`
}
type relayState struct {
	cmd         *exec.Cmd
	input       io.WriteCloser
	mu          sync.Mutex
	done        chan error
	closed      error
	pending     map[string]rpcMessage
	failPending func(rpcMessage, error)
}

func (r *relayState) send(m rpcMessage) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed != nil {
		return r.closed
	}
	key, hasID := rpcIDKey(m["id"])
	tracked := hasID && stringField(m, "method") != "" && m["id"] != "mind-relevo-initialize"
	if tracked {
		if r.pending == nil {
			r.pending = make(map[string]rpcMessage)
		}
		r.pending[key] = m
	}
	err := json.NewEncoder(r.input).Encode(m)
	if err != nil {
		if tracked {
			delete(r.pending, key)
		}
		return fail("MOTOR_CONNECTION_LOST", "Se perdió el enlace al puente instalado; no se sabe si terminó la operación. Compruébalo antes de repetirla.")
	}
	return nil
}
func (r *relayState) resolve(m rpcMessage) bool {
	key, ok := rpcIDKey(m["id"])
	if !ok || !hasRPCResult(m) {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	_, found := r.pending[key]
	if found {
		delete(r.pending, key)
	}
	return found
}
func (r *relayState) finish() {
	err := fail("MOTOR_CONNECTION_LOST", "El puente instalado terminó sin responder; no se sabe si terminó la operación. Compruébalo antes de repetirla.")
	r.mu.Lock()
	if r.closed != nil {
		r.mu.Unlock()
		return
	}
	r.closed = err
	pending := r.pending
	r.pending = nil
	r.mu.Unlock()
	for _, request := range pending {
		if r.failPending != nil {
			r.failPending(request, err)
		}
	}
}

type bridge struct {
	cfg                              bridgeConfig
	client                           *http.Client
	out                              io.Writer
	outMu                            sync.Mutex
	mu                               sync.Mutex
	connectMu                        sync.Mutex
	init                             rpcMessage
	initialReply                     rpcMessage
	initialized, reduced, hadSession bool
	remote                           *remoteState
	relay                            *relayState
	connectionID                     string
	ctx                              context.Context
	cancel                           context.CancelFunc
	work                             sync.WaitGroup
}

func newBridge(c bridgeConfig, out io.Writer) *bridge {
	ctx, cancel := context.WithCancel(context.Background())
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext}
	return &bridge{cfg: c, out: out, ctx: ctx, cancel: cancel, connectionID: newUUID(), client: &http.Client{Transport: transport, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}
}
func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func (b *bridge) emit(m rpcMessage) {
	b.outMu.Lock()
	defer b.outMu.Unlock()
	_ = json.NewEncoder(b.out).Encode(m)
}
func (b *bridge) state() *remoteState  { b.mu.Lock(); defer b.mu.Unlock(); return b.remote }
func (b *bridge) relayer() *relayState { b.mu.Lock(); defer b.mu.Unlock(); return b.relay }
func (b *bridge) invalidate(r *remoteState) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.remote == r && r != nil {
		b.remote = nil
		if r.cancel != nil {
			r.cancel()
		}
	}
}
func stringField(m rpcMessage, k string) string { s, _ := m[k].(string); return s }
func reply(m rpcMessage, result any) rpcMessage {
	return rpcMessage{"jsonrpc": "2.0", "id": m["id"], "result": result}
}
func (b *bridge) errorReply(m rpcMessage, err error, startup bool) {
	var e *bridgeError
	if !errors.As(err, &e) {
		e = &bridgeError{"ERROR_INTERNO", err.Error()}
	}
	method := stringField(m, "method")
	switch {
	case method == "initialize" && startup:
		params, _ := m["params"].(map[string]any)
		protocol, _ := params["protocolVersion"].(string)
		if protocol == "" {
			protocol = "2025-11-25"
		}
		b.mu.Lock()
		b.reduced = true
		b.mu.Unlock()
		b.emit(reply(m, map[string]any{"protocolVersion": protocol, "capabilities": map[string]any{"tools": map[string]any{"listChanged": true}}, "serverInfo": map[string]any{"name": "mind", "title": "Mind", "version": b.cfg.MotorVersion}, "instructions": "[" + e.Code + "] " + e.Message + " Mind lo intentará de nuevo en la próxima llamada."}))
	case method == "tools/list" && startup:
		b.mu.Lock()
		b.reduced = true
		b.mu.Unlock()
		b.emit(reply(m, map[string]any{"tools": []any{map[string]any{"name": "estado", "title": "Estado de Mind", "description": "Informa el estado y el motivo por el que Mind no pudo iniciarse.", "inputSchema": map[string]any{"type": "object", "additionalProperties": false}}}}))
	case method == "tools/call":
		structured := map[string]any{"error": map[string]any{"codigo": e.Code, "mensaje": e.Message}}
		raw, _ := json.Marshal(structured)
		b.emit(reply(m, map[string]any{"content": []any{map[string]any{"type": "text", "text": string(raw)}}, "structuredContent": structured, "isError": true}))
	default:
		b.emit(rpcMessage{"jsonrpc": "2.0", "id": m["id"], "error": map[string]any{"code": -32603, "message": e.Message, "data": map[string]any{"codigo": e.Code}}})
	}
}
func canonicalBase(base string) (string, error) {
	p, e := filepath.Abs(base)
	if e != nil {
		return "", e
	}
	real, e := filepath.EvalSymlinks(p)
	if e == nil {
		return real, nil
	}
	if os.IsNotExist(e) {
		return filepath.Clean(p), nil
	}
	return "", e
}
func baseID(base string) string {
	s := norm.NFC.String(filepath.Clean(base))
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		s = strings.ToLower(s)
	}
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])[:16]
}
func readJSONFile(path string, target any) error {
	f, e := openRegularNoFollow(path)
	if e != nil {
		return e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return e
	}
	if info.Size() > 64*1024 {
		return fmt.Errorf("connector file too large")
	}
	return json.NewDecoder(io.LimitReader(f, 64*1024)).Decode(target)
}
func (b *bridge) healthy() (*remoteState, *healthState, error) {
	base, e := canonicalBase(b.cfg.Base)
	if e != nil {
		return nil, nil, e
	}
	var state struct {
		Version, Port int
		BaseID        string `json:"baseId"`
	}
	var secret struct {
		Version int
		Token   string
	}
	if e := readJSONFile(filepath.Join(base, "conector.json"), &state); e != nil {
		return nil, nil, e
	}
	if state.Version != 1 || state.Port < 1 || state.Port > 65535 || state.BaseID != baseID(base) {
		return nil, nil, fmt.Errorf("connector identity mismatch")
	}
	if e := readJSONFile(filepath.Join(base, "conector-secreto.json"), &secret); e != nil {
		return nil, nil, e
	}
	if secret.Version != 1 || len(secret.Token) < 32 {
		return nil, nil, fmt.Errorf("invalid connector secret")
	}
	nonceBytes := make([]byte, 16)
	_, _ = rand.Read(nonceBytes)
	nonce := hex.EncodeToString(nonceBytes)
	ctx, cancel := context.WithTimeout(b.ctx, 800*time.Millisecond)
	defer cancel()
	request, e := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("http://127.0.0.1:%d/health?nonce=%s", state.Port, nonce), nil)
	if e != nil {
		return nil, nil, e
	}
	response, e := b.client.Do(request)
	if e != nil {
		return nil, nil, e
	}
	defer response.Body.Close()
	var h healthState
	if response.StatusCode != 200 {
		return nil, nil, fmt.Errorf("health status %d", response.StatusCode)
	}
	if e := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&h); e != nil {
		return nil, nil, e
	}
	mac := hmac.New(sha256.New, []byte(secret.Token))
	fmt.Fprintf(mac, "mind-health-v1\n%s\n%s\n%d", nonce, state.BaseID, state.Port)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !h.OK || h.BaseID != state.BaseID || h.Port != state.Port || !hmac.Equal([]byte(expected), []byte(h.Proof)) {
		return nil, nil, fmt.Errorf("health proof mismatch")
	}
	return &remoteState{Port: state.Port, Token: secret.Token}, &h, nil
}
func (b *bridge) ensureMotor() (*remoteState, *healthState, error) {
	if r, h, e := b.healthy(); e == nil {
		return r, h, nil
	}
	if b.cfg.LaunchCommand == "" {
		return nil, nil, fail("MOTOR_START_FAILED", "No hay un Motor disponible ni lanzador configurado.")
	}
	cmd := exec.Command(b.cfg.LaunchCommand, b.cfg.LaunchArgs...)
	configureChild(cmd)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = os.Stderr
	if e := cmd.Start(); e != nil {
		return nil, nil, fail("MOTOR_START_FAILED", "No se pudo iniciar el Motor: "+e.Error())
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	limit := time.NewTimer(20 * time.Second)
	defer limit.Stop()
	tick := time.NewTicker(40 * time.Millisecond)
	defer tick.Stop()
	for {
		if r, h, e := b.healthy(); e == nil {
			return r, h, nil
		}
		select {
		case <-b.ctx.Done():
			return nil, nil, b.ctx.Err()
		case <-limit.C:
			return nil, nil, fail("MOTOR_START_TIMEOUT", "El Motor no publicó su conexión a tiempo.")
		case <-done:
			if r, h, e := b.healthy(); e == nil {
				return r, h, nil
			}
			return nil, nil, fail("MOTOR_START_FAILED", "El lanzador del Motor terminó sin publicar una conexión disponible.")
		case <-tick.C:
		}
	}
}

type postResult struct {
	Status    int
	SessionID string
	Body      rpcMessage
	Answered  bool
}
type postError struct {
	err       error
	delivered bool
}

func (e *postError) Error() string { return e.err.Error() }
func (b *bridge) post(r *remoteState, m rpcMessage, workspace bool, timeout time.Duration) (postResult, error) {
	result := postResult{}
	payload, e := json.Marshal(m)
	if e != nil {
		return result, e
	}
	ctx := b.ctx
	cancel := func() {}
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, timeout)
	}
	defer cancel()
	delivered := false
	trace := &httptrace.ClientTrace{GotConn: func(_ httptrace.GotConnInfo) { delivered = true }}
	ctx = httptrace.WithClientTrace(ctx, trace)
	req, e := http.NewRequestWithContext(ctx, "POST", fmt.Sprintf("http://127.0.0.1:%d/mcp", r.Port), bytes.NewReader(payload))
	if e != nil {
		return result, e
	}
	req.Header.Set("Authorization", "Bearer "+r.Token)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if r.SessionID != "" {
		req.Header.Set("Mcp-Session-Id", r.SessionID)
	}
	if workspace {
		p, _ := json.Marshal(map[string]any{"cwd": b.cfg.Cwd, "paths": b.cfg.Paths, "conexion": b.connectionID})
		req.Header.Set("X-Mind-Workspace", base64.RawURLEncoding.EncodeToString(p))
	}
	resp, e := b.client.Do(req)
	if e != nil {
		return result, &postError{e, delivered}
	}
	defer resp.Body.Close()
	result.Status = resp.StatusCode
	result.SessionID = resp.Header.Get("Mcp-Session-Id")
	if result.SessionID == "" {
		result.SessionID = r.SessionID
	}
	if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		e = readSSE(resp.Body, func(event rpcMessage) {
			if validRPCReply(event, m) {
				result.Body = event
				result.Answered = true
			} else if stringField(event, "method") != "" && validIncomingRPC(event) {
				b.emit(event)
			}
		})
		if e != nil && !result.Answered {
			return result, &postError{e, true}
		}
		return result, nil
	}
	raw, e := io.ReadAll(io.LimitReader(resp.Body, messageLimit+1))
	if e != nil {
		return result, &postError{e, true}
	}
	if len(raw) > messageLimit {
		return result, &postError{fmt.Errorf("response too large"), true}
	}
	if len(bytes.TrimSpace(raw)) > 0 {
		if e = decodeRPC(raw, &result.Body); e != nil {
			return result, fail("MOTOR_BAD_RESPONSE", "El Motor respondió JSON no válido.")
		}
	}
	return result, nil
}
func readSSE(reader io.Reader, onMessage func(rpcMessage)) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), messageLimit)
	var data strings.Builder
	flush := func() error {
		if data.Len() == 0 {
			return nil
		}
		raw := data.String()
		data.Reset()
		var m rpcMessage
		if err := decodeRPC([]byte(raw), &m); err != nil {
			return err
		}
		onMessage(m)
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if e := flush(); e != nil {
				return e
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			part := strings.TrimPrefix(line, "data:")
			part = strings.TrimPrefix(part, " ")
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(part)
			if data.Len() > messageLimit {
				return fmt.Errorf("SSE message too large")
			}
		}
	}
	if e := scanner.Err(); e != nil {
		return e
	}
	return flush()
}
func (b *bridge) openSSE(r *remoteState) {
	ctx, cancel := context.WithCancel(b.ctx)
	b.mu.Lock()
	r.cancel = cancel
	b.mu.Unlock()
	go func() {
		req, e := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("http://127.0.0.1:%d/mcp", r.Port), nil)
		if e != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+r.Token)
		req.Header.Set("Accept", "text/event-stream")
		req.Header.Set("Mcp-Session-Id", r.SessionID)
		response, e := b.client.Do(req)
		if e != nil {
			b.invalidate(r)
			return
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			b.invalidate(r)
			return
		}
		_ = readSSE(response.Body, func(m rpcMessage) {
			if stringField(m, "method") != "" && validIncomingRPC(m) {
				b.emit(m)
			}
		})
		b.invalidate(r)
	}()
}
func (b *bridge) getRemote() (*remoteState, error) {
	if r := b.state(); r != nil {
		return r, nil
	}
	b.connectMu.Lock()
	defer b.connectMu.Unlock()
	if r := b.state(); r != nil {
		return r, nil
	}
	if b.relayer() != nil {
		return nil, errRelay
	}
	b.mu.Lock()
	init := b.init
	initialized := b.initialized
	hadSession := b.hadSession
	b.mu.Unlock()
	if init == nil {
		return nil, fail("NOT_INITIALIZED", "La sesión no se inicializó.")
	}
	for attempt := 0; attempt < 2; attempt++ {
		r, h, e := b.ensureMotor()
		if e != nil {
			return nil, e
		}
		changed := (h.MotorVersion != "" && h.MotorVersion != b.cfg.MotorVersion) || (h.PackageRevision != nil && *h.PackageRevision != b.cfg.PackageRevision)
		if hadSession && changed && b.cfg.RelaunchCommand != "" && os.Getenv("MIND_BRIDGE_RELAYED") != "1" {
			if e := b.startRelay(init, initialized); e != nil {
				return nil, e
			}
			return nil, errRelay
		}
		p, e := b.post(r, init, true, 30*time.Second)
		if e != nil {
			return nil, e
		}
		if (p.Status == 401 || p.Status == 404 || p.Status == 503) && attempt == 0 {
			continue
		}
		if p.Status != 200 || p.SessionID == "" || !validRPCReply(p.Body, init) {
			return nil, fail("MOTOR_BAD_RESPONSE", "El Motor no creó una sesión MCP válida.")
		}
		r.SessionID = p.SessionID
		b.mu.Lock()
		b.initialReply = p.Body
		b.mu.Unlock()
		if initialized {
			p, e = b.post(r, rpcMessage{"jsonrpc": "2.0", "method": "notifications/initialized"}, false, 30*time.Second)
			if e != nil {
				return nil, e
			}
			if p.Status != 202 && p.Status != 200 {
				return nil, fail("MOTOR_BAD_RESPONSE", "El Motor rechazó notifications/initialized.")
			}
		}
		b.mu.Lock()
		b.remote = r
		b.hadSession = true
		reduced := b.reduced
		b.reduced = false
		b.mu.Unlock()
		b.openSSE(r)
		if reduced {
			b.emit(rpcMessage{"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
		}
		return r, nil
	}
	return nil, fail("MOTOR_UNAVAILABLE", "El Motor no está disponible.")
}
func (b *bridge) handleInitialize(m rpcMessage) {
	b.invalidate(b.state())
	b.mu.Lock()
	b.init = m
	b.initialized = false
	b.reduced = false
	b.mu.Unlock()
	r, e := b.getRemote()
	if e != nil {
		b.errorReply(m, e, true)
		return
	}
	// Establishment already sent initialize; its response is queried from the
	// original POST rather than issuing a second initialization.
	b.mu.Lock()
	cached := b.initialReply
	b.mu.Unlock()
	if cached != nil {
		b.emit(cached)
		return
	}
	// Defensive: the connection function always records this result.
	b.errorReply(m, fail("MOTOR_BAD_RESPONSE", "Falta la respuesta de inicialización."), true)
	_ = r
}
func (b *bridge) handleInitialized() {
	b.mu.Lock()
	b.initialized = true
	b.mu.Unlock()
	if r := b.relayer(); r != nil {
		_ = r.send(rpcMessage{"jsonrpc": "2.0", "method": "notifications/initialized"})
		return
	}
	if r := b.state(); r != nil {
		p, e := b.post(r, rpcMessage{"jsonrpc": "2.0", "method": "notifications/initialized"}, false, 30*time.Second)
		if e != nil || (p.Status != 200 && p.Status != 202) {
			b.invalidate(r)
		}
	}
}

var readTools = map[string]bool{"estado": true, "buscar": true, "explorar": true, "leer": true, "eliminados": true, "continuidad_consultar": true, "conversaciones_buscar": true, "conversacion_leer": true, "conversacion_preferencias": true, "destinos_consultar": true, "actualizacion_consultar": true, "papelera": true, "propiedades": true, "indices_personalizados": true, "funciones": true, "historial_funcion": true}

func repeatable(m rpcMessage) bool {
	method := stringField(m, "method")
	if method == "tools/list" || method == "ping" || method == "initialize" {
		return true
	}
	if method != "tools/call" {
		return false
	}
	p, _ := m["params"].(map[string]any)
	name, _ := p["name"].(string)
	if name == "destino_resolver" {
		a, _ := p["arguments"].(map[string]any)
		return a["preparar"] != true
	}
	return readTools[name]
}
func (b *bridge) handleRequest(m rpcMessage) {
	if r := b.relayer(); r != nil {
		if e := r.send(m); e != nil {
			b.errorReply(m, e, false)
		}
		return
	}
	if stringField(m, "method") == "ping" {
		if r := b.state(); r != nil {
			p, e := b.post(r, m, false, 2*time.Second)
			if e == nil && p.Status == 200 && validRPCReply(p.Body, m) {
				b.emit(p.Body)
				return
			}
			b.invalidate(r)
		}
		b.emit(reply(m, map[string]any{}))
		return
	}
	rejects, networkRetries := 0, 0
	for {
		r, e := b.getRemote()
		if e == errRelay {
			if relay := b.relayer(); relay != nil {
				if sendError := relay.send(m); sendError != nil {
					b.errorReply(m, sendError, false)
				}
				return
			}
		}
		if e != nil {
			b.errorReply(m, e, true)
			return
		}
		p, e := b.post(r, m, false, 0)
		if e != nil {
			b.invalidate(r)
			var pe *postError
			knownUndelivered := errors.As(e, &pe) && !pe.delivered
			if (knownUndelivered || repeatable(m)) && networkRetries < 1 {
				networkRetries++
				continue
			}
			b.errorReply(m, fail("MOTOR_CONNECTION_LOST", "Se perdió la conexión con el Motor mientras ejecutaba la operación; no se sabe si terminó. Compruébalo antes de repetirla."), false)
			return
		}
		if p.Status == 401 || p.Status == 404 || p.Status == 503 {
			b.invalidate(r)
			if rejects < 1 {
				rejects++
				continue
			}
			code := "MOTOR_UNAVAILABLE"
			if p.Status == 401 {
				code = "MOTOR_UNAUTHORIZED"
			}
			b.errorReply(m, fail(code, "El Motor rechazó la petición después de reconectar."), false)
			return
		}
		if !validRPCReply(p.Body, m) {
			b.errorReply(m, fail("MOTOR_BAD_RESPONSE", "El Motor no devolvió una respuesta JSON-RPC."), false)
			return
		}
		b.emit(p.Body)
		return
	}
}
func (b *bridge) pass(m rpcMessage) {
	if r := b.relayer(); r != nil {
		_ = r.send(m)
		return
	}
	if r := b.state(); r != nil {
		p, e := b.post(r, m, false, 0)
		if e != nil || p.Status == 401 || p.Status == 404 || p.Status == 503 {
			b.invalidate(r)
		}
	}
}
func (b *bridge) startRelay(init rpcMessage, initialized bool) error {
	cmd := exec.Command(b.cfg.RelaunchCommand, b.cfg.RelaunchArgs...)
	configureChild(cmd)
	cmd.Env = append(os.Environ(), "MIND_BRIDGE_RELAYED=1")
	cmd.Stderr = os.Stderr
	input, e := cmd.StdinPipe()
	if e != nil {
		return e
	}
	output, e := cmd.StdoutPipe()
	if e != nil {
		return e
	}
	if e = cmd.Start(); e != nil {
		return e
	}
	relay := &relayState{cmd: cmd, input: input, done: make(chan error, 1), failPending: func(m rpcMessage, e error) { b.errorReply(m, e, false) }}
	ready := make(chan rpcMessage, 1)
	go func() {
		s := bufio.NewScanner(output)
		s.Buffer(make([]byte, 65536), messageLimit)
		for s.Scan() {
			var m rpcMessage
			if decodeRPC(s.Bytes(), &m) != nil {
				continue
			}
			if m["id"] == "mind-relevo-initialize" {
				ready <- m
			} else if stringField(m, "method") != "" && validIncomingRPC(m) {
				b.emit(m)
			} else if relay.resolve(m) {
				b.emit(m)
			}
		}
		relay.finish()
		relay.input.Close()
		relay.done <- cmd.Wait()
	}()
	hello := rpcMessage{}
	for k, v := range init {
		hello[k] = v
	}
	hello["id"] = "mind-relevo-initialize"
	if e = relay.send(hello); e != nil {
		return e
	}
	select {
	case reply := <-ready:
		if reply["error"] != nil {
			_ = cmd.Process.Kill()
			return fail("MOTOR_START_FAILED", "El puente instalado rechazó initialize.")
		}
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		return fail("MOTOR_START_TIMEOUT", "El puente instalado no respondió.")
	case e := <-relay.done:
		return fail("MOTOR_START_FAILED", fmt.Sprint(e))
	}
	if initialized {
		if err := relay.send(rpcMessage{"jsonrpc": "2.0", "method": "notifications/initialized"}); err != nil {
			return err
		}
	}
	b.mu.Lock()
	b.relay = relay
	b.mu.Unlock()
	fmt.Fprintln(os.Stderr, "Mind cede el trabajo al programa instalado.")
	return nil
}
func (b *bridge) run(input io.Reader) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 65536), messageLimit)
	for scanner.Scan() {
		raw := bytes.TrimSpace(scanner.Bytes())
		if len(raw) == 0 {
			continue
		}
		var m rpcMessage
		if e := decodeRPC(raw, &m); e != nil {
			b.emit(rpcMessage{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "JSON no válido."}})
			continue
		}
		if !validIncomingRPC(m) {
			b.invalidRequest(-32600, "JSON-RPC request ID or shape is invalid.")
			continue
		}
		method := stringField(m, "method")
		if method == "initialize" {
			b.handleInitialize(m)
			continue
		}
		if method == "notifications/initialized" {
			b.handleInitialized()
			continue
		}
		b.work.Add(1)
		go func(m rpcMessage) {
			defer b.work.Done()
			if _, hasID := m["id"]; hasID && stringField(m, "method") != "" {
				b.handleRequest(m)
			} else {
				b.pass(m)
			}
		}(m)
	}
	err := scanner.Err()
	// stdin EOF ends the client scope; no request keeps a closed bridge alive.
	b.cancel()
	b.work.Wait()
	if relay := b.relayer(); relay != nil {
		relay.input.Close()
		select {
		case <-relay.done:
		case <-time.After(2 * time.Second):
			_ = relay.cmd.Process.Kill()
		}
	}
	if r := b.state(); r != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, "DELETE", "http://127.0.0.1:"+strconv.Itoa(r.Port)+"/mcp", nil)
		req.Header.Set("Authorization", "Bearer "+r.Token)
		req.Header.Set("Mcp-Session-Id", r.SessionID)
		if res, e := b.client.Do(req); e == nil {
			res.Body.Close()
		}
	}
	return err
}

func rpcIDKey(value any) (string, bool) {
	switch v := value.(type) {
	case string:
		return "s:" + v, true
	case json.Number:
		n, ok := safeJSONInteger(string(v))
		if !ok {
			return "", false
		}
		return "n:" + strconv.FormatInt(n, 10), true
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || math.Trunc(v) != v || v < -9007199254740991 || v > 9007199254740991 {
			return "", false
		}
		return "n:" + strconv.FormatInt(int64(v), 10), true
	case int:
		return "n:" + strconv.Itoa(v), true
	}
	return "", false
}
func sameRPCID(a, b any) bool {
	x, ok := rpcIDKey(a)
	y, ok2 := rpcIDKey(b)
	return ok && ok2 && x == y
}
func hasRPCResult(m rpcMessage) bool { _, r := m["result"]; _, e := m["error"]; return r != e }
func validRPCReply(m, request rpcMessage) bool {
	return m != nil && m["jsonrpc"] == "2.0" && sameRPCID(m["id"], request["id"]) && hasRPCResult(m)
}
func decodeRPC(raw []byte, m *rpcMessage) error {
	if !json.Valid(raw) {
		return fmt.Errorf("invalid JSON")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	return dec.Decode(m)
}
func (b *bridge) invalidRequest(code int, message string) {
	b.emit(rpcMessage{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": code, "message": message}})
}
func validIncomingRPC(m rpcMessage) bool {
	if m == nil || m["jsonrpc"] != "2.0" {
		return false
	}
	method, hasMethod := m["method"]
	id, hasID := m["id"]
	if hasID {
		if _, ok := rpcIDKey(id); !ok {
			return false
		}
	}
	if hasMethod {
		text, ok := method.(string)
		return ok && text != ""
	}
	return hasID && hasRPCResult(m)
}

func safeJSONInteger(raw string) (int64, bool) {
	if len(raw) == 0 || len(raw) > 128 {
		return 0, false
	}
	sign := ""
	if raw[0] == '-' {
		sign = "-"
		raw = raw[1:]
	}
	exponent := 0
	if i := strings.IndexAny(raw, "eE"); i >= 0 {
		n, e := strconv.Atoi(raw[i+1:])
		if e != nil || n < -1000 || n > 1000 {
			return 0, false
		}
		exponent = n
		raw = raw[:i]
	}
	fraction := 0
	if i := strings.IndexByte(raw, '.'); i >= 0 {
		fraction = len(raw) - i - 1
		raw = raw[:i] + raw[i+1:]
	}
	digits := strings.TrimLeft(raw, "0")
	if digits == "" {
		return 0, true
	}
	scale := exponent - fraction
	if scale < 0 {
		cut := -scale
		if cut >= len(digits) {
			return 0, false
		}
		for _, c := range digits[len(digits)-cut:] {
			if c != '0' {
				return 0, false
			}
		}
		digits = digits[:len(digits)-cut]
	} else if scale > 0 {
		if len(digits)+scale > 16 {
			return 0, false
		}
		digits += strings.Repeat("0", scale)
	}
	if len(digits) > 16 {
		return 0, false
	}
	n, e := strconv.ParseInt(sign+digits, 10, 64)
	return n, e == nil && n >= -9007199254740991 && n <= 9007199254740991
}
