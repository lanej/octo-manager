package tui

import (
	"errors"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func prJob(id, address string) *v1.Job {
	return &v1.Job{Id: id, Task: &v1.Task{Kind: &v1.Task_SummarizePullRequest{SummarizePullRequest: &v1.SummarizePullRequestTask{Url: address}}}, Status: v1.JobStatus_JOB_STATUS_SUCCEEDED, ResultMarkdown: new("A completed summary.")}
}

func TestPRNavigationGroupsRunsAndKeepsDemoDistinct(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	demo := m.snapshot.Jobs[0]
	first := prJob("first", "https://github.com/LaneJ/Charmed/pull/21/")
	latest := prJob("latest", "https://github.com/lanej/charmed/pull/21")
	other := prJob("other", "https://github.com/lanej/dotfiles/pull/211")
	m.snapshot.Jobs = []*v1.Job{demo, first, other, latest}
	m.selected = ""
	m.ensureSelection()
	m.Resize(layout.Size{Width: 132, Height: 40})

	if m.selected != "latest" {
		t.Fatal("default did not select latest run of first PR")
	}

	items := m.subjects()
	if len(items) != 3 || len(items[0].jobs) != 2 || items[2].url != "" {
		t.Fatal("PR runs not grouped or demo presented as PR")
	}

	view := m.View()
	if !strings.Contains(view, "https://github.com/lanej/charmed/pull/21") || !strings.Contains(view, "Run 2/2") || !strings.Contains(view, "lanej/charmed#21") || strings.Contains(view, "latest") {
		t.Fatal("PR identity and run history not visible")
	}

	m.Update(tea.KeyPressMsg{Code: 'h', Text: "h"})

	if m.selected != "first" {
		t.Fatal("cannot inspect prior run")
	}

	m.ensureSelection()

	if m.selected != "first" {
		t.Fatal("refresh replaced selected historical run")
	}

	m.Update(tea.KeyPressMsg{Code: 'j', Text: "j"})

	if m.selected != "other" {
		t.Fatal("PR navigation visited a duplicate run")
	}

	m.Update(tea.KeyPressMsg{Code: 'j', Text: "j"})

	if m.selected != demo.GetId() {
		t.Fatal("demo is inaccessible")
	}

	if m.openPullRequest() != nil || m.commandError == "" {
		t.Fatal("demo attempted browser open")
	}

	m.Update(browserMsg{err: errors.New("opener unavailable")})

	if !strings.Contains(m.commandError, "opener unavailable") {
		t.Fatal("browser failure hidden")
	}

	m.Update(browserMsg{})

	if m.commandError != "" {
		t.Fatal("browser failure not cleared on success")
	}
}

func TestBrowserTargetsOnlyCanonicalGitHubPRURLs(t *testing.T) {
	t.Parallel()

	for _, address := range []string{"file:///tmp/example", "https://evil.example/a/b/pull/1", "https://github.com@evil.example/a/b/pull/1", "https://github.com/a/b/pull/1?next=evil", "https://github.com/a/%0ab/pull/1", "https://github.com/a/../pull/1", "https://github.com/a/b/issues/1"} {
		if _, err := browserCommand(t.Context(), "darwin", address); err == nil {
			t.Fatal("browser command accepted an unsafe target")
		}

		if got, _ := pullRequest(prJob("bad", address)); got != "" {
			t.Fatalf("unsafe browser target accepted: %q", address)
		}
	}

	address, _ := pullRequest(prJob("valid", "https://github.com/LaneJ/Charmed/pull/21/"))
	for _, platform := range []string{"darwin", "linux"} {
		command, err := browserCommand(t.Context(), platform, address)
		if err != nil {
			t.Fatal(err)
		}

		expected := "open"
		if platform == "linux" {
			expected = "xdg-open"
		}

		if len(command.Args) != 2 || command.Args[0] != expected || command.Args[1] != "https://github.com/lanej/charmed/pull/21" {
			t.Fatalf("wrong opener arguments: %q", command.Args)
		}
	}

	if _, err := browserCommand(t.Context(), "unsupported", address); err == nil {
		t.Fatal("unsupported platform silently accepted")
	}
}
