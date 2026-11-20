package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestScannerUnicodeLimitsAndRecovery(t *testing.T) {
	root := t.TempDir()
	if e := os.Mkdir(filepath.Join(root, "sub"), 0700); e != nil {
		t.Fatal(e)
	}
	name := "日本語 Jose\u0301.txt"
	if e := os.WriteFile(filepath.Join(root, name), []byte("12345"), 0600); e != nil {
		t.Fatal(e)
	}
	entries, complete, e := scanDirectory(root, nil, 100)
	if e != nil || !complete {
		t.Fatalf("scan: %v complete=%v", e, complete)
	}
	found := false
	for _, v := range entries {
		if v.Name == name {
			found = true
			if v.Size == nil || *v.Size != 5 {
				t.Fatal("wrong size")
			}
		}
	}
	if !found {
		t.Fatal("Unicode entry lost")
	}
	limited, complete, e := scanDirectory(root, nil, 1)
	if e != nil || complete || len(limited) != 1 {
		t.Fatalf("limit: %v %v %d", e, complete, len(limited))
	}
	empty, complete, e := scanDirectory(root, []string{"sub"}, 100)
	if e != nil || !complete || len(empty) != 0 {
		t.Fatalf("empty: %v %v %#v", e, complete, empty)
	}
	var input bytes.Buffer
	enc := json.NewEncoder(&input)
	enc.Encode(map[string]any{"id": 1, "root": root, "relative": "../escape"})
	enc.Encode(map[string]any{"id": 2, "root": root})
	var output bytes.Buffer
	if e := runScan(&input, &output); e != nil {
		t.Fatal(e)
	}
	dec := json.NewDecoder(&output)
	var first, second scanResponse
	if e := dec.Decode(&first); e != nil {
		t.Fatal(e)
	}
	if e := dec.Decode(&second); e != nil {
		t.Fatal(e)
	}
	if first.Error == nil || second.Error != nil || !second.Complete {
		t.Fatalf("recovery %#v %#v", first, second)
	}
}
func TestScannerRejectsSymlinkTraversal(t *testing.T) {
	fixture := t.TempDir()
	root := filepath.Join(fixture, "root")
	outside := filepath.Join(fixture, "outside")
	os.Mkdir(root, 0700)
	os.Mkdir(outside, 0700)
	os.WriteFile(filepath.Join(outside, "SECRET"), []byte("secret"), 0600)
	if e := os.Symlink(outside, filepath.Join(root, "jump")); e != nil {
		t.Skipf("symlink unavailable: %v", e)
	}
	if _, _, e := scanDirectory(root, []string{"jump"}, 100); e == nil {
		t.Fatal("followed child symlink")
	}
	if _, _, e := scanDirectory(filepath.Join(root, "jump"), nil, 100); e == nil {
		t.Fatal("followed root symlink")
	}
	entries, complete, e := scanDirectory(root, nil, 100)
	if e != nil || !complete {
		t.Fatalf("parent: %v %v", e, complete)
	}
	for _, entry := range entries {
		if entry.Name == "SECRET" {
			t.Fatal("escaped root")
		}
		if entry.Name == "jump" && entry.Type != "link" {
			t.Fatal("wrong link type")
		}
	}
}
func TestRelativeRejectsEscapes(t *testing.T) {
	for _, v := range []string{"../out", "/out", "sub/../out", "sub//x", "sub/", "a\\b", "C:x", "."} {
		if _, e := validateRelative(v); e == nil {
			t.Errorf("accepted %q", v)
		}
	}
}
func TestSSEMultilineAndBounds(t *testing.T) {
	var got []rpcMessage
	data := ": ping\n\ndata: {\"jsonrpc\":\"2.0\",\ndata: \"id\":1,\"result\":{}}\n\n"
	if e := readSSE(bytes.NewBufferString(data), func(m rpcMessage) { got = append(got, m) }); e != nil {
		t.Fatal(e)
	}
	if len(got) != 1 || !sameRPCID(got[0]["id"], float64(1)) {
		t.Fatalf("messages %#v", got)
	}
}
func TestReadRetryClassification(t *testing.T) {
	read := rpcMessage{"method": "tools/call", "params": map[string]any{"name": "buscar"}}
	write := rpcMessage{"method": "tools/call", "params": map[string]any{"name": "crear"}}
	if !repeatable(read) || repeatable(write) {
		t.Fatal("unsafe retry classification")
	}
}

func TestMain(m *testing.M) {
	if os.Getenv("MIND_TEST_RELAY_EXIT") == "1" {
		runRelayExitFixture()
		return
	}
	cwd, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	temp := filepath.Join(cwd, ".cache", "test-temp")
	if err = os.MkdirAll(temp, 0700); err != nil {
		panic(err)
	}
	for _, key := range []string{"TMP", "TEMP", "TMPDIR"} {
		os.Setenv(key, temp)
	}
	os.Exit(m.Run())
}

func TestConnectorReadsThroughHeldNonLinkHandle(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "conector.json")
	if e := os.WriteFile(file, []byte("{\"version\":1}"), 0600); e != nil {
		t.Fatal(e)
	}
	var value map[string]any
	if e := readJSONFile(file, &value); e != nil {
		t.Fatal(e)
	}
	if value["version"] != float64(1) {
		t.Fatal(value)
	}
	link := filepath.Join(root, "secret-link.json")
	if e := os.Symlink(file, link); e != nil {
		t.Skipf("symlink unavailable: %v", e)
	}
	if e := readJSONFile(link, &value); e == nil {
		t.Fatal("followed connector symlink")
	}
	parent := filepath.Join(root, "parent-link")
	if e := os.Symlink(root, parent); e != nil {
		t.Skipf("directory symlink unavailable: %v", e)
	}
	if e := readJSONFile(filepath.Join(parent, "conector.json"), &value); e == nil {
		t.Fatal("followed parent symlink")
	}
}

