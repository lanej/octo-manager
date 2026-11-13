package tui

import (
	"image/color"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func usageExample() *v1.GitHubReadUsage {
	at := time.Date(2026, time.November, 13, 1, 30, 0, 0, time.UTC).UnixMilli()

	usage := &v1.GitHubReadUsage{
		StartedAtMs: at - 30*60000, SampledAtMs: at, Requests: 205, CacheReuses: 60, RateLimits: 1,
		Rest:    &v1.GitHubRateBudget{Limit: 5000, Remaining: 4200, ResetAtMs: at + 600000, ObservedAtMs: at - 1000},
		Graphql: &v1.GitHubRateBudget{Limit: 5000, Remaining: 4900, ResetAtMs: at + 1200000, ObservedAtMs: at - 2000},
	}
	for i := range 30 {
		usage.Minutes = append(usage.Minutes, &v1.GitHubReadMinute{StartedAtMs: usage.GetStartedAtMs() + int64(i)*60000, Rest: uint64(3 + i%7), Graphql: uint64(i % 3), CacheReuses: uint64(i % 5)})
	}

	return usage
}

func TestGitHubViewKeepsQuotaTrafficAndUncertaintyDistinct(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.snapshot.GithubUsage = usageExample()
	m.Update(tea.KeyPressMsg{Code: '6', Text: "6"})
	m.Resize(layout.Size{Width: 132, Height: 42})

	content := ansi.Strip(m.githubContent(124))
	for _, value := range []string{"4200 / 5000 remaining", "84.0%", "4900 / 5000 remaining", "Shared authentication budget", "GraphQL uses points", "205 attempts", "60 cache reuses", "current minute is partial", "REST attempts", "GraphQL attempts"} {
		if !strings.Contains(content, value) {
			t.Fatalf("missing %q in %s", value, content)
		}
	}

	if m.geometry().split || m.geometry().activity != 0 {
		t.Fatal("global usage view includes per-job panes")
	}

	m.snapshot.GithubUsage.Rest.Remaining = 0

	m.snapshot.GithubUsage.RestRetryAtMs = m.snapshot.GetGithubUsage().GetSampledAtMs() + 90000
	if content = ansi.Strip(m.githubContent(124)); !strings.Contains(content, "reads paused") || !strings.Contains(content, "0 / 5000 remaining") {
		t.Fatal("quota exhaustion hidden")
	}

	m.snapshot.GithubUsage.Rest.ResetAtMs = 1
	if content = ansi.Strip(m.githubContent(124)); !strings.Contains(content, "Reset time passed") || !strings.Contains(content, "Last quota observation") {
		t.Fatal("expired budget was promoted to fresh capacity")
	}

	m.snapshot.GithubUsage.Rest = nil
	if !strings.Contains(ansi.Strip(m.githubContent(124)), "Quota not observed yet") {
		t.Fatal("missing quota became zero")
	}

	m.snapshot.GithubUsage = nil
	if !strings.Contains(ansi.Strip(m.githubContent(124)), "Usage metrics unavailable") {
		t.Fatal("older coordinator compatibility missing")
	}
}

func TestRequestSeriesPreservesCountsAndMinuteTimes(t *testing.T) {
	t.Parallel()

	minutes := []*v1.GitHubReadMinute{
		{StartedAtMs: 120000, Rest: 7, Graphql: 2, CacheReuses: 4},
		{StartedAtMs: 180000, Rest: 3, Graphql: 0, CacheReuses: 1},
	}

	series, peak := requestSeries(minutes)
	if peak != 7 || len(series) != 3 {
		t.Fatal("incorrect chart range or series")
	}

	expected := [3][2]float64{{7, 3}, {2, 0}, {4, 1}}
	for i, values := range expected {
		if len(series[i].Points) != 2 || series[i].Points[0].Value != values[0] || series[i].Points[1].Value != values[1] ||
			series[i].Points[0].Time.UnixMilli() != 120000 || series[i].Points[1].Time.UnixMilli() != 180000 {
			t.Fatal("chart changed supplied count or observation time")
		}
	}
}

func TestGitHubViewFitsAndKeepsScrollAcrossRefresh(t *testing.T) {
	t.Parallel()

	for _, mode := range []theme.Mode{theme.Dark, theme.Light, theme.Contrast, theme.Mono} {
		m := model(t, mode)
		m.snapshot.GithubUsage = usageExample()
		m.panel = githubPanel

		for _, size := range []layout.Size{{Width: 132, Height: 42}, {Width: 80, Height: 24}, {Width: 40, Height: 12}} {
			m.Resize(size)
			view := m.View()

			lines := strings.Split(view, "\n")
			if len(lines) != size.Height {
				t.Fatalf("wrong rows for %v", size)
			}

			for _, line := range lines {
				if ansi.StringWidth(line) > size.Width {
					t.Fatalf("usage line exceeds %v", size)
				}
			}
		}

		m.Resize(layout.Size{Width: 80, Height: 24})
		m.Update(tea.KeyPressMsg{Code: 'j', Text: "j"})

		if m.result.YOffset() == 0 {
			t.Fatal("usage does not scroll")
		}

		offset := m.result.YOffset()
		m.Update(snapshotMsg{snapshot: m.snapshot})

		if m.result.YOffset() != offset {
			t.Fatal("metrics refresh moved scroll")
		}
	}
}

func TestTerminalThemeAdaptsWithoutReplacingCharmedOrLosingScroll(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.FollowTerminalTheme()
	m.snapshot.GithubUsage = usageExample()
	m.panel = githubPanel
	m.Resize(layout.Size{Width: 80, Height: 24})
	m.result.ScrollDown(3)
	offset := m.result.YOffset()
	background := color.RGBA{R: 0x2e, G: 0x34, B: 0x40, A: 0xff}
	foreground := color.RGBA{R: 0xd8, G: 0xde, B: 0xe9, A: 0xff}
	m.Update(tea.ForegroundColorMsg{Color: foreground})
	m.Update(tea.BackgroundColorMsg{Color: background})

	if m.theme.Background != background || m.theme.Surface != background || m.theme.Foreground != foreground {
		t.Fatal("terminal colors not retained")
	}

	if m.theme.Accent != theme.New(theme.Dark).Accent || m.result.YOffset() != offset {
		t.Fatal("terminal adaptation replaced Charmed colors or user scroll")
	}

	m.Update(tea.BackgroundColorMsg{Color: color.White})

	if m.theme.Mode != theme.Light || m.theme.Accent != theme.New(theme.Light).Accent {
		t.Fatal("light terminal did not select readable Charmed semantics")
	}

	fixed := model(t, theme.Contrast)
	prior := fixed.theme.Background
	fixed.Update(tea.BackgroundColorMsg{Color: background})

	if fixed.theme.Background != prior {
		t.Fatal("explicit theme was overridden")
	}
}
