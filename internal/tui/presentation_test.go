package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestSessionContextIsShortAndRecognizable(t *testing.T) {
	t.Parallel()

	cases := []struct{ label, cwd, id, want string }{
		{"Fix blocker tracking", "/Users/joshlane/src/octo-manager", "01a1c358-7438-7c03-beaf-63e133fc5950", "Fix blocker tracking"},
		{"", "/Users/joshlane/src/octo-manager", "opaque", "…/src/octo-manager"},
		{"/Users/joshlane/src/octo-manager", "", "opaque", "…/src/octo-manager"},
		{"", "", "01a1c358-7438-7c03-beaf-63e133fc5950", "session 01a1c358"},
		{"", "/", "opaque", "/"},
		{"", "", "", "Unknown session"},
	}
	for _, c := range cases {
		if got := sessionContext(c.label, c.cwd, c.id); got != c.want {
			t.Errorf("session context = %q, want %q", got, c.want)
		}
	}

	if got := sessionContext(strings.Repeat("界", 80), "", "opaque"); ansi.StringWidth(got) > 48 {
		t.Fatal("topic exceeds its display bound")
	}
}