func TestScanRejectsInvalidIDsAndLimits(t *testing.T) {
	root := t.TempDir()
	for _, req := range []map[string]any{
		{"id": nil, "root": root}, {"id": map[string]any{}, "root": root},
		{"id": 1, "root": root, "maxEntries": 0}, {"id": 1, "root": root, "maxEntries": 1000001},
		{"id": 1, "root": root, "maxEntries": nil}, {"id": 1, "root": root, "relative": nil},
	} {
		raw, _ := json.Marshal(req)
		var out bytes.Buffer
		if e := runScan(bytes.NewBuffer(append(raw, '\n')), &out); e != nil {
			t.Fatal(e)
		}
		var response scanResponse
		if e := json.Unmarshal(out.Bytes(), &response); e != nil {
			t.Fatal(e)
		}
		if response.Error == nil || response.Complete {
			t.Fatalf("accepted %#v", req)
		}
	}
}
func TestRPCIDsAreScalarAndSafe(t *testing.T) {
	for _, id := range []any{nil, map[string]any{}, []any{1}, json.Number("9007199254740992"), json.Number("1.1")} {
		if validIncomingRPC(rpcMessage{"jsonrpc": "2.0", "id": id, "method": "ping"}) {
			t.Fatalf("accepted id %#v", id)
		}
	}
	for _, id := range []any{"request", json.Number("-3"), json.Number("9007199254740991")} {
		if !validIncomingRPC(rpcMessage{"jsonrpc": "2.0", "id": id, "method": "ping"}) {
			t.Fatalf("rejected id %#v", id)
		}
	}
	if sameRPCID(map[string]any{}, []any{}) {
		t.Fatal("uncomparable id matched")
	}
	if validRPCReply(rpcMessage{"jsonrpc": "2.0", "id": json.Number("2"), "result": nil}, rpcMessage{"id": json.Number("1")}) {
		t.Fatal("mismatched ID accepted")
	}
}
func TestExactNumericIDs(t *testing.T) {
	for _, raw := range []string{"9007199254740991.1", "9007199254740992", "-9007199254740992", "1.00000000000000000001", "1e99999999"} {
		if _, ok := safeJSONInteger(raw); ok {
			t.Errorf("accepted fractional or unsafe id %s", raw)
		}
	}
	for raw, want := range map[string]int64{"1e0": 1, "1.0": 1, "0.0001e4": 1, "9007199254740991": 9007199254740991, "-3": -3} {
		if got, ok := safeJSONInteger(raw); !ok || got != want {
			t.Errorf("%s got %d valid %v", raw, got, ok)
		}
	}
}

type relayCapture struct{ messages chan []byte }

func (w relayCapture) Write(p []byte) (int, error) {
	copyOf := append([]byte(nil), p...)
	w.messages <- copyOf
	return len(p), nil
}

func runRelayExitFixture() {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var m rpcMessage
		if decodeRPC(scanner.Bytes(), &m) != nil {
			os.Exit(2)
		}
		if stringField(m, "method") == "initialize" {
			json.NewEncoder(os.Stdout).Encode(reply(m, map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{}, "serverInfo": map[string]any{"name": "relay-fixture"}}))
		} else if stringField(m, "method") == "tools/call" {
			os.Exit(3)
		}
	}
	os.Exit(0)
}
func TestRelayExitAnswersPendingWrite(t *testing.T) {
	t.Setenv("MIND_TEST_RELAY_EXIT", "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	output := relayCapture{messages: make(chan []byte, 4)}
	b := newBridge(bridgeConfig{RelaunchCommand: executable}, output)
	defer b.cancel()
	init := rpcMessage{"jsonrpc": "2.0", "id": json.Number("1"), "method": "initialize", "params": map[string]any{"protocolVersion": "2025-11-25"}}
	if err = b.startRelay(init, true); err != nil {
		t.Fatal(err)
	}
	request := rpcMessage{"jsonrpc": "2.0", "id": json.Number("2"), "method": "tools/call", "params": map[string]any{"name": "crear"}}
	b.handleRequest(request)
	select {
	case raw := <-output.messages:
		var response rpcMessage
		if err = decodeRPC(raw, &response); err != nil {
			t.Fatal(err)
		}
		if !sameRPCID(response["id"], request["id"]) {
			t.Fatal("wrong request ID")
		}
		result, _ := response["result"].(map[string]any)
		if result["isError"] != true {
			t.Fatalf("missing tool error: %s", raw)
		}
		structured, _ := result["structuredContent"].(map[string]any)
		failure, _ := structured["error"].(map[string]any)
		if failure["codigo"] != "MOTOR_CONNECTION_LOST" {
			t.Fatalf("wrong error: %s", raw)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("relay exit left request unanswered")
	}
	select {
	case raw := <-output.messages:
		t.Fatalf("duplicate reply: %s", raw)
	case <-time.After(40 * time.Millisecond):
	}
	relay := b.relayer()
	select {
	case <-relay.done:
	case <-time.After(2 * time.Second):
		relay.cmd.Process.Kill()
		t.Fatal("relay did not exit")
	}
}
