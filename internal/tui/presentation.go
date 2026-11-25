package tui

import (
	"encoding/hex"
	"errors"
	"net/url"
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/text"
)

func (m *Model) field(label, value string) string {
	return m.theme.Subtle().Render(label+": ") + text.Label(text.Inline(safe(value)), m.theme)
}
func (m *Model) muted(value string) string { return m.theme.Subtle().Render(safe(value)) }
func webLink(value string) (text.Link, error) {
	parsed, err := url.Parse(safe(value))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return text.Link{}, errors.New("link must use HTTPS without credentials")
	}

	label := parsed.Host + parsed.EscapedPath()
	if _, prLabel := parsePRURL(value); prLabel != "" {
		label = prLabel
	} else if parsed.Host == "github.com" {
		parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
		if len(parts) == 4 && parts[2] == "commit" && validCommit(parts[3]) {
			label = parts[0] + "/" + parts[1] + "@" + parts[3][:8]
		}

		if len(parts) == 4 && parts[2] == "issues" {
			label = parts[0] + "/" + parts[1] + "#" + parts[3]
		}

		if len(parts) >= 5 && parts[2] == "actions" && parts[3] == "runs" {
			label = parts[0] + "/" + parts[1] + " · check run " + parts[4]
		}
	}

	link, err := text.NewWebLink(ansi.Truncate(text.Inline(safe(label)), 80, "…"), value)
	link.Presentation = text.LabelOnly

	return link, err
}

func (m *Model) link(value string) string {
	link, err := webLink(value)
	if err != nil {
		return m.muted("Link unavailable")
	}

	view, err := link.View(m.theme)
	if err != nil {
		return m.muted("Link unavailable")
	}

	return view
}

func validCommit(sha string) bool {
	if len(sha) != 40 && len(sha) != 64 {
		return false
	}

	_, err := hex.DecodeString(sha)

	return err == nil
}

func (m *Model) commitLink(prURL, sha string) string {
	address, _ := parsePRURL(prURL)

	if !validCommit(sha) {
		return m.muted("unavailable")
	}

	if address == "" {
		return text.Label(sha[:8]+" (repository unavailable)", m.theme)
	}

	return m.link(strings.Split(address, "/pull/")[0] + "/commit/" + sha)
}

func (m *Model) commitField(label, prURL, sha string) string {
	return m.muted(label+": ") + m.commitLink(prURL, sha)
}

func stateName(value, prefix string) string {
	return strings.ToLower(strings.TrimPrefix(value, prefix))
}

func sessionContext(label, cwd, id string) string {
	if value := strings.TrimSpace(safe(label)); value != "" {
		if strings.HasPrefix(value, "/") {
			return compactDirectory(value)
		}

		return ansi.Truncate(value, 48, "…")
	}

	if value := strings.TrimSpace(safe(cwd)); value != "" {
		return compactDirectory(value)
	}

	if value := safe(id); value != "" {
		return "session " + ansi.Truncate(value, 8, "")
	}

	return "Unknown session"
}

func compactDirectory(value string) string {
	parts := strings.Split(strings.TrimRight(value, "/"), "/")
	if len(parts) > 2 {
		value = "…/" + strings.Join(parts[len(parts)-2:], "/")
	}

	if value == "" {
		value = "/"
	}

	return ansi.Truncate(value, 48, "…")
}
