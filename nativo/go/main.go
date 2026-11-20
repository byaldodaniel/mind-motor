package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"

	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

type repeatArgs []string

func (a *repeatArgs) String() string     { return strings.Join(*a, " ") }
func (a *repeatArgs) Set(v string) error { *a = append(*a, v); return nil }

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: mind-native-go bridge|scan")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "scan":
		if err := runScan(os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "bridge":
		fs := flag.NewFlagSet("bridge", flag.ExitOnError)
		c := bridgeConfig{}
		paths := "[]"
		fs.StringVar(&c.Base, "base", "", "isolated Base directory")
		fs.StringVar(&c.Cwd, "cwd", "", "client working directory")
		fs.StringVar(&paths, "paths", "[]", "JSON array of workspace roots")
		fs.StringVar(&c.LaunchCommand, "launch-command", "", "explicit motor launcher")
		fs.Var(&c.LaunchArgs, "launch-arg", "launcher argument; repeat")
		fs.StringVar(&c.RelaunchCommand, "relaunch-command", "", "installed bridge launcher")
		fs.Var(&c.RelaunchArgs, "relaunch-arg", "relauncher argument; repeat")
		fs.StringVar(&c.MotorVersion, "motor-version", "1.0.4", "expected motor version")
		fs.IntVar(&c.PackageRevision, "package-revision", 2, "expected package revision")
		fs.Parse(os.Args[2:])
		if c.Base == "" || !filepath.IsAbs(c.Base) {
			fmt.Fprintln(os.Stderr, "--base must be absolute")
			os.Exit(2)
		}
		if c.Cwd == "" {
			c.Cwd, _ = os.Getwd()
		}
		if err := json.Unmarshal([]byte(paths), &c.Paths); err != nil {
			fmt.Fprintln(os.Stderr, "invalid --paths JSON")
			os.Exit(2)
		}
		b := newBridge(c, os.Stdout)
		if err := b.run(os.Stdin); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown command")
		os.Exit(2)
	}
}

type scanRequest struct {
	ID         json.RawMessage `json:"id"`
	Root       string          `json:"root"`
	Relative   string          `json:"relative,omitempty"`
	MaxEntries *int            `json:"maxEntries,omitempty"`
}
type scanEntry struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Size     *int64 `json:"size,omitempty"`
	Identity string `json:"identity,omitempty"`
	Error    string `json:"error,omitempty"`
}
type scanFailure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type scanResponse struct {
	ID       json.RawMessage `json:"id"`
	Entries  []scanEntry     `json:"entries"`
	Complete bool            `json:"complete"`
	Error    *scanFailure    `json:"error,omitempty"`
}

func validateRelative(raw string) ([]string, error) {
	if raw == "" {
		return nil, nil
	}
	if strings.ContainsAny(raw, "\\:\x00") || strings.HasPrefix(raw, "/") {
		return nil, fmt.Errorf("INVALID_RELATIVE")
	}
	out := strings.Split(raw, "/")
	for _, p := range out {
		if p == "" || p == "." || p == ".." {
			return nil, fmt.Errorf("INVALID_RELATIVE")
		}
	}
	return out, nil
}
func validScanID(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil {
		return false
	}
	switch v := value.(type) {
	case string:
		return len(v) > 0 && utf8.RuneCountInString(v) <= 128
	case json.Number:
		n, ok := safeJSONInteger(string(v))
		return ok && n >= 0
	}
	return false
}
func runScan(input io.Reader, output io.Writer) error {
	s := bufio.NewScanner(input)
	s.Buffer(make([]byte, 65536), messageLimit)
	for s.Scan() {
		var req scanRequest
		response := scanResponse{ID: json.RawMessage("null"), Entries: []scanEntry{}}
		decoder := json.NewDecoder(bytes.NewReader(s.Bytes()))
		decoder.DisallowUnknownFields()
		if !utf8.Valid(s.Bytes()) || !json.Valid(s.Bytes()) {
			response.Error = &scanFailure{"INVALID_JSON", "Input must be valid UTF-8"}
		} else if err := decoder.Decode(&req); err != nil {
			response.Error = &scanFailure{"INVALID_JSON", err.Error()}
		} else if !validScanID(req.ID) {
			response.Error = &scanFailure{"INVALID_REQUEST", "id must be a nonempty string of <=128 characters or a safe nonnegative integer"}
		} else {
			response.ID = req.ID
			parts, err := validateRelative(req.Relative)
			maxEntries := 100000
			if req.MaxEntries != nil {
				maxEntries = *req.MaxEntries
			}
			var raw map[string]json.RawMessage
			_ = json.Unmarshal(s.Bytes(), &raw)
			if value, ok := raw["relative"]; ok && string(value) == "null" {
				err = fmt.Errorf("INVALID_RELATIVE")
			}
			if value, ok := raw["maxEntries"]; ok && string(value) == "null" {
				err = fmt.Errorf("INVALID_LIMIT")
			}
			if err == nil && (maxEntries < 1 || maxEntries > 1000000) {
				err = fmt.Errorf("INVALID_LIMIT")
			}
			if err == nil {
				response.Entries, response.Complete, err = scanDirectory(req.Root, parts, maxEntries)
			}
			if response.Entries == nil {
				response.Entries = []scanEntry{}
			}
			if err != nil {
				response.Complete = false
				response.Error = &scanFailure{scanErrorCode(err), err.Error()}
			}
		}
		payload, err := json.Marshal(response)
		if err != nil {
			return err
		}
		if len(payload) > messageLimit {
			response.Entries = []scanEntry{}
			response.Complete = false
			response.Error = &scanFailure{"RESPONSE_TOO_LARGE", "Directory response exceeds the frame limit; reduce maxEntries"}
			payload, _ = json.Marshal(response)
		}
		payload = append(payload, '\n')
		if _, err := output.Write(payload); err != nil {
			return err
		}
	}
	return s.Err()
}
func scanErrorCode(err error) string {
	msg := err.Error()
	for _, code := range []string{"INVALID_RELATIVE", "INVALID_ROOT", "INVALID_LIMIT", "SAFE_SCAN_UNAVAILABLE", "REPARSE_POINT", "SCOPE_CHANGED", "NAME_NOT_UTF8"} {
		if strings.Contains(msg, code) {
			return code
		}
	}
	if os.IsNotExist(err) {
		return "ENOENT"
	}
	if os.IsPermission(err) {
		return "EACCES"
	}
	return "SCAN_FAILED"
}
