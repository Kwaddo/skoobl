package router

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"skoobl/internal/hub"
)

func TestHostsOf(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{"empty returns nil", nil, nil},
		{"strips http scheme", []string{"http://localhost:5173"}, []string{"localhost:5173"}},
		{"strips https scheme", []string{"https://a.com"}, []string{"a.com"}},
		{"bare host unchanged", []string{"a.com"}, []string{"a.com"}},
		{"multiple", []string{"http://x.com", "https://y.com"}, []string{"x.com", "y.com"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := hostsOf(tc.in); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("hostsOf(%v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// reqWithOrigin issues a request through the built router and returns the
// Access-Control-Allow-Origin header the router set (empty if none).
func allowOriginHeader(t *testing.T, allowed []string, origin string) string {
	t.Helper()
	h := New(hub.New(), allowed)
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Header().Get("Access-Control-Allow-Origin")
}

func TestCORSEmptyListIsNoOp(t *testing.T) {
	if got := allowOriginHeader(t, nil, "http://evil.test"); got != "" {
		t.Fatalf("empty allowlist set CORS header %q, want none", got)
	}
}

func TestCORSReflectsAllowedOrigin(t *testing.T) {
	allowed := []string{"http://localhost:5173"}
	if got := allowOriginHeader(t, allowed, "http://localhost:5173"); got != "http://localhost:5173" {
		t.Fatalf("allowed origin not reflected: got %q", got)
	}
}

func TestCORSRejectsDisallowedOrigin(t *testing.T) {
	allowed := []string{"http://localhost:5173"}
	if got := allowOriginHeader(t, allowed, "http://evil.test"); got != "" {
		t.Fatalf("disallowed origin reflected: got %q", got)
	}
}

func TestCORSExactMatchNoSubstringBypass(t *testing.T) {
	allowed := []string{"http://localhost:5173"}
	// A crafted origin that contains the allowed value as a substring must not match.
	if got := allowOriginHeader(t, allowed, "http://localhost:5173.evil.test"); got != "" {
		t.Fatalf("substring origin bypassed allowlist: got %q", got)
	}
}

func TestOptionsReturns204(t *testing.T) {
	h := New(hub.New(), nil)
	req := httptest.NewRequest(http.MethodOptions, "/games", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS status = %d, want 204", rec.Code)
	}
}
